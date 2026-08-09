const ZOOVOICE_CONFIG_PATH = "/api/zoovoice/config";
const ZOOVOICE_ANIMALS_PATH = "/api/zoovoice/animals";
const ZOOVOICE_COMPOSE_PATH = "/api/zoovoice/compose";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_AUDIO_MAX_BYTES = 10_000_000;
const DEFAULT_SETTINGS_MAX_BYTES = 64 * 1024;
const DEFAULT_RESPONSE_MAX_BYTES = 8_000_000;
const DEFAULT_ORIGIN_TIMEOUT_MS = 90_000;
const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_MONTHLY_LIMIT = 1_200;
const ID_TOKEN_REFRESH_SECONDS = 300;
const zoovoiceIdTokenCache = new Map();

class ZoovoiceGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ZoovoiceGatewayError";
    this.status = status;
    this.code = code;
  }
}

export async function handleZoovoiceApiRequest(request, env, url = new URL(request.url)) {
  const path = url.pathname;
  if (![ZOOVOICE_CONFIG_PATH, ZOOVOICE_ANIMALS_PATH, ZOOVOICE_COMPOSE_PATH].includes(path)) {
    return null;
  }
  try {
    if (request.method === "GET" && path === ZOOVOICE_CONFIG_PATH) {
      return gatewayJson(publicZoovoiceConfig(env));
    }
    requireZoovoiceEnabled(env);
    if (request.method === "GET" && path === ZOOVOICE_ANIMALS_PATH) {
      return await proxyAnimals(request, env);
    }
    if (request.method === "POST" && path === ZOOVOICE_COMPOSE_PATH) {
      return await proxyCompose(request, env);
    }
    throw new ZoovoiceGatewayError(405, "zoovoice_method_not_allowed", "この操作には対応していません。");
  } catch (error) {
    const gatewayError = normalizeGatewayError(error);
    logZoovoiceGateway(env, {
      request_id: request.headers.get("cf-ray") || crypto.randomUUID(),
      path,
      status: gatewayError.status,
      result: gatewayError.code,
    });
    return gatewayJson({
      error: {
        code: gatewayError.code,
        message: gatewayError.message,
      },
    }, { status: gatewayError.status });
  }
}

function publicZoovoiceConfig(env) {
  return {
    enabled: env.ZOOVOICE_ENABLED === "1",
    turnstile_required: true,
    turnstile_site_key: String(env.ZOOVOICE_TURNSTILE_SITE_KEY || ""),
    audio_max_bytes: zoovoiceAudioMaxBytes(env),
    origin_timeout_seconds: zoovoiceOriginTimeoutMs(env) / 1_000,
  };
}

function requireZoovoiceEnabled(env) {
  if (env.ZOOVOICE_ENABLED !== "1") {
    throw new ZoovoiceGatewayError(503, "zoovoice_disabled", "Zoovoiceは現在利用できません。");
  }
}

async function proxyAnimals(request, env) {
  if (!env.ASSETS) {
    throw new ZoovoiceGatewayError(503, "zoovoice_catalog_unavailable", "動物一覧を読み込めませんでした。");
  }
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/react/zoovoice-animals.json";
  let response;
  let payload;
  try {
    response = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
    payload = await response.json();
  } catch (_error) {
    throw new ZoovoiceGatewayError(503, "zoovoice_catalog_unavailable", "動物一覧を読み込めませんでした。");
  }
  if (!response.ok) {
    throw new ZoovoiceGatewayError(503, "zoovoice_catalog_unavailable", "動物一覧を読み込めませんでした。");
  }
  if (!Array.isArray(payload.animals) || payload.animals.length === 0) {
    throw new ZoovoiceGatewayError(503, "zoovoice_catalog_unavailable", "動物一覧を確認できませんでした。");
  }
  return gatewayJson(payload, {
    headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
  });
}

