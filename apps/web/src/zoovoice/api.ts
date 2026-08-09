export type ComposeResponse = {
  audio: {
    format: "wav";
    base64: string;
  };
  meta: {
    transcript: string;
    selected_animal: {
      id: string;
      label_ja: string;
    };
    association_reason: string;
    insertions: Array<{
      slot: "opening" | "gaps" | "ending";
      species: string;
      at_seconds: number;
    }>;
    input_duration_seconds: number;
    output_duration_seconds: number;
  };
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

const retryableErrorCodes = new Set([
  "zoovoice_backend_unavailable",
  "zoovoice_gateway_error",
  "zoovoice_http_unavailable",
  "zoovoice_network_error",
  "zoovoice_origin_timeout",
]);

export class ZoovoiceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ZoovoiceApiError";
    this.code = code;
    this.status = status;
  }
}

export function isRetryableZoovoiceError(error: unknown): boolean {
  return error instanceof ZoovoiceApiError && retryableErrorCodes.has(error.code);
}

export async function fetchZoovoiceConfig(signal?: AbortSignal): Promise<ZoovoiceConfig> {
  const response = await fetchResponse("/api/zoovoice/config", { signal });
  const payload = await responsePayload<Partial<ZoovoiceConfig> & ErrorEnvelope>(
    response,
    "Zoovoiceの設定を読み込めませんでした。",
  );
  if (!response.ok) throw apiError(response, payload, "Zoovoiceの設定を読み込めませんでした。");
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
      "Zoovoiceの設定を確認できませんでした。",
    );
  }
  return payload as ZoovoiceConfig;
}

export async function composeRecording(
  recording: Blob,
  intensity: number,
  turnstileToken = "",
): Promise<ComposeResponse> {
  const form = new FormData();
  form.append("audio", recording, recordingFilename(recording.type));
  form.append("settings", JSON.stringify({ intensity }));
  if (turnstileToken) form.append("turnstile_token", turnstileToken);
  const response = await fetchResponse("/api/zoovoice/compose", {
    method: "POST",
    body: form,
  });
  const payload = await responsePayload<ComposeResponse & ErrorEnvelope>(
    response,
    "音声を生成できませんでした。",
  );
  if (!response.ok) throw apiError(response, payload, "音声を生成できませんでした。");
  if (
    payload.audio?.format !== "wav"
    || !payload.audio.base64
    || !payload.meta?.transcript
    || !payload.meta.selected_animal?.id
  ) {
    throw new ZoovoiceApiError(
      "zoovoice_invalid_response",
      response.status,
      "生成結果を確認できませんでした。",
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
      "ネットワークに接続できませんでした。接続を確認してもう一度お試しください。",
    );
  }
}

async function responsePayload<T extends ErrorEnvelope>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok && response.status >= 500) {
      throw new ZoovoiceApiError("zoovoice_http_unavailable", response.status, fallback);
    }
    throw new ZoovoiceApiError("zoovoice_invalid_response", response.status, fallback);
  }
}

function apiError(response: Response, payload: ErrorEnvelope, fallback: string): ZoovoiceApiError {
  return new ZoovoiceApiError(
    payload.error?.code || "zoovoice_unknown_error",
    response.status,
    payload.error?.message || fallback,
  );
}
