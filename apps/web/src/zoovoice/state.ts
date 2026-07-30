export type ZoovoicePhase =
  | "loading"
  | "idle"
  | "recording"
  | "recorded"
  | "processing"
  | "success"
  | "error";

export type ZoovoiceState = {
  phase: ZoovoicePhase;
  message: string;
};

export type ZoovoiceAction =
  | { type: "animals_loaded" }
  | { type: "recording_started" }
  | { type: "recording_stopped" }
  | { type: "compose_started" }
  | { type: "compose_succeeded" }
  | { type: "failed"; message: string };

export type ArrangementValue = string | "lucky" | null;

export type Arrangement = {
  opening: ArrangementValue;
  gaps: ArrangementValue;
  ending: ArrangementValue;
};

export const initialZoovoiceState: ZoovoiceState = {
  phase: "loading",
  message: "動物を読み込んでいます。",
};

export function zoovoiceReducer(
  _state: ZoovoiceState,
  action: ZoovoiceAction,
): ZoovoiceState {
  switch (action.type) {
    case "animals_loaded":
      return { phase: "idle", message: "" };
    case "recording_started":
      return { phase: "recording", message: "" };
    case "recording_stopped":
      return { phase: "recorded", message: "録音できました。動物とアニマル度を確認してください。" };
    case "compose_started":
      return { phase: "processing", message: "声のすき間へ動物たちを呼んでいます。" };
    case "compose_succeeded":
      return { phase: "success", message: "できあがりました。再生して確認できます。" };
    case "failed":
      return { phase: "error", message: action.message };
  }
}

export function singleAnimalArrangement(species: string): Arrangement {
  return { opening: species, gaps: species, ending: species };
}

export function luckyArrangement(): Arrangement {
  return { opening: "lucky", gaps: "lucky", ending: "lucky" };
}