async function proxyCompose(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ZoovoiceGatewayError(400, "zoovoice_invalid_request", "音声ファイルと設定を確認してください。");
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > zoovoiceAudioMaxBytes(env) + DEFAULT_SETTINGS_MAX_BYTES + 128 * 1024) {
    throw audioTooLargeError();
  }

  let incoming;
  try {
    incoming = await request.formData();
  } catch (_error) {
    throw new ZoovoiceGatewayError(400, "zoovoice_invalid_request", "音声ファイルと設定を確認してください。");
  }
  const audio = incoming.get("audio");
  const settings = incoming.get("settings");
  const turnstileToken = incoming.get("turnstile_token");
  if (!isFileLike(audio) || typeof settings !== "string" || typeof turnstileToken !== "string") {
    throw new ZoovoiceGatewayError(400, "zoovoice_invalid_request", "音声ファイルと設定を確認してください。");
  }
  if (audio.size > zoovoiceAudioMaxBytes(env)) {
    throw audioTooLargeError();
  }
  if (new TextEncoder().encode(settings).byteLength > DEFAULT_SETTINGS_MAX_BYTES) {
    throw new ZoovoiceGatewayError(413, "zoovoice_settings_too_large", "設定が大きすぎます。");
  }
  validateComposeSettings(settings);
  await verifyTurnstile(request, env, turnstileToken);
  const originAccess = await resolveZoovoiceOriginAccess(request, env);
  await consumeZoovoiceBudget(env);

  const outgoing = new FormData();
  outgoing.append("audio", audio, String(audio.name || "recording.webm"));
  outgoing.append("settings", settings);
  const response = await fetchPrivateOrigin(request, env, "/compose", {
    method: "POST",
    body: outgoing,
  }, originAccess);
  const payload = await validatedOriginJson(response, env, "compose");
  if (response.ok && !isValidComposeResponse(payload)) {
    throw new ZoovoiceGatewayError(502, "zoovoice_invalid_origin_response", "合成結果を確認できませんでした。");
  }
  return gatewayJson(payload, { status: response.status });
}

function isFileLike(value) {
  return Boolean(value && typeof value === "object" && typeof value.size === "number" && typeof value.arrayBuffer === "function");
}

function validateComposeSettings(value) {
  try {
    const parsed = JSON.parse(value);
    if (
      !isPlainObject(parsed)
      || Object.keys(parsed).length !== 1
      || !Object.hasOwn(parsed, "intensity")
      || !Number.isInteger(parsed.intensity)
      || parsed.intensity < 0
      || parsed.intensity > 100
    ) {
      throw new Error("invalid intensity");
    }
  } catch (_error) {
    throw new ZoovoiceGatewayError(400, "zoovoice_invalid_settings", "アニマル度の設定を確認してください。");
  }
}

function isValidComposeResponse(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.audio) || !isPlainObject(payload.meta)) return false;
  if (
    payload.audio.format !== "wav"
    || !isBoundedString(payload.audio.base64, 1, DEFAULT_RESPONSE_MAX_BYTES)
  ) return false;

  const meta = payload.meta;
  if (
    !isBoundedString(meta.transcript, 1, 20_000)
    || !isPlainObject(meta.selected_animal)
    || !isBoundedIdentifier(meta.selected_animal.id, 80)
    || !isBoundedString(meta.selected_animal.label_ja, 1, 80)
    || !isBoundedString(meta.association_reason, 1, 400)
    || !Array.isArray(meta.insertions)
    || meta.insertions.length > 10
    || !isPositiveFiniteNumber(meta.input_duration_seconds)
    || !isPositiveFiniteNumber(meta.output_duration_seconds)
    || meta.output_duration_seconds < meta.input_duration_seconds
  ) return false;

  return meta.insertions.every((insertion) => (
    isPlainObject(insertion)
    && ["opening", "gaps", "ending"].includes(insertion.slot)
    && insertion.species === meta.selected_animal.id
    && isNonNegativeFiniteNumber(insertion.at_seconds)
  ));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function isBoundedIdentifier(value, maximum) {
  return isBoundedString(value, 1, maximum) && /^[a-z0-9_-]+$/.test(value);
}

