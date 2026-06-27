const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
const RUNPOD_TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const RUNPOD_RUNNING_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "RUNNING"]);

const DEFAULT_USER_SETTINGS = {
  target_language: "ja-JP",
  joke_text: "",
  joke_texts: [],
  joke_position: "after",
  joke_selection: "rotation",
  joke_variation_count: 0,
  joke_variants: [],
  joke_pool: [],
  theme: "blue",
};

let ephemeralUserSettings = null;

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return handleApiRequest(request, env, ctx, url);
  }
  return serveAsset(request, env, url);
}

async function handleApiRequest(request, env, ctx, url) {
  try {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/api/runtime") {
      return jsonResponse(await runtimePayload(env));
    }
    if (request.method === "GET" && url.pathname === "/api/user-settings") {
      return jsonResponse(readUserSettings(env));
    }
    if (request.method === "PUT" && url.pathname === "/api/user-settings") {
      const payload = await request.json();
      ephemeralUserSettings = coerceUserSettings(payload);
      return jsonResponse(ephemeralUserSettings);
    }
    if (request.method === "POST" && url.pathname === "/api/user-display-text") {
      return jsonResponse(await createUserDisplayText(await request.json(), env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-text-output") {
      return jsonResponse(await createUserTextOutput(await request.json(), env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-joke-output") {
      return jsonResponse(await createUserJokeOutput(await request.json(), env));
    }
    if (request.method === "POST" && url.pathname === "/api/translate-speech-jobs") {
      return jsonResponse(await createTranslationJob(request, env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/translate-speech-jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "translation"));
    }
    if (request.method === "POST" && url.pathname === "/api/voice-conversion-jobs") {
      return jsonResponse(await createVoiceConversionJob(request, env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/voice-conversion-jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "voice_conversion"));
    }
    if (request.method === "POST" && url.pathname === "/api/warmup") {
      return jsonResponse(await createWarmupJob(env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/warmup/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "warmup"));
    }
    return jsonResponse({ detail: "not found" }, { status: 404 });
  } catch (error) {
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return new Response("Cloudflare static assets binding is not configured.", { status: 503 });
  }
  const assetUrl = new URL(request.url);
  if (url.pathname === "/") {
    assetUrl.pathname = "/user.html";
  } else if (url.pathname === "/admin") {
    assetUrl.pathname = "/index.html";
  } else if (url.pathname.startsWith("/static/")) {
    assetUrl.pathname = `/${url.pathname.slice("/static/".length)}`;
  }
  return env.ASSETS.fetch(
    new Request(assetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
    }),
  );
}

async function runtimePayload(env) {
  const runpodAvailable = Boolean(env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY);
  const openaiAvailable = Boolean(env.OPENAI_API_KEY);
  const health = runpodAvailable && env.RUNPOD_RUNTIME_HEALTH_CHECK !== "0"
    ? await runpodHealthSummary(env)
    : { checked: false, warm: false, worker_counts: {} };
  return {
    provider_mode: "cloudflare",
    providers: {
      asr: "runpod-serverless-asr",
      translation: "runpod-serverless-translation",
      tts: "runpod-serverless-tts",
    },
    supported_voice_modes: ["default", "convert"],
    translation_backends: [
      {
        id: "runpod_serverless",
        label: "音声翻訳（RunPod Serverless）",
        available: runpodAvailable,
        reason: runpodAvailable ? "" : "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
        providers: {
          asr: "runpod-serverless-asr",
          translation: "runpod-serverless-translation",
          tts: "runpod-serverless-tts",
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_source_languages: ["auto", "id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_target_languages: ["id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_voice_modes: ["default", "convert"],
          text_transform: true,
          serverless: true,
          request_mode: "async",
          internal_translation_backend: env.RUNPOD_SERVERLESS_TRANSLATION_BACKEND || "openai",
          health,
        },
      },
      {
        id: "openai",
        label: "音声翻訳（OpenAI API）",
        available: false,
        reason: "Cloudflareデモでは音声翻訳をRunPod Serverless経由に固定します。",
        providers: {
          asr: "openai-asr",
          translation: "openai-translation",
          tts: "openai-tts",
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_voice_modes: ["default", "convert"],
          text_transform: true,
        },
      },
    ],
    text_tts_backends: [
      {
        id: "openai",
        label: "OpenAI TTS API",
        available: openaiAvailable,
        reason: openaiAvailable ? "" : "OPENAI_API_KEY が設定されていません。",
        provider: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
        settings: {
          supported_target_languages: ["auto", "id-ID", "ja-JP", "zh-CN", "en-US"],
          official_api: true,
        },
      },
    ],
    voice_conversion_backends: [
      {
        id: "seed-vc",
        label: "Seed-VC",
        provider: "RunPod Serverless Seed-VC",
        available: runpodAvailable,
        reason: runpodAvailable ? "" : "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
        settings: {
          seed_vc: {
            execution_mode: "resident",
            model_resident: health.warm || false,
            diffusion_steps: numberFromEnv(env.SEED_VC_DIFFUSION_STEPS, 8),
            reference_max_seconds: numberFromEnv(env.SEED_VC_REFERENCE_MAX_SECONDS, 12),
            reference_auto_select: true,
          },
        },
      },
    ],
  };
}

async function runpodHealthSummary(env) {
  try {
    const body = await runpodRequest(env, "/health", { method: "GET", timeoutMs: 3000 });
    const workerCounts = workerCountsFromHealth(body.workers);
    return {
      checked: true,
      warm: Object.entries(workerCounts).some(([state, count]) =>
        ["IDLE", "RUNNING", "READY", "INITIALIZED"].includes(state) && count > 0
      ),
      worker_counts: workerCounts,
    };
  } catch (error) {
    return {
      checked: true,
      warm: false,
      worker_counts: {},
      error: errorMessage(error),
    };
  }
}

function workerCountsFromHealth(workers) {
  const counts = {};
  if (Array.isArray(workers)) {
    for (const worker of workers) {
      const state = String(worker?.state || worker?.status || "UNKNOWN").toUpperCase();
      counts[state] = (counts[state] || 0) + 1;
    }
    return counts;
  }
  if (workers && typeof workers === "object") {
    for (const [key, value] of Object.entries(workers)) {
      if (typeof value === "number") {
        counts[String(key).toUpperCase()] = value;
      }
    }
  }
  return counts;
}

function readUserSettings(env) {
  if (ephemeralUserSettings) {
    return ephemeralUserSettings;
  }
  if (env.USER_SETTINGS_JSON) {
    try {
      return coerceUserSettings(JSON.parse(env.USER_SETTINGS_JSON));
    } catch (_error) {
      return DEFAULT_USER_SETTINGS;
    }
  }
  return DEFAULT_USER_SETTINGS;
}

function coerceUserSettings(payload = {}) {
  const jokeTexts = coerceTextList(payload.joke_texts ?? payload.joke_text);
  const jokeVariants = coerceTextList(payload.joke_variants);
  return {
    target_language: supportedValue(payload.target_language, ["ja-JP", "id-ID", "zh-CN", "en-US"], "ja-JP"),
    joke_text: jokeTexts.join("\n"),
    joke_texts: jokeTexts,
    joke_position: supportedValue(payload.joke_position, ["before", "after"], "after"),
    joke_selection: supportedValue(payload.joke_selection, ["rotation", "random"], "rotation"),
    joke_variation_count: clampInt(payload.joke_variation_count, 0, 5, 0),
    joke_variants: jokeVariants,
    joke_pool: [...jokeTexts, ...jokeVariants],
    theme: supportedValue(payload.theme, ["blue", "pop", "mint"], "blue"),
  };
}

function coerceTextList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

async function createTranslationJob(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const payload = {
    operation_mode: "translation",
    audio_base64: await blobToBase64(audio),
    audio_mime_type: normalizeMimeType(audio.type || guessAudioMimeType(audio.name)),
    translation_backend: env.RUNPOD_SERVERLESS_TRANSLATION_BACKEND || "openai",
    source_language: stringFormValue(form, "source_language", "auto"),
    target_language: stringFormValue(form, "target_language", "user-auto"),
    voice_mode: stringFormValue(form, "voice_mode", "default"),
    text_transform: optionalStringFormValue(form, "text_transform"),
    text_transform_options: parseJsonFormValue(form, "text_transform_options", {}),
    text_transform_suffix: optionalStringFormValue(form, "text_transform_suffix"),
    text_transform_unit: stringFormValue(form, "text_transform_unit", "text"),
    ...seedVcPayloadFromForm(form),
  };
  const body = await submitRunpodJob(env, payload);
  return jobSnapshotFromRunpod(body, "translation");
}

async function createVoiceConversionJob(request, env) {
  const form = await request.formData();
  const sourceAudio = requiredBlob(form, "source_audio");
  const referenceAudio = requiredBlob(form, "reference_audio");
  const payload = {
    operation_mode: "voice_conversion",
    source_audio_base64: await blobToBase64(sourceAudio),
    source_audio_mime_type: normalizeMimeType(sourceAudio.type || guessAudioMimeType(sourceAudio.name)),
    reference_audio_base64: await blobToBase64(referenceAudio),
    reference_audio_mime_type: normalizeMimeType(referenceAudio.type || guessAudioMimeType(referenceAudio.name)),
    voice_backend: stringFormValue(form, "voice_backend", "seed-vc"),
    ...seedVcPayloadFromForm(form),
  };
  const body = await submitRunpodJob(env, payload);
  return jobSnapshotFromRunpod(body, "voice_conversion");
}

async function createWarmupJob(env) {
  const payload = {
    operation_mode: "warmup",
    translation_backend: env.RUNPOD_SERVERLESS_TRANSLATION_BACKEND || "openai",
    preload_translation: env.RUNPOD_WARMUP_PRELOAD_TRANSLATION !== "0",
    preload_voice_conversion: env.RUNPOD_WARMUP_PRELOAD_VOICE_CONVERSION !== "0",
  };
  const body = await submitRunpodJob(env, payload);
  return jobSnapshotFromRunpod(body, "warmup");
}

async function getRunpodJobSnapshot(jobId, env, kind) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" });
  return jobSnapshotFromRunpod(body, kind);
}

function jobSnapshotFromRunpod(body, kind) {
  const jobId = String(body.id || body.job_id || "");
  const status = String(body.status || "").toUpperCase();
  if (status === "COMPLETED") {
    return {
      job_id: jobId,
      status: "succeeded",
      current_stage: { stage: "complete", label: "完了", provider: "" },
      stages: completedStages(kind),
      result: body.output || null,
      error: null,
    };
  }
  if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    return {
      job_id: jobId,
      status: "failed",
      current_stage: { stage: "failed", label: "失敗", provider: "RunPod Serverless" },
      stages: plannedStages(kind),
      result: null,
      error: runpodErrorMessage(body),
    };
  }
  const queued = status === "IN_QUEUE" || status === "QUEUED" || !status;
  return {
    job_id: jobId,
    status: queued ? "queued" : "running",
    current_stage: currentStageForKind(kind, queued),
    stages: plannedStages(kind),
    result: null,
    error: null,
  };
}

function plannedStages(kind) {
  if (kind === "voice_conversion") {
    return [{ stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" }];
  }
  if (kind === "warmup") {
    return [{ stage: "warmup", label: "準備", provider: "RunPod Serverless" }];
  }
  return [
    { stage: "asr", label: "文字起こし", provider: "RunPod Serverless" },
    { stage: "translation", label: "翻訳", provider: "RunPod Serverless" },
    { stage: "tts", label: "音声生成", provider: "RunPod Serverless" },
  ];
}

function completedStages(kind) {
  return [...plannedStages(kind), { stage: "complete", label: "完了", provider: "" }];
}

function currentStageForKind(kind, queued) {
  if (queued) {
    return { stage: "queued", label: "待機中", provider: "RunPod Serverless" };
  }
  if (kind === "voice_conversion") {
    return { stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" };
  }
  if (kind === "warmup") {
    return { stage: "warmup", label: "準備", provider: "RunPod Serverless" };
  }
  return { stage: "asr", label: "RunPod推論", provider: "RunPod Serverless" };
}

async function createUserDisplayText(payload, env) {
  const text = String(payload.text || "").trim();
  const targetLanguage = String(payload.target_language || "ja-JP");
  if (!text) {
    return { kanji_text: "", hiragana_text: "", indonesian_text: "" };
  }
  if (targetLanguage === "id-ID") {
    return { kanji_text: text, hiragana_text: "", indonesian_text: text };
  }
  if (targetLanguage !== "ja-JP") {
    return { kanji_text: text, hiragana_text: "", indonesian_text: "" };
  }
  const hiragana = await openAiText(env, {
    model: env.OPENAI_TEXT_DISPLAY_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions:
      "Convert the Japanese sentence to hiragana only for display to language learners. Return only the hiragana text, with no notes. Keep punctuation and Arabic numerals readable.",
    input: text,
  });
  return { kanji_text: text, hiragana_text: hiragana || text, indonesian_text: "" };
}

async function createUserTextOutput(payload, env) {
  const translatedText = String(payload.translated_text || "").trim();
  if (!translatedText) {
    throw httpError(400, "translated_text is required");
  }
  const targetLanguage = String(payload.target_language || "ja-JP");
  const transformOptions = typeof payload.text_transform_options === "object" && payload.text_transform_options !== null
    ? payload.text_transform_options
    : {};
  const transformedText = await transformUserText(translatedText, targetLanguage, transformOptions, env);
  const tts = await openAiSpeech(env, transformedText);
  return {
    transcript: String(payload.transcript || ""),
    translated_text: translatedText,
    transformed_text: transformedText,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: tts.timings_ms,
    providers: {
      asr: "cached",
      translation: "cached",
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    warnings: [],
    target_language: targetLanguage,
  };
}

async function createUserJokeOutput(payload, env) {
  const text = String(payload.text || "").trim();
  if (!text) {
    throw httpError(400, "text is required");
  }
  const targetLanguage = String(payload.target_language || "id-ID");
  const translatedText = await openAiText(env, {
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions: "Translate the text into natural Indonesian for a short spoken joke. Return only the translated text.",
    input: text,
  });
  const tts = await openAiSpeech(env, translatedText || text);
  return {
    transcript: text,
    translated_text: translatedText || text,
    transformed_text: translatedText || text,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: tts.timings_ms,
    providers: {
      asr: "none",
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    warnings: [],
    target_language: targetLanguage,
  };
}

async function transformUserText(text, targetLanguage, options, env) {
  if (
    targetLanguage !== "ja-JP" ||
    (!optionEnabled(options.osaka_dialect) && !optionEnabled(options.variation))
  ) {
    return text;
  }
  const instructions = [
    "You rewrite short Japanese spoken output for a playful speech conversion app.",
    "Return only the rewritten Japanese text, with no notes.",
    "Keep it concise and suitable for text-to-speech.",
  ];
  if (optionEnabled(options.osaka_dialect)) {
    instructions.push("Use natural Osaka dialect while preserving the speaker's intent.");
  }
  if (optionEnabled(options.variation)) {
    instructions.push(
      "Create a small playful variation of the request by changing a concrete number, condition, or target when that is natural; do not make it offensive or confusing.",
    );
  }
  return (
    await openAiText(env, {
      model: env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
      instructions: instructions.join(" "),
      input: text,
    })
  ) || text;
}

async function submitRunpodJob(env, inputPayload) {
  return runpodRequest(env, "/run", {
    method: "POST",
    payload: { input: inputPayload },
  });
}

async function runpodRequest(env, path, { method = "GET", payload = null, timeoutMs = null } = {}) {
  requireEnv(env, "RUNPOD_ENDPOINT_ID");
  requireEnv(env, "RUNPOD_API_KEY");
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await runtimeFetch(env)(`${runpodBaseUrl(env)}/${env.RUNPOD_ENDPOINT_ID}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller?.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw httpError(response.status, body.error || body.message || `RunPod request failed: ${response.status}`);
    }
    return body;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function openAiText(env, payload) {
  requireEnv(env, "OPENAI_API_KEY");
  const response = await runtimeFetch(env)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, body.error?.message || body.error || `OpenAI request failed: ${response.status}`);
  }
  return textFromOpenAiResponse(body);
}

async function openAiSpeech(env, text) {
  requireEnv(env, "OPENAI_API_KEY");
  const started = Date.now();
  const responseFormat = env.OPENAI_TTS_RESPONSE_FORMAT || "wav";
  const response = await runtimeFetch(env)("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: env.OPENAI_TTS_VOICE || "coral",
      input: text,
      instructions: env.OPENAI_TTS_INSTRUCTIONS || "Speak naturally and clearly in the target language.",
      response_format: responseFormat,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw httpError(response.status, body.error?.message || body.error || `OpenAI TTS failed: ${response.status}`);
  }
  const audio = await response.arrayBuffer();
  return {
    audio_mime_type: audioMimeFromOpenAiFormat(responseFormat),
    audio_base64: arrayBufferToBase64(audio),
    timings_ms: { tts: Date.now() - started, total: Date.now() - started },
  };
}

function textFromOpenAiResponse(body) {
  if (typeof body.output_text === "string") {
    return body.output_text.trim();
  }
  if (Array.isArray(body.output)) {
    const chunks = [];
    for (const item of body.output) {
      if (!Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (typeof content.text === "string") {
          chunks.push(content.text);
        }
      }
    }
    return chunks.join("").trim();
  }
  if (typeof body.text === "string") {
    return body.text.trim();
  }
  return "";
}

function seedVcPayloadFromForm(form) {
  return {
    ...optionalNumberPayload(form, "seed_vc_diffusion_steps", true),
    ...optionalNumberPayload(form, "seed_vc_reference_max_seconds", false),
    ...optionalNumberPayload(form, "seed_vc_length_adjust", false),
    ...optionalNumberPayload(form, "seed_vc_inference_cfg_rate", false),
    ...optionalBooleanPayload(form, "seed_vc_reference_auto_select"),
  };
}

function optionalNumberPayload(form, key, integer) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return {};
  }
  const value = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  return Number.isFinite(value) ? { [key]: value } : {};
}

function optionalBooleanPayload(form, key) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return {};
  }
  return { [key]: optionEnabled(raw) };
}

function requiredBlob(form, key) {
  const value = form.get(key);
  if (!value || typeof value.arrayBuffer !== "function") {
    throw httpError(400, `${key} is required`);
  }
  return value;
}

function stringFormValue(form, key, fallback = "") {
  return String(form.get(key) || fallback);
}

function optionalStringFormValue(form, key) {
  const value = form.get(key);
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function parseJsonFormValue(form, key, fallback) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

async function blobToBase64(blob) {
  return arrayBufferToBase64(await blob.arrayBuffer());
}

function arrayBufferToBase64(buffer) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function guessAudioMimeType(name = "") {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  return "audio/wav";
}

function normalizeMimeType(value = "") {
  return String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function audioMimeFromOpenAiFormat(format) {
  return {
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/wav",
  }[format] || "audio/wav";
}

function runpodBaseUrl(env) {
  return (env.RUNPOD_API_BASE_URL || RUNPOD_DEFAULT_BASE_URL).replace(/\/$/, "");
}

function runtimeFetch(env) {
  return env.__fetch || fetch;
}

function requireEnv(env, key) {
  if (!env[key]) {
    throw httpError(503, `${key} is required`);
  }
}

function runpodErrorMessage(body) {
  return String(body.error || body.message || "RunPod job failed");
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(init.status === 204 ? null : JSON.stringify(payload), { ...init, headers });
}

function httpError(status, message) {
  const error = new Error(String(message));
  error.status = status;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function supportedValue(value, supported, fallback) {
  return supported.includes(String(value)) ? String(value) : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function optionEnabled(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function numberFromEnv(value, fallback) {
  const number = Number.parseFloat(String(value || ""));
  return Number.isFinite(number) ? number : fallback;
}
