/**
 * credit-base（共通課金基盤）の内部APIを呼ぶ薄い層。
 *
 * 経路は2つある。本番は Service Binding のRPC、ローカル開発とテストは shared secret 付きのHTTP。
 * どちらを選んでも呼び出し側から見える形は同じにする。
 *
 * 経路選択で CREDIT_BASE_URL を先に見るのは、`wrangler dev` が wrangler.toml の
 * [[services]] 宣言を、相手のWorkerが起動していなくても stub として env へ載せるため。
 * RPCを先に見るとローカル検証が常にその stub を掴んでしまい、HTTP経路へ到達できない。
 * 本番では CREDIT_BASE_URL を置かない（.dev.vars だけに書く）ので、RPCが選ばれる。
 */

/** 呼び出しの分類。呼び出し側はこれだけを見て分岐する */
export const CREDIT_ERROR_INVALID_REQUEST = "invalid_request";
export const CREDIT_ERROR_UNKNOWN = "unknown";

/** 接続手段が無い理由。監査ログの種別に使う */
export const CREDIT_UNAVAILABLE_NO_CLIENT = "no_client";
export const CREDIT_UNAVAILABLE_MISCONFIGURED = "misconfigured";

/**
 * env から使える経路を判定する。
 *
 * @returns {{client: object|null, reason: string}} client が null のとき reason に理由が入る
 */
export function resolveCreditClient(env = {}) {
  const baseUrl = String(env.CREDIT_BASE_URL || "").trim();
  const secret = String(env.CREDIT_BASE_SECRET || "").trim();

  if (baseUrl && secret) {
    return { client: httpCreditClient(env, baseUrl, secret), reason: "" };
  }
  if (baseUrl && !secret) {
    // Bearerを付けずに呼んでも credit-base は401を返すだけで、原因が分かりにくい。
    // 設定の誤りとして、意図的な未設定とは別の理由で落とす。
    return { client: null, reason: CREDIT_UNAVAILABLE_MISCONFIGURED };
  }
  if (env.CREDIT_BASE && typeof env.CREDIT_BASE === "object") {
    return { client: rpcCreditClient(env.CREDIT_BASE), reason: "" };
  }
  return { client: null, reason: CREDIT_UNAVAILABLE_NO_CLIENT };
}

/**
 * RPC（WorkerEntrypoint）経由。binding の宣言そのものが認可なので secret を渡さない。
 */
function rpcCreditClient(binding) {
  const call = async (method, payload) => {
    try {
      return normalizeCreditResult(await binding[method](payload));
    } catch (error) {
      throw taggedCreditError(error, creditErrorKindFromName(error));
    }
  };
  return {
    transport: "rpc",
    getBalance: (input) => call("getBalance", { subject_id: input.subjectId }),
    reserve: (input) => call("reserve", reserveBody(input)),
    settle: (input) => call("settle", settleBody(input)),
    release: (input) => call("release", releaseBody(input)),
  };
}

/**
 * HTTP経由。ローカル開発とテスト用。
 */
function httpCreditClient(env, baseUrl, secret) {
  const origin = baseUrl.replace(/\/+$/, "");
  const fetchImpl = env.__fetch || fetch;

  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw taggedCreditError(error, CREDIT_ERROR_UNKNOWN);
    }
    const payload = await response.json().catch(() => null);
    if (payload === null || typeof payload !== "object") {
      throw taggedCreditError(new Error("credit-base returned a non-JSON body"), CREDIT_ERROR_UNKNOWN);
    }
    if (response.status === 400) {
      // HTTPでは入力検証エラーがステータスで分かる。RPCの error.name と同じ分類へ寄せる
      throw taggedCreditError(
        new Error(String(payload.message || payload.error || "invalid credit request")),
        CREDIT_ERROR_INVALID_REQUEST,
      );
    }
    if (typeof payload.status !== "string") {
      throw taggedCreditError(
        new Error(`credit-base returned HTTP ${response.status} without a status`),
        CREDIT_ERROR_UNKNOWN,
      );
    }
    return normalizeCreditResult(payload);
  };

  return {
    transport: "http",
    getBalance: (input) =>
      call("GET", `/internal/balance?subject_id=${encodeURIComponent(String(input.subjectId ?? ""))}`),
    reserve: (input) => call("POST", "/internal/reserve", reserveBody(input)),
    settle: (input) => call("POST", "/internal/settle", settleBody(input)),
    release: (input) => call("POST", "/internal/release", releaseBody(input)),
  };
}

function reserveBody(input) {
  const body = {
    subject_id: input.subjectId,
    amount: input.amount,
    product: input.product,
    feature: input.feature,
    idempotency_key: input.idempotencyKey,
  };
  if (input.callbackUrl) body.callback_url = input.callbackUrl;
  if (input.ttlSeconds) body.ttl_seconds = input.ttlSeconds;
  return body;
}

function settleBody(input) {
  return {
    reserve_key: input.reserveKey,
    actual_amount: input.actualAmount,
    idempotency_key: input.idempotencyKey,
  };
}

function releaseBody(input) {
  return {
    reserve_key: input.reserveKey,
    idempotency_key: input.idempotencyKey,
  };
}

/**
 * 戻り値のキーを内部表現へ揃える。
 *
 * credit-base はRPC化に合わせて出力キーをsnake_caseへ統一する予定だが、それが入るまで
 * HTTP経路はcamelCaseを返す。両方を受けて呼び出し側を移行の順序から切り離す。
 */
export function normalizeCreditResult(raw) {
  if (raw === null || typeof raw !== "object") {
    throw taggedCreditError(new Error("credit-base returned an unexpected result"), CREDIT_ERROR_UNKNOWN);
  }
  const pick = (snake, camel) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const result = {
    status: typeof raw.status === "string" ? raw.status : "",
    subjectId: pick("subject_id", "subjectId"),
    balance: pick("balance", "balance"),
    reservedAmount: pick("reserved_amount", "reservedAmount"),
    billed: pick("billed", "billed"),
    released: pick("released", "released"),
    unbilledOverage: pick("unbilled_overage", "unbilledOverage"),
    settledAt: pick("settled_at", "settledAt"),
    idempotencyKey: pick("idempotency_key", "idempotencyKey"),
    message: pick("message", "message"),
  };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

/**
 * 例外へ分類を付ける。
 *
 * RPC境界では instanceof が落ちるが error.name は残る（2026-09-03に実測。公式文書の裏付けは未確認）。
 * 名前を読み違えても壊れないよう、この分類は再試行の要否とログ種別にしか使わない。
 * 記帳の決着は対応表とcronの照会経路が引き受ける。
 */
function creditErrorKindFromName(error) {
  return error?.name === "ValidationError" ? CREDIT_ERROR_INVALID_REQUEST : CREDIT_ERROR_UNKNOWN;
}

function taggedCreditError(error, kind) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.creditKind = kind;
  return tagged;
}