function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function verifyTurnstile(request, env, token) {
  const secret = String(env.ZOOVOICE_TURNSTILE_SECRET_KEY || "");
  if (!secret) {
    throw new ZoovoiceGatewayError(503, "zoovoice_turnstile_unavailable", "不正利用防止の確認を開始できませんでした。");
  }
  if (!token || token.length > 2_048) {
    throw turnstileFailedError();
  }
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  body.append("idempotency_key", crypto.randomUUID());
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.append("remoteip", remoteIp);

  let response;
  try {
    response = await runtimeFetch(env)(TURNSTILE_VERIFY_URL, { method: "POST", body });
  } catch (_error) {
    throw new ZoovoiceGatewayError(503, "zoovoice_turnstile_unavailable", "不正利用防止の確認を完了できませんでした。");
  }
  let result;
  try {
    result = await response.json();
  } catch (_error) {
    throw new ZoovoiceGatewayError(503, "zoovoice_turnstile_unavailable", "不正利用防止の確認を完了できませんでした。");
  }
  const expectedHostname = String(env.ZOOVOICE_TURNSTILE_EXPECTED_HOSTNAME || new URL(request.url).hostname);
  const metadataMatches = isLocalTurnstileTest(request, env)
    || (result.action === "zoovoice-compose" && result.hostname === expectedHostname);
  if (!response.ok || result.success !== true || !metadataMatches) {
    throw turnstileFailedError();
  }
}

function isLocalTurnstileTest(request, env) {
  return isZoovoiceLocalRequest(request, env)
    && env.ZOOVOICE_TURNSTILE_SITE_KEY === "1x00000000000000000000AA"
    && env.ZOOVOICE_TURNSTILE_SECRET_KEY === "1x0000000000000000000000000000000AA";
}

function turnstileFailedError() {
  return new ZoovoiceGatewayError(403, "zoovoice_turnstile_failed", "不正利用防止の確認に失敗しました。もう一度お試しください。");
}

async function consumeZoovoiceBudget(env, now = new Date()) {
  if (!env.MO_SPEECH_DB) {
    throw new ZoovoiceGatewayError(503, "zoovoice_budget_unavailable", "利用上限を確認できませんでした。");
  }
  const usageDate = now.toISOString().slice(0, 10);
  const usageMonth = usageDate.slice(0, 7);
  const updatedAt = now.toISOString();
  const dailyLimit = boundedInteger(env.ZOOVOICE_DAILY_LIMIT, 1, 10_000, DEFAULT_DAILY_LIMIT);
  const monthlyLimit = boundedInteger(env.ZOOVOICE_MONTHLY_LIMIT, 1, 100_000, DEFAULT_MONTHLY_LIMIT);
  try {
    const row = await env.MO_SPEECH_DB.prepare(`
      INSERT INTO zoovoice_usage_counters (
        feature, usage_date, daily_count, usage_month, monthly_count, updated_at
      ) VALUES (?, ?, 1, ?, 1, ?)
      ON CONFLICT(feature) DO UPDATE SET
        usage_date = excluded.usage_date,
        daily_count = CASE
          WHEN zoovoice_usage_counters.usage_date = excluded.usage_date
            THEN zoovoice_usage_counters.daily_count + 1
          ELSE 1
        END,
        usage_month = excluded.usage_month,
        monthly_count = CASE
          WHEN zoovoice_usage_counters.usage_month = excluded.usage_month
            THEN zoovoice_usage_counters.monthly_count + 1
          ELSE 1
        END,
        updated_at = excluded.updated_at
      WHERE (
        CASE
          WHEN zoovoice_usage_counters.usage_date = excluded.usage_date
            THEN zoovoice_usage_counters.daily_count
          ELSE 0
        END
      ) < ?
      AND (
        CASE
          WHEN zoovoice_usage_counters.usage_month = excluded.usage_month
            THEN zoovoice_usage_counters.monthly_count
          ELSE 0
        END
      ) < ?
      RETURNING daily_count, monthly_count
    `).bind("zoovoice", usageDate, usageMonth, updatedAt, dailyLimit, monthlyLimit).first();
    if (!row) {
      throw new ZoovoiceGatewayError(429, "zoovoice_quota_exceeded", "本日の利用上限に達しました。");
    }
    return row;
  } catch (error) {
    if (error instanceof ZoovoiceGatewayError) throw error;
    throw new ZoovoiceGatewayError(503, "zoovoice_budget_unavailable", "利用上限を確認できませんでした。");
  }
}

