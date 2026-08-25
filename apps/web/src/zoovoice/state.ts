export type ZoovoicePhase =
  | "loading"
  | "idle"
  | "starting"
  | "recording"
  | "finalizing"
  | "verifying"
  | "processing"
  | "success"
  | "fallback"
  | "error";

export type ZoovoiceErrorKind =
  | "none"
  | "compose_retryable"
  | "compose_terminal"
  | "verify_timeout"
  | "mic_denied"
  | "setup_failed";

export type ZoovoiceState = {
  phase: ZoovoicePhase;
  // 表示言語を切り替えても同じstateで正しい文が出るよう、文言ではなく辞書キーを持つ。
  messageKey: string;
  // gateway / origin が返した文。翻訳できないので、あるときはキーより優先して出す。
  serverText?: string;
  errorKind: ZoovoiceErrorKind;
};

export type ZoovoiceAction =
  | { type: "config_loaded" }
  | { type: "recording_starting" }
  | { type: "recording_started" }
  | { type: "recording_stopping" }
  | { type: "recording_cancelled" }
  | { type: "recording_too_short" }
  | { type: "verification_waiting" }
  | { type: "compose_started" }
  | { type: "compose_succeeded"; fallback: boolean }
  | { type: "failed"; kind: Exclude<ZoovoiceErrorKind, "none">; messageKey: string; serverText?: string };

export const initialZoovoiceState: ZoovoiceState = {
  phase: "loading",
  messageKey: "zoovoice.status.preparing",
  errorKind: "none",
};

export function zoovoiceReducer(
  _state: ZoovoiceState,
  action: ZoovoiceAction,
): ZoovoiceState {
  switch (action.type) {
    case "config_loaded":
      return state("idle", "");
    case "recording_starting":
      return state("starting", "zoovoice.status.micPreparing");
    case "recording_started":
      return state("recording", "");
    case "recording_stopping":
      return state("finalizing", "zoovoice.status.checkingRecording");
    case "recording_cancelled":
      return state("idle", "zoovoice.status.cancelled");
    case "recording_too_short":
      return state("idle", "zoovoice.status.tooShort");
    case "verification_waiting":
      return state("verifying", "zoovoice.status.verifying");
    case "compose_started":
      return state("processing", "zoovoice.status.composing");
    case "compose_succeeded":
      return action.fallback
        ? state("fallback", "zoovoice.status.fallback")
        : state("success", "zoovoice.status.success");
    case "failed":
      // serverTextが無いときはキーを持たせない。stateの形が素直になり、比較も素直になる。
      return action.serverText
        ? { phase: "error", messageKey: action.messageKey, serverText: action.serverText, errorKind: action.kind }
        : { phase: "error", messageKey: action.messageKey, errorKind: action.kind };
  }
}

export function controlsForZoovoiceState(
  current: ZoovoiceState,
  context: { configEnabled: boolean; hasRecording: boolean },
): { orbEnabled: boolean; sliderEnabled: boolean; retryVisible: boolean } {
  const settled = ["idle", "success", "fallback", "error"].includes(current.phase);
  const setupFailed = current.errorKind === "setup_failed";
  const controlsEnabled = context.configEnabled && settled && !setupFailed;
  const retryableError = current.errorKind === "compose_retryable" || current.errorKind === "verify_timeout";
  return {
    orbEnabled: current.phase === "recording" ? context.configEnabled : controlsEnabled,
    sliderEnabled: controlsEnabled,
    retryVisible: current.phase === "error" && context.hasRecording && retryableError,
  };
}

export function isTurnstileTokenFresh(token: string, issuedAt: number, now = Date.now()): boolean {
  return Boolean(token) && issuedAt > 0 && now - issuedAt < 240_000;
}

export function isComposeReady(
  turnstileRequired: boolean,
  token: string,
  issuedAt: number,
  now = Date.now(),
): boolean {
  return !turnstileRequired || isTurnstileTokenFresh(token, issuedAt, now);
}

function state(phase: ZoovoicePhase, messageKey: string): ZoovoiceState {
  return { phase, messageKey, errorKind: "none" };
}

// reducerが返し得るキーの一覧。辞書側の取りこぼし(生キーが画面に出る)をテストで塞ぐために公開する。
export const zoovoiceStatusMessageKeys = [
  "zoovoice.status.preparing",
  "zoovoice.status.micPreparing",
  "zoovoice.status.checkingRecording",
  "zoovoice.status.cancelled",
  "zoovoice.status.tooShort",
  "zoovoice.status.verifying",
  "zoovoice.status.composing",
  "zoovoice.status.fallback",
  "zoovoice.status.success",
] as const;
