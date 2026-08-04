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
  message: string;
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
  | { type: "failed"; kind: Exclude<ZoovoiceErrorKind, "none">; message: string };

export const initialZoovoiceState: ZoovoiceState = {
  phase: "loading",
  message: "準備しています。",
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
      return state("starting", "マイクを準備しています。");
    case "recording_started":
      return state("recording", "");
    case "recording_stopping":
      return state("finalizing", "録音を確認しています。");
    case "recording_cancelled":
      return state("idle", "録音をキャンセルしました。音声は送信していません。");
    case "recording_too_short":
      return state("idle", "録音が短すぎました。0.5秒以上話してください。");
    case "verification_waiting":
      return state("verifying", "不正利用防止の確認を待っています。");
    case "compose_started":
      return state("processing", "声を聞き取り、動物を連想して合成しています。");
    case "compose_succeeded":
      return action.fallback
        ? state("fallback", "関連する動物が見つからなかったため、ランダムに選びました。")
        : state("success", "できあがりました。自動再生を開始します。");
    case "failed":
      return { phase: "error", message: action.message, errorKind: action.kind };
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

function state(phase: ZoovoicePhase, message: string): ZoovoiceState {
  return { phase, message, errorKind: "none" };
}