async function resolveZoovoiceOriginAccess(request, env) {
  const mode = String(env.ZOOVOICE_ORIGIN_MODE || "");
  if (mode === "local-origin") {
    if (!isZoovoiceLocalRequest(request, env)) throw originAuthFailedError();
    let origin;
    try {
      origin = new URL(String(env.ZOOVOICE_LOCAL_ORIGIN || ""));
    } catch (_error) {
      throw originAuthFailedError();
    }
    if (
      origin.protocol !== "http:"
      || !isLoopbackHostname(origin.hostname)
      || origin.pathname !== "/"
      || origin.search
      || origin.hash
      || origin.username
      || origin.password
    ) {
      throw originAuthFailedError();
    }
    return { origin: origin.origin, token: null };
  }
  if (mode === "cloud-run-smoke") {
    if (!isZoovoiceLocalRequest(request, env)) throw originAuthFailedError();
    const origin = validatedCloudRunOrigin(env.ZOOVOICE_CLOUD_RUN_URL);
    const token = String(env.ZOOVOICE_GCP_ID_TOKEN || "");
    if (!token) throw originAuthFailedError();
    return { origin, token };
  }
  if (mode === "cloud-run") {
    if (env.ZOOVOICE_LOCAL_DEV === "1" || isLoopbackHostname(new URL(request.url).hostname)) {
      throw originAuthFailedError();
    }
    const origin = validatedCloudRunOrigin(env.ZOOVOICE_CLOUD_RUN_URL);
    try {
      return { origin, token: await productionCloudRunIdToken(env, origin) };
    } catch (_error) {
      throw originAuthFailedError();
    }
  }
  throw originAuthFailedError();
}

