import type { Arrangement } from "./state";

export type Animal = {
  id: string;
  label_ja: string;
  variants: number;
};

export type ComposeResponse = {
  audio: {
    format: "wav";
    base64: string;
  };
  meta: {
    insertions: Array<{
      slot: "opening" | "gaps" | "ending";
      species: string;
      at_seconds: number;
    }>;
    input_duration_seconds: number;
    output_duration_seconds: number;
  };
};

type ErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

export async function fetchAnimals(signal?: AbortSignal): Promise<Animal[]> {
  const response = await fetch("/api/zoovoice/animals", { signal });
  const payload = await response.json() as { animals?: Animal[] } & ErrorEnvelope;
  if (!response.ok) throw new Error(errorMessage(payload, "動物を読み込めませんでした。"));
  if (!Array.isArray(payload.animals) || payload.animals.length === 0) {
    throw new Error("利用できる動物音源がありません。");
  }
  return payload.animals;
}

export async function composeRecording(
  recording: Blob,
  arrangement: Arrangement,
  intensity: number,
): Promise<ComposeResponse> {
  const form = new FormData();
  form.append("audio", recording, recordingFilename(recording.type));
  form.append("settings", JSON.stringify({ arrangement, intensity }));
  const response = await fetch("/api/zoovoice/compose", {
    method: "POST",
    body: form,
  });
  const payload = await response.json() as ComposeResponse & ErrorEnvelope;
  if (!response.ok) throw new Error(errorMessage(payload, "音声を合成できませんでした。"));
  if (payload.audio?.format !== "wav" || !payload.audio.base64) {
    throw new Error("合成結果の音声を確認できませんでした。");
  }
  return payload;
}

export function wavBlobFromBase64(value: string): Blob {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function errorMessage(payload: ErrorEnvelope, fallback: string): string {
  return payload.error?.message || fallback;
}

function recordingFilename(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}
