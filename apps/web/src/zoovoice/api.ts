export type ComposeResponse = {
  audio: {
    format: "wav";
    base64: string;
  };
  meta: {
    transcript: string;
    // selected_animal と association_reason は1種目。1種だけ選んだ場合と同じ値になる。
    selected_animal: {
      id: string;
      label_ja: string;
    };
    selected_animals: AssociatedAnimal[];
    association_reason: string;
    insertions: Array<{
      slot: "word" | "ending";
      species: string;
      at_seconds: number;
      duration_seconds: number;
    }>;
    sound_credits?: SoundCredit[];
    input_duration_seconds: number;
    output_duration_seconds: number;
  };
};

// 2種を選んでもアニマル度0や短い録音では末尾の1本だけになり、鳴るのは1種目だけになる。
// 画面には連想した動物ではなく実際に差し込んだ動物を出す。
export function insertedAnimals(meta: ComposeResponse["meta"]): AssociatedAnimal[] {
  const inserted = new Set(meta.insertions.map((insertion) => insertion.species));
  const animals = meta.selected_animals.filter((animal) => inserted.has(animal.id));
  return animals.length > 0 ? animals : meta.selected_animals;
}

// 表示言語ごとの名前は画面側で解決するので、ラベルだけが要る呼び出し向けの薄い包み。
export function insertedAnimalLabels(meta: ComposeResponse["meta"]): string[] {
  return insertedAnimals(meta).map((animal) => animal.label_ja);
}

// 連想した動物。1種のときも配列で返るので、画面側は件数で分岐しなくてよい。
export type AssociatedAnimal = {
  id: string;
  label_ja: string;
  reason: string;
};

// 鳴き声素材の出典表示。CC BY素材では表示が利用条件になるため、必ず画面へ出す。
export type SoundCredit = {
  license: string;
  creator?: string;
  source_url?: string;
};

export type ZoovoiceConfig = {
  enabled: boolean;
  turnstile_required: boolean;
  turnstile_site_key: string;
  audio_max_bytes: number;
  origin_timeout_seconds: number;
};

type ErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

// 同じ録音を送り直せば直り得るものだけを載せる。
// association_unavailable は連想APIの一時的な失敗（接続不可・混雑・上流障害）で、
// 録音を取り直さずに再試行できる。恒久的な association_failed は載せない。
const retryableErrorCodes = new Set([
  "association_unavailable",
  "zoovoice_backend_unavailable",
  "zoovoice_gateway_error",
  "zoovoice_http_unavailable",
  "zoovoice_network_error",
  "zoovoice_origin_timeout",
]);

export class ZoovoiceApiError extends Error {
  readonly code: string;
  readonly status: number;
  // 表示は messageKey を翻訳して出す。serverMessage は gateway / origin が返した文で、
  // 翻訳できないため英語表示でもそのまま出す。
  readonly messageKey: string;
  readonly serverMessage: string;

  constructor(code: string, status: number, messageKey: string, serverMessage = "") {
    super(serverMessage || messageKey);
    this.name = "ZoovoiceApiError";
    this.code = code;
    this.status = status;
    this.messageKey = messageKey;
    this.serverMessage = serverMessage;
  }
}

export function isRetryableZoovoiceError(error: unknown): boolean {
  return error instanceof ZoovoiceApiError && retryableErrorCodes.has(error.code);
}

export async function fetchZoovoiceConfig(signal?: AbortSignal): Promise<ZoovoiceConfig> {
  const response = await fetchResponse("/api/zoovoice/config", { signal });
  const payload = await responsePayload<Partial<ZoovoiceConfig> & ErrorEnvelope>(
    response,
    "zoovoice.api.configLoadFailed",
  );
  if (!response.ok) throw apiError(response, payload, "zoovoice.api.configLoadFailed");
  if (
    typeof payload.enabled !== "boolean"
    || typeof payload.turnstile_required !== "boolean"
    || typeof payload.turnstile_site_key !== "string"
    || typeof payload.audio_max_bytes !== "number"
    || typeof payload.origin_timeout_seconds !== "number"
  ) {
    throw new ZoovoiceApiError(
      "zoovoice_invalid_response",
      response.status,
      "zoovoice.api.configVerifyFailed",
    );
  }
  return payload as ZoovoiceConfig;
}

export async function composeRecording(
  recording: Blob,
  intensity: number,
  animalCount: number,
  turnstileToken = "",
): Promise<ComposeResponse> {
  const form = new FormData();
  form.append("audio", recording, recordingFilename(recording.type));
  form.append("settings", JSON.stringify({ intensity, animal_count: animalCount }));
  if (turnstileToken) form.append("turnstile_token", turnstileToken);
  const response = await fetchResponse("/api/zoovoice/compose", {
    method: "POST",
    body: form,
  });
  const payload = await responsePayload<ComposeResponse & ErrorEnvelope>(
    response,
    "zoovoice.api.composeFailed",
  );
  if (!response.ok) throw apiError(response, payload, "zoovoice.api.composeFailed");
  if (
    payload.audio?.format !== "wav"
    || !payload.audio.base64
    || !payload.meta?.transcript
    || !payload.meta.selected_animal?.id
    || !Array.isArray(payload.meta.selected_animals)
    || payload.meta.selected_animals.length === 0
  ) {
    throw new ZoovoiceApiError(
      "zoovoice_invalid_response",
      response.status,
      "zoovoice.api.resultVerifyFailed",
    );
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

function recordingFilename(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

async function fetchResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ZoovoiceApiError(
      "zoovoice_network_error",
      0,
      "zoovoice.api.networkFailed",
    );
  }
}

async function responsePayload<T extends ErrorEnvelope>(response: Response, fallbackKey: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok && response.status >= 500) {
      throw new ZoovoiceApiError("zoovoice_http_unavailable", response.status, fallbackKey);
    }
    throw new ZoovoiceApiError("zoovoice_invalid_response", response.status, fallbackKey);
  }
}

function apiError(response: Response, payload: ErrorEnvelope, fallbackKey: string): ZoovoiceApiError {
  return new ZoovoiceApiError(
    payload.error?.code || "zoovoice_unknown_error",
    response.status,
    fallbackKey,
    payload.error?.message || "",
  );
}