function isZoovoiceLocalRequest(request, env) {
  return env.ZOOVOICE_LOCAL_DEV === "1"
    && isLoopbackHostname(new URL(request.url).hostname);
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function originAuthFailedError() {
  return new ZoovoiceGatewayError(502, "zoovoice_origin_auth_failed", "音声合成サービスへ安全に接続できませんでした。");
}

async function fetchPrivateOrigin(request, env, path, init, access = null) {
  const { origin, token } = access || await resolveZoovoiceOriginAccess(request, env);
  const headers = new Headers(init.headers || {});
  if (typeof token === "string" && token.length > 0) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  headers.set("Accept", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("origin timeout"), zoovoiceOriginTimeoutMs(env));
  const abortFromClient = () => controller.abort("client disconnected");
  request.signal?.addEventListener?.("abort", abortFromClient, { once: true });
  const started = Date.now();
  try {
    const response = await runtimeFetch(env)(`${origin}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    logZoovoiceGateway(env, {
      request_id: request.headers.get("cf-ray") || "",
      path,
      status: response.status,
      result: response.ok ? "origin_complete" : "origin_rejected",
      elapsed_ms: Date.now() - started,
    });
    return response;
  } catch (_error) {
    if (controller.signal.aborted) {
      throw new ZoovoiceGatewayError(504, "zoovoice_origin_timeout", "音声合成が時間内に完了しませんでした。");
    }
    throw new ZoovoiceGatewayError(502, "zoovoice_backend_unavailable", "音声合成サービスに接続できませんでした。");
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener?.("abort", abortFromClient);
  }
}

function validatedCloudRunOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    throw originAuthFailedError();
  }
  if (
    url.protocol !== "https:"
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
    || !url.hostname.endsWith(".run.app")
  ) {
    throw originAuthFailedError();
  }
  return url.origin;
}

async function productionCloudRunIdToken(env, origin) {
  const serviceAccount = parseZoovoiceServiceAccount(env.ZOOVOICE_GCP_SA_KEY);
  const nowSeconds = Math.floor(runtimeNow(env) / 1_000);
  const cacheKey = `${origin}\n${serviceAccount.client_email}`;
  const cached = zoovoiceIdTokenCache.get(cacheKey);
  if (cached && nowSeconds < cached.expiresAtSeconds - ID_TOKEN_REFRESH_SECONDS) {
    return cached.token;
  }

  const assertion = await signedServiceAccountJwt(serviceAccount, origin, nowSeconds);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await runtimeFetch(env)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error("token exchange failed");

  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    throw new Error("token response invalid");
  }
  if (!isPlainObject(payload) || typeof payload.id_token !== "string") {
    throw new Error("token response invalid");
  }
  const expiresAtSeconds = idTokenExpiry(payload.id_token);
  zoovoiceIdTokenCache.set(cacheKey, { token: payload.id_token, expiresAtSeconds });
  return payload.id_token;
}

function parseZoovoiceServiceAccount(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch (_error) {
    throw new Error("service account invalid");
  }
  if (
    !isPlainObject(parsed)
    || !isBoundedString(parsed.client_email, 1, 320)
    || !isBoundedString(parsed.private_key, 1, 32_000)
  ) {
    throw new Error("service account invalid");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

async function signedServiceAccountJwt(serviceAccount, origin, nowSeconds) {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const issuedAt = nowSeconds - 60;
  const payload = base64UrlJson({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: GOOGLE_TOKEN_URL,
    target_audience: origin,
    iat: issuedAt,
    exp: issuedAt + 3_600,
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemPrivateKeyBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemPrivateKeyBytes(value) {
  const encoded = String(value)
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  if (!encoded) throw new Error("private key invalid");
  let binary;
  try {
    binary = atob(encoded);
  } catch (_error) {
    throw new Error("private key invalid");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function idTokenExpiry(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("id token invalid");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch (_error) {
    throw new Error("id token invalid");
  }
  if (!isPlainObject(payload) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("id token invalid");
  }
  return payload.exp;
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function clearZoovoiceIdTokenCacheForTests() {
  zoovoiceIdTokenCache.clear();
}

async function validatedOriginJson(response, env, kind) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > zoovoiceResponseMaxBytes(env)) {
    throw new ZoovoiceGatewayError(502, "zoovoice_invalid_origin_response", "音声合成サービスの応答が大きすぎます。");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > zoovoiceResponseMaxBytes(env)) {
    throw new ZoovoiceGatewayError(502, "zoovoice_invalid_origin_response", "音声合成サービスの応答が大きすぎます。");
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_error) {
    throw new ZoovoiceGatewayError(502, "zoovoice_invalid_origin_response", "音声合成サービスの応答を確認できませんでした。");
  }
  if (!response.ok) {
    const code = String(payload?.error?.code || "zoovoice_origin_rejected").slice(0, 80);
    const fallback = kind === "animals" ? "動物一覧を読み込めませんでした。" : "音声を合成できませんでした。";
    const message = String(payload?.error?.message || fallback).slice(0, 300);
    throw new ZoovoiceGatewayError(response.status, code, message);
  }
  return payload;
}

function zoovoiceAudioMaxBytes(env) {
  return boundedInteger(env.ZOOVOICE_AUDIO_MAX_BYTES, 1, DEFAULT_AUDIO_MAX_BYTES, DEFAULT_AUDIO_MAX_BYTES);
}

function zoovoiceResponseMaxBytes(env) {
  return boundedInteger(env.ZOOVOICE_RESPONSE_MAX_BYTES, 1_024, 20_000_000, DEFAULT_RESPONSE_MAX_BYTES);
}

function zoovoiceOriginTimeoutMs(env) {
  return boundedInteger(env.ZOOVOICE_ORIGIN_TIMEOUT_MS, 1, DEFAULT_ORIGIN_TIMEOUT_MS, DEFAULT_ORIGIN_TIMEOUT_MS);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function audioTooLargeError() {
  return new ZoovoiceGatewayError(413, "zoovoice_audio_too_large", "音声ファイルは10MB以下にしてください。");
}

function normalizeGatewayError(error) {
  if (error instanceof ZoovoiceGatewayError) return error;
  return new ZoovoiceGatewayError(500, "zoovoice_gateway_error", "Zoovoiceの処理を完了できませんでした。");
}

function logZoovoiceGateway(env, event) {
  const status = Number(event.status || 0);
  const sampleRate = Number(env.ZOOVOICE_LOG_SAMPLE_RATE ?? 0.05);
  if (status < 400 && (sampleRate <= 0 || Math.random() >= Math.min(1, sampleRate))) return;
  console.log("zoovoice_gateway", JSON.stringify({
    request_id: String(event.request_id || "").slice(0, 128),
    path: String(event.path || "").slice(0, 80),
    status,
    result: String(event.result || "").slice(0, 80),
    elapsed_ms: Number(event.elapsed_ms || 0),
  }));
}

function runtimeFetch(env) {
  return env.__fetch || fetch;
}

function runtimeNow(env) {
  const value = typeof env.__ZOOVOICE_NOW === "function" ? env.__ZOOVOICE_NOW() : Date.now();
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("current time invalid");
  return value;
}

function gatewayJson(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}
