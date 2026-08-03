export type ZoovoicePhase =
  | "loading"
  | "idle"
  | "recording"
  | "recorded"
  | "processing"
  | "success"
  | "fallback"
  | "error";

export type ZoovoiceState = {
  phase: ZoovoicePhase;
  message: string;
};

export type ZoovoiceAction =
  | { type: "config_loaded" }
  | { type: "recording_started" }
  | { type: "recording_stopped"; turnstileRequired: boolean }
  | { type: "compose_started" }
  | { type: "compose_succeeded"; fallback: boolean }
  | { type: "failed"; message: string };

export const initialZoovoiceState: ZoovoiceState = {
  phase: "loading",
  message: "準備しています。",
};

export function zoovoiceReducer(
  _state: ZoovoiceState,
  action: ZoovoiceAction,
): ZoovoiceState {
  switch (action.type) {
    case "config_loaded":
      return { phase: "idle", message: "" };
    case "recording_started":
      return { phase: "recording", message: "" };
    case "recording_stopped":
      return {
        phase: "recorded",
        message: action.turnstileRequired
          ? "録音できました。不正利用防止の確認後に生成できます。"
          : "録音できました。生成できます。",
      };
    case "compose_started":
      return { phase: "processing", message: "声を聞き取り、動物を連想して合成しています。" };
    case "compose_succeeded":
      return action.fallback
        ? { phase: "fallback", message: "関連する動物が見つからなかったため、ランダムに選びました。" }
        : { phase: "success", message: "できあがりました。再生して確認できます。" };
    case "failed":
      return { phase: "error", message: action.message };
  }
}
