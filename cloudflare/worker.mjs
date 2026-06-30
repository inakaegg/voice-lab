const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
const RUNPOD_TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const RUNPOD_RUNNING_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "RUNNING"]);
const USER_SETTINGS_KV_KEY = "user-settings";
const AUDIO_HISTORY_INDEX_KV_KEY = "audio-history:index";
const TRANSLATION_JOB_KV_PREFIX = "translation-job:";
const RUNPOD_VC_READY_KV_KEY_PREFIX = "runpod:seed-vc-ready:";
const AUDIO_HISTORY_DEFAULT_LIMIT = 100;
const AUDIO_HISTORY_KINDS = new Set(["recordings", "outputs"]);
const OPENAI_LANGUAGE_CODES = {
  auto: "",
  "id-ID": "id",
  "ja-JP": "ja",
  "zh-CN": "zh",
  "en-US": "en",
};
const OPENAI_LANGUAGE_NAMES = {
  "id-ID": "Indonesian",
  "ja-JP": "Japanese",
  "zh-CN": "Chinese",
  "en-US": "English",
};
const PRACTICE_TARGET_LANGUAGES = {
  "ja-JP": { label: "日本語", speech_name: "Japanese" },
  "zh-CN": { label: "中文", speech_name: "Mandarin Chinese" },
  "en-US": { label: "English", speech_name: "English" },
};
const PRACTICE_GRADE_LABELS = {
  ok: "いいかんじ",
  almost: "もうすこし",
  retry: "ちがうかも",
};
const ZH_TRADITIONAL_TO_SIMPLIFIED = {
  後: "后",
  裏: "里",
  裡: "里",
  著: "着",
  麼: "么",
  麽: "么",
  樣: "样",
  嗎: "吗",
  妳: "你",
  們: "们",
  個: "个",
  這: "这",
  會: "会",
  說: "说",
  話: "话",
  語: "语",
  學: "学",
  習: "习",
  聽: "听",
  問: "问",
  題: "题",
  現: "现",
  開: "开",
  關: "关",
  見: "见",
  歡: "欢",
  愛: "爱",
  買: "买",
  賣: "卖",
  車: "车",
  輛: "辆",
  價: "价",
  還: "还",
  貴: "贵",
  綠: "绿",
  種: "种",
  點: "点",
  氣: "气",
  電: "电",
  腦: "脑",
  網: "网",
  寫: "写",
  讀: "读",
  書: "书",
  時: "时",
  間: "间",
  國: "国",
  東: "东",
  風: "风",
  來: "来",
  過: "过",
  長: "长",
  門: "门",
  無: "无",
  實: "实",
  體: "体",
  應: "应",
  讓: "让",
  給: "给",
  對: "对",
  從: "从",
  為: "为",
  發: "发",
  聲: "声",
  區: "区",
  別: "别",
  當: "当",
  幾: "几",
  難: "难",
  簡: "简",
  漢: "汉",
  雖: "虽",
  舊: "旧",
};

const DEFAULT_USER_SETTINGS = {
  target_language: "ja-JP",
  joke_text: "",
  joke_texts: [],
  joke_position: "after",
  joke_selection: "rotation",
  joke_variation_count: 0,
  joke_variants: [],
  joke_pool: [],
  effect_audios: [],
  effect_selection: "rotation",
  effect_insert_mode: "silence_or_tail",
  effect_max_insertions: 1,
  effect_min_silence_ms: 300,
  theme: "blue",
};

let ephemeralUserSettings = null;
const ephemeralTranslationJobs = new Map();

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
      return jsonResponse(await readUserSettings(env));
    }
    if (request.method === "PUT" && url.pathname === "/api/user-settings") {
      const payload = await request.json();
      return jsonResponse(await writeUserSettings(payload, env));
    }
    if (request.method === "GET" && url.pathname === "/api/audio-history") {
      return jsonResponse(await listAudioHistory(env));
    }
    if (request.method === "GET" && url.pathname === "/api/practice-history") {
      return jsonResponse(await listPracticeHistory(env));
    }
    if (request.method === "POST" && url.pathname === "/api/audio-history/outputs") {
      return jsonResponse(await saveUploadedAudioHistoryOutput(request, env));
    }
    if ((request.method === "GET" || request.method === "DELETE") && url.pathname.startsWith("/api/audio-history/")) {
      const [, , , kind, filename] = url.pathname.split("/");
      if (request.method === "GET") {
        return getAudioHistoryFile(kind, decodeURIComponent(filename || ""), env);
      }
      return jsonResponse(await deleteAudioHistoryFile(kind, decodeURIComponent(filename || ""), env));
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
    if (request.method === "POST" && url.pathname === "/api/practice/prompts") {
      return jsonResponse(await createPracticePrompt(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/attempts") {
      return jsonResponse(await createPracticeAttempt(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/translate-speech-jobs") {
      return jsonResponse(await createTranslationJob(request, env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/translate-speech-jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getTranslationJobSnapshot(jobId, env));
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
  } else if (url.pathname === "/practice") {
    assetUrl.pathname = "/practice.html";
  } else if (url.pathname === "/practice/admin") {
    assetUrl.pathname = "/practice_admin.html";
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
  const warmup = {
    ...(runpodAvailable ? await readRunpodVcReadyState(env) : runpodVcReadyState(false)),
    auto_on_user_page_load: Boolean(runpodAvailable && env.RUNPOD_AUTO_WARMUP_ON_USER_LOAD === "1"),
  };
  const seedVcModelResident = Boolean(warmup.ready);
  return {
    provider_mode: "cloudflare",
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    supported_voice_modes: ["default", "convert"],
    translation_backends: [
      {
        id: "openai",
        label: "音声翻訳（Cloudflare + OpenAI API）",
        available: openaiAvailable,
        reason: openaiAvailable ? "" : "OPENAI_API_KEY が設定されていません。",
        providers: {
          asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
          translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
          tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_source_languages: ["auto", "id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_target_languages: ["id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_voice_modes: ["default"],
          text_transform: true,
          request_mode: "completed_job",
          gateway: "cloudflare",
        },
      },
      {
        id: "runpod_serverless",
        label: "音声翻訳（RunPod Serverless）",
        available: false,
        reason: "Cloudflareデモでは音声翻訳をOpenAI API、RunPodをSeed-VC専用にします。",
        providers: {
          asr: "runpod-serverless-asr",
          translation: "runpod-serverless-translation",
          tts: "runpod-serverless-tts",
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_voice_modes: ["default", "convert"],
          text_transform: true,
          serverless: true,
          health,
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
            model_resident: seedVcModelResident,
            diffusion_steps: numberFromEnv(env.SEED_VC_DIFFUSION_STEPS, 8),
            reference_max_seconds: numberFromEnv(env.SEED_VC_REFERENCE_MAX_SECONDS, 12),
            reference_auto_select: true,
          },
          warmup,
          health,
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

async function readUserSettings(env) {
  const kv = stateKv(env);
  if (kv) {
    const stored = await kvGetJson(kv, USER_SETTINGS_KV_KEY, null);
    if (stored && typeof stored === "object") {
      return coerceUserSettings(stored);
    }
  }
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

async function writeUserSettings(payload, env) {
  const settings = await prepareUserSettingsForWrite(payload, env);
  const kv = stateKv(env);
  if (kv) {
    await kv.put(USER_SETTINGS_KV_KEY, JSON.stringify(settings));
  } else {
    ephemeralUserSettings = settings;
  }
  return settings;
}

async function prepareUserSettingsForWrite(payload, env) {
  const settings = coerceUserSettings(payload);
  if (settings.joke_variation_count <= 0 || settings.joke_texts.length === 0) {
    return coerceUserSettings({ ...settings, joke_variants: [] });
  }
  const jokeVariants = await generateJokeVariants(settings.joke_texts, settings.joke_variation_count, env);
  return coerceUserSettings({ ...settings, joke_variants: jokeVariants });
}

function coerceUserSettings(payload = {}) {
  const jokeTexts = coerceTextList(payload.joke_texts ?? payload.joke_text);
  const jokeVariants = coerceTextList(payload.joke_variants);
  const effectAudios = coerceEffectAudios(payload.effect_audios);
  return {
    target_language: supportedValue(payload.target_language, ["ja-JP", "id-ID", "zh-CN", "en-US"], "ja-JP"),
    joke_text: jokeTexts.join("\n"),
    joke_texts: jokeTexts,
    joke_position: supportedValue(payload.joke_position, ["before", "after"], "after"),
    joke_selection: supportedValue(payload.joke_selection, ["rotation", "random"], "rotation"),
    joke_variation_count: clampInt(payload.joke_variation_count, 0, 5, 0),
    joke_variants: jokeVariants,
    joke_pool: [...jokeTexts, ...jokeVariants],
    effect_audios: effectAudios,
    effect_selection: supportedValue(payload.effect_selection, ["rotation", "random"], "rotation"),
    effect_insert_mode: supportedValue(payload.effect_insert_mode, ["silence_or_tail", "tail"], "silence_or_tail"),
    effect_max_insertions: clampInt(payload.effect_max_insertions, 1, 5, 1),
    effect_min_silence_ms: clampInt(payload.effect_min_silence_ms, 100, 2000, 300),
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

function coerceEffectAudios(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const audioBase64 = String(item.audio_base64 || "").trim();
      if (!audioBase64 || audioBase64.length > 2_000_000) {
        return null;
      }
      return {
        id: String(item.id || `effect-${index + 1}`).trim() || `effect-${index + 1}`,
        name: String(item.name || `effect-${index + 1}.wav`).trim().slice(0, 120) || `effect-${index + 1}.wav`,
        audio_mime_type: normalizeMimeType(item.audio_mime_type || "audio/wav") || "audio/wav",
        audio_base64: audioBase64,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

async function generateJokeVariants(jokeTexts, variationCount, env) {
  const rawText = await openAiText(env, {
    model: env.OPENAI_JOKE_VARIATION_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions:
      "You create short joke text variations for a speech conversion app. Keep each variation in the same language as its source joke. Return only strict JSON in this shape: {\"variants\":[[\"variant 1 for source 1\",\"variant 2 for source 1\"],[\"variant 1 for source 2\",\"variant 2 for source 2\"]]}. Each inner array must correspond to the source joke at the same index.",
    input: JSON.stringify({ jokes: jokeTexts, variants_per_joke: variationCount }),
  });
  return parseJokeVariantsResponse(rawText, jokeTexts.length, variationCount);
}

function parseJokeVariantsResponse(rawText, sourceCount, variationCount) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw httpError(502, "joke variation response was not valid JSON");
  }
  const variants = Array.isArray(payload) ? payload : payload?.variants;
  if (!Array.isArray(variants)) {
    throw httpError(502, "joke variation response did not include variants");
  }
  let matrix = [];
  if (variants.every((row) => Array.isArray(row))) {
    matrix = variants.slice(0, sourceCount).map((row) =>
      row.map((item) => String(item).trim()).filter(Boolean).slice(0, variationCount)
    );
  } else {
    const flat = variants.map((item) => String(item).trim()).filter(Boolean);
    matrix = Array.from({ length: sourceCount }, (_, index) =>
      flat.slice(index * variationCount, (index + 1) * variationCount)
    );
  }
  if (matrix.length < sourceCount || matrix.some((row) => row.length < variationCount)) {
    throw httpError(502, "joke variation response did not include enough variants");
  }
  const ordered = [];
  for (let variantIndex = 0; variantIndex < variationCount; variantIndex += 1) {
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      ordered.push(matrix[sourceIndex][variantIndex]);
    }
  }
  return ordered;
}

async function createTranslationJob(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const audioBytes = await audio.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBytes);
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const sourceLanguage = stringFormValue(form, "source_language", "auto");
  const targetLanguage = stringFormValue(form, "target_language", "user-auto");
  const voiceMode = stringFormValue(form, "voice_mode", "default");
  const translationBackend = stringFormValue(form, "translation_backend", "openai");
  const textTransform = optionalStringFormValue(form, "text_transform");
  const textTransformOptions = parseJsonFormValue(form, "text_transform_options", {});
  const textTransformSuffix = optionalStringFormValue(form, "text_transform_suffix");
  const textTransformUnit = stringFormValue(form, "text_transform_unit", "text");
  const jobId = `cf-${crypto.randomUUID()}`;

  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: audioBase64,
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(jobId)}-input.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "translate-speech-jobs",
      translation_backend: "openai",
      source_language: sourceLanguage,
      target_language: targetLanguage,
      voice_mode: voiceMode,
      filename: audio.name || "",
      original_content_type: audio.type || audioMimeType,
      original_audio_suffix: `.${extensionForMimeType(audioMimeType)}`,
    },
  });

  const asrStarted = Date.now();
  const transcript = await openAiTranscribe(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage,
    filename: audio.name || `recording.${extensionForMimeType(audioMimeType)}`,
  });
  const asrMs = Date.now() - asrStarted;

  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript,
    sourceLanguage,
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;

  const textTransformStarted = Date.now();
  const transformedText = await transformTranslationText(env, {
    translatedText: translation.translated_text,
    targetLanguage: translation.target_language,
    textTransform,
    textTransformOptions,
    textTransformSuffix,
    textTransformUnit,
  });
  const textTransformMs = Date.now() - textTransformStarted;

  const tts = await openAiSpeech(env, transformedText);
  const result = {
    transcript,
    translated_text: translation.translated_text,
    transformed_text: transformedText,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: {
      asr: asrMs,
      translation: translationMs,
      text_transform: textTransformMs,
      ...(tts.timings_ms || {}),
      total: asrMs + translationMs + textTransformMs + Number(tts.timings_ms?.tts || 0),
    },
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
      ...(textTransform ? { text_transform: textTransform } : {}),
    },
    warnings: [],
    target_language: translation.target_language,
    detected_source_language: translation.source_language,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "translate-speech-jobs",
    translation_backend: "openai",
    requested_translation_backend: translationBackend,
    source_language: translation.source_language || sourceLanguage,
    target_language: translation.target_language,
    voice_mode: voiceMode,
  });
  const snapshot = completedJobSnapshot(jobId, "translation", result);
  await saveTranslationJobSnapshot(env, snapshot);
  return snapshot;
}

async function createVoiceConversionJob(request, env) {
  const form = await request.formData();
  const sourceAudio = requiredBlob(form, "source_audio");
  const referenceAudio = requiredBlob(form, "reference_audio");
  const sourceAudioBase64 = await blobToBase64(sourceAudio);
  const sourceAudioMimeType = normalizeMimeType(sourceAudio.type || guessAudioMimeType(sourceAudio.name));
  const referenceAudioBase64 = await blobToBase64(referenceAudio);
  const referenceAudioMimeType = normalizeMimeType(referenceAudio.type || guessAudioMimeType(referenceAudio.name));
  const voiceBackend = stringFormValue(form, "voice_backend", "seed-vc");
  const audioEffectAudio = optionalBlob(form, "audio_effect_audio");
  const audioEffectEnabled = optionEnabled(stringFormValue(form, "audio_effect_enabled", "false"));
  const payload = {
    operation_mode: "voice_conversion",
    source_audio_base64: sourceAudioBase64,
    source_audio_mime_type: sourceAudioMimeType,
    reference_audio_base64: referenceAudioBase64,
    reference_audio_mime_type: referenceAudioMimeType,
    voice_backend: voiceBackend,
    ...seedVcPayloadFromForm(form),
  };
  if (audioEffectEnabled && audioEffectAudio) {
    payload.audio_effect_enabled = true;
    payload.audio_effect_audio_base64 = await blobToBase64(audioEffectAudio);
    payload.audio_effect_audio_mime_type = normalizeMimeType(
      audioEffectAudio.type || guessAudioMimeType(audioEffectAudio.name),
    );
    payload.audio_effect_insert_mode = supportedValue(
      stringFormValue(form, "audio_effect_insert_mode", "silence_or_tail"),
      ["silence_or_tail", "tail"],
      "silence_or_tail",
    );
    payload.audio_effect_max_insertions = clampInt(
      stringFormValue(form, "audio_effect_max_insertions", "1"),
      1,
      5,
      1,
    );
    payload.audio_effect_min_silence_ms = clampInt(
      stringFormValue(form, "audio_effect_min_silence_ms", "300"),
      100,
      2000,
      300,
    );
  }
  const body = await submitRunpodJob(env, payload);
  const snapshot = jobSnapshotFromRunpod(body, "voice_conversion");
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, "voice_conversion")) {
    await saveRunpodVcReadyState(env, snapshot, "voice_conversion");
  }
  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: sourceAudioBase64,
    audio_mime_type: sourceAudioMimeType,
    filename: `${safeHistoryToken(snapshot.job_id || crypto.randomUUID())}-source.${extensionForMimeType(sourceAudioMimeType)}`,
    metadata: {
      endpoint: "voice-conversion-jobs",
      voice_backend: voiceBackend,
      filename: sourceAudio.name || "",
      content_type: sourceAudio.type || sourceAudioMimeType,
    },
  });
  return snapshot;
}

async function createWarmupJob(env) {
  const payload = {
    operation_mode: "warmup",
    translation_backend: env.RUNPOD_SERVERLESS_TRANSLATION_BACKEND || "openai",
    preload_translation: env.RUNPOD_WARMUP_PRELOAD_TRANSLATION !== "0",
    preload_voice_conversion: env.RUNPOD_WARMUP_PRELOAD_VOICE_CONVERSION !== "0",
  };
  const body = await submitRunpodJob(env, payload);
  const snapshot = jobSnapshotFromRunpod(body, "warmup");
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, "warmup")) {
    await saveRunpodVcReadyState(env, snapshot, "warmup");
  }
  return snapshot;
}

async function getRunpodJobSnapshot(jobId, env, kind) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" });
  const snapshot = jobSnapshotFromRunpod(body, kind);
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, kind)) {
    await saveRunpodVcReadyState(env, snapshot, kind);
  }
  if (snapshot.status === "succeeded" && snapshot.result?.audio_base64) {
    await saveRunpodOutputHistory(env, jobId, kind, snapshot.result);
  }
  return snapshot;
}

async function readRunpodVcReadyState(env) {
  const kv = stateKv(env);
  if (!kv) {
    return runpodVcReadyState(false);
  }
  const stateKey = runpodVcReadyKvKey(env);
  const state = await kvGetJson(kv, stateKey, null);
  if (!state || typeof state !== "object") {
    return runpodVcReadyState(false);
  }
  const expiresAt = Date.parse(String(state.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await kv.delete(stateKey);
    return runpodVcReadyState(false);
  }
  return runpodVcReadyState(true, state);
}

async function saveRunpodVcReadyState(env, snapshot, kind) {
  const kv = stateKv(env);
  if (!kv) {
    return;
  }
  const ttlSeconds = runpodVcReadyTtlSeconds(env);
  const state = {
    ready: true,
    source: kind,
    job_id: snapshot.job_id || "",
    checked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    providers: snapshot.result?.providers || {},
    serverless_timings_ms: snapshot.result?.serverless_timings_ms || {},
  };
  await kv.put(runpodVcReadyKvKey(env), JSON.stringify(state), { expirationTtl: ttlSeconds });
}

function runpodVcReadyKvKey(env) {
  return `${RUNPOD_VC_READY_KV_KEY_PREFIX}${env.RUNPOD_ENDPOINT_ID || "default"}`;
}

function isRunpodVcReadyResult(result, kind) {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (kind === "warmup") {
    return result.warm === true && result.providers?.voice_conversion === "seed-vc";
  }
  if (kind === "voice_conversion") {
    return Boolean(result.audio_base64);
  }
  return false;
}

function runpodVcReadyState(ready, state = {}) {
  return {
    ready: Boolean(ready),
    source: String(state.source || ""),
    job_id: String(state.job_id || ""),
    checked_at: String(state.checked_at || ""),
    expires_at: String(state.expires_at || ""),
    providers: state.providers || {},
    serverless_timings_ms: state.serverless_timings_ms || {},
  };
}

async function getTranslationJobSnapshot(jobId, env) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const snapshot = await readTranslationJobSnapshot(env, jobId);
  if (!snapshot) {
    throw httpError(404, "job not found");
  }
  return snapshot;
}

async function saveTranslationJobSnapshot(env, snapshot) {
  const kv = stateKv(env);
  if (kv) {
    await kv.put(`${TRANSLATION_JOB_KV_PREFIX}${snapshot.job_id}`, JSON.stringify(snapshot), {
      expirationTtl: numberFromEnv(env.CLOUDFLARE_TRANSLATION_JOB_TTL_SECONDS, 3600),
    });
  } else {
    ephemeralTranslationJobs.set(snapshot.job_id, snapshot);
  }
}

async function readTranslationJobSnapshot(env, jobId) {
  const kv = stateKv(env);
  if (kv) {
    return kvGetJson(kv, `${TRANSLATION_JOB_KV_PREFIX}${jobId}`, null);
  }
  return ephemeralTranslationJobs.get(jobId) || null;
}

function completedJobSnapshot(jobId, kind, result) {
  return {
    job_id: jobId,
    status: "succeeded",
    current_stage: { stage: "complete", label: "完了", provider: "" },
    stages: completedStages(kind),
    result,
    error: null,
  };
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
  const result = {
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
  await savePipelineOutputHistory(env, result, {
    endpoint: "user-text-output",
    translation_backend: "openai",
    target_language: targetLanguage,
    voice_mode: "default",
  });
  return result;
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
  const result = {
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
  await savePipelineOutputHistory(env, result, {
    endpoint: "user-joke-output",
    translation_backend: "openai",
    target_language: targetLanguage,
    voice_mode: "default",
  });
  return result;
}

async function createPracticePrompt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: arrayBufferToBase64(audioBytes),
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(`practice-${crypto.randomUUID()}`)}-native.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "practice-prompts",
      target_language: targetLanguage,
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const transcript = await openAiTranscribe(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: "auto",
    filename: audio.name || `native.${extensionForMimeType(audioMimeType)}`,
  });
  const asrMs = Date.now() - asrStarted;

  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript,
    sourceLanguage: "auto",
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;

  const tts = await openAiSpeech(env, translation.translated_text);
  const result = {
    transcript,
    target_text: translation.translated_text,
    translated_text: translation.translated_text,
    transformed_text: translation.translated_text,
    target_language: targetLanguage,
    target_language_label: PRACTICE_TARGET_LANGUAGES[targetLanguage].label,
    display_text: await createPracticeDisplayText(translation.translated_text, targetLanguage, env, {
      includePinyin,
    }),
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: {
      asr: asrMs,
      translation: translationMs,
      ...(tts.timings_ms || {}),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    detected_source_language: translation.source_language,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "practice-prompts",
    translation_backend: "openai",
    source_language: translation.source_language || "auto",
    target_language: targetLanguage,
    voice_mode: "default",
  });
  return result;
}

async function createPracticeAttempt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const targetText = stringFormValue(form, "target_text", "").trim();
  if (!targetText) {
    throw httpError(400, "target_text is required");
  }
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: arrayBufferToBase64(audioBytes),
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(`practice-${crypto.randomUUID()}`)}-repeat.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "practice-attempts",
      target_language: targetLanguage,
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const recognizedText = await openAiTranscribe(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: targetLanguage,
    filename: audio.name || `repeat.${extensionForMimeType(audioMimeType)}`,
  });
  const asrMs = Date.now() - asrStarted;
  const evaluation = evaluatePracticeAttempt(targetText, recognizedText, targetLanguage);
  return {
    target_language: targetLanguage,
    target_text: targetText,
    recognized_text: recognizedText,
    ...evaluation,
    timings_ms: {
      asr: asrMs,
      compare: Math.max(0, Date.now() - totalStarted - asrMs),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
    },
  };
}

async function createPracticeDisplayText(text, targetLanguage, env, { includePinyin = false } = {}) {
  if (targetLanguage === "zh-CN") {
    const pinyinText = includePinyin ? await createChinesePinyinText(text, env) : "";
    return {
      mode: "plain",
      primary_text: text,
      secondary_text: "",
      kanji_text: text,
      hiragana_text: "",
      pinyin_text: pinyinText,
      pinyin_status: pinyinText ? "ready" : (includePinyin ? "unavailable" : "disabled"),
    };
  }
  if (targetLanguage !== "ja-JP") {
    return {
      mode: "plain",
      primary_text: text,
      secondary_text: "",
      kanji_text: text,
      hiragana_text: "",
      pinyin_text: "",
      pinyin_status: "disabled",
    };
  }
  const display = await createUserDisplayText({ text, target_language: targetLanguage }, env);
  const hiraganaText = String(display.hiragana_text || "").trim();
  const kanjiText = String(display.kanji_text || text).trim();
  return {
    mode: hiraganaText ? "hiragana" : "plain",
    primary_text: hiraganaText || kanjiText,
    secondary_text: hiraganaText && hiraganaText !== kanjiText ? kanjiText : "",
    kanji_text: kanjiText,
    hiragana_text: hiraganaText,
    pinyin_text: "",
    pinyin_status: "disabled",
  };
}

async function createChinesePinyinText(text, env) {
  try {
    return (
      await openAiText(env, {
        model: env.OPENAI_TEXT_DISPLAY_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
        instructions:
          "Convert this Simplified Chinese sentence to Hanyu Pinyin with tone marks. Return only the pinyin text, with spaces between words or syllables. Do not add notes.",
        input: text,
      })
    ).trim();
  } catch (error) {
    console.warn("practice pinyin generation failed", error);
    return "";
  }
}

async function listAudioHistory(env) {
  const kv = stateKv(env);
  const index = kv ? await readAudioHistoryIndex(env) : { recordings: [], outputs: [] };
  return {
    settings: audioHistorySettings(env),
    recordings: index.recordings.filter((entry) => !isPracticeHistoryEntry(entry)).map(serializeAudioHistoryEntry),
    outputs: index.outputs.filter((entry) => !isPracticeHistoryEntry(entry)).map(serializeAudioHistoryEntry),
  };
}

async function listPracticeHistory(env) {
  const kv = stateKv(env);
  const index = kv ? await readAudioHistoryIndex(env) : { recordings: [], outputs: [] };
  return {
    settings: audioHistorySettings(env),
    recordings: index.recordings.filter(isPracticeHistoryEntry).map(serializeAudioHistoryEntry),
    outputs: index.outputs.filter(isPracticeHistoryEntry).map(serializeAudioHistoryEntry),
  };
}

async function saveUploadedAudioHistoryOutput(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const saved = await saveAudioHistoryEntry(env, "outputs", {
    audio_base64: await blobToBase64(audio),
    audio_mime_type: audioMimeType,
    metadata: {
      endpoint: stringFormValue(form, "endpoint", "manual"),
      translation_backend: stringFormValue(form, "translation_backend", ""),
      target_language: stringFormValue(form, "target_language", ""),
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });
  return {
    saved: Boolean(saved),
    entry: saved ? serializeAudioHistoryEntry(saved) : null,
  };
}

async function getAudioHistoryFile(kind, filename, env) {
  validateAudioHistoryPath(kind, filename);
  const kv = requireStateKv(env);
  const index = await readAudioHistoryIndex(env);
  const entry = index[kind].find((item) => item.filename === filename);
  if (!entry) {
    throw httpError(404, "audio history file not found");
  }
  const audioBase64 = await kv.get(entry.audio_key);
  if (!audioBase64) {
    throw httpError(404, "audio history file not found");
  }
  return new Response(base64ToBytes(audioBase64), {
    headers: {
      "Content-Type": entry.media_type || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

async function deleteAudioHistoryFile(kind, filename, env) {
  validateAudioHistoryPath(kind, filename);
  const kv = requireStateKv(env);
  const index = await readAudioHistoryIndex(env);
  const existing = index[kind].find((entry) => entry.filename === filename);
  if (!existing) {
    throw httpError(404, "audio history file not found");
  }
  index[kind] = index[kind].filter((entry) => entry.filename !== filename);
  await kv.delete(existing.audio_key);
  await kv.put(AUDIO_HISTORY_INDEX_KV_KEY, JSON.stringify(index));
  return { deleted: true };
}

async function savePipelineOutputHistory(env, result, metadata = {}) {
  return saveAudioHistoryEntry(env, "outputs", {
    audio_base64: result.audio_base64,
    audio_mime_type: result.audio_mime_type || "audio/wav",
    metadata: {
      ...metadata,
      audio_mime_type: result.audio_mime_type || "audio/wav",
      ...historyTextMetadataFromResult(result),
    },
  });
}

async function saveRunpodOutputHistory(env, jobId, kind, result) {
  const endpoint = kind === "voice_conversion" ? "voice-conversion-jobs" : "translate-speech-jobs";
  return saveAudioHistoryEntry(env, "outputs", {
    audio_base64: result.audio_base64,
    audio_mime_type: result.audio_mime_type || "audio/wav",
    filename: `${safeHistoryToken(jobId)}-output.${extensionForMimeType(result.audio_mime_type || "audio/wav")}`,
    metadata: {
      endpoint,
      translation_backend: kind === "translation" ? "runpod_serverless" : "",
      voice_backend: kind === "voice_conversion" ? "seed-vc" : "",
      target_language: result.target_language || "",
      voice_mode: kind === "voice_conversion" ? "convert" : "",
      audio_mime_type: result.audio_mime_type || "audio/wav",
      ...historyTextMetadataFromResult(result),
    },
  });
}

async function openAiTranscribe(env, { audioBytes, audioMimeType, sourceLanguage, filename }) {
  requireEnv(env, "OPENAI_API_KEY");
  const form = new FormData();
  form.append("model", env.OPENAI_ASR_MODEL || "gpt-4o-transcribe");
  form.append("response_format", "text");
  const language = OPENAI_LANGUAGE_CODES[sourceLanguage] || "";
  if (language) {
    form.append("language", language);
  }
  form.append(
    "file",
    new Blob([audioBytes], { type: audioMimeType || "application/octet-stream" }),
    filename || `audio.${extensionForMimeType(audioMimeType)}`,
  );
  const response = await runtimeFetch(env)("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw httpError(response.status, `OpenAI ASR failed: ${text}`);
  }
  return text.trim();
}

async function translateTranscript(env, { transcript, sourceLanguage, targetLanguage }) {
  if (!transcript.trim()) {
    return {
      source_language: sourceLanguage === "auto" ? "" : sourceLanguage,
      target_language: targetLanguage === "user-auto" ? "ja-JP" : targetLanguage,
      translated_text: "",
    };
  }
  const requestedTarget = targetLanguage === "user-auto" ? "user-auto" : supportedValue(targetLanguage, Object.keys(OPENAI_LANGUAGE_NAMES), "ja-JP");
  const instructions = requestedTarget === "user-auto"
    ? [
        "You translate a short speech transcript for a playful demo app.",
        "Detect the source language from the transcript.",
        "If the transcript is Japanese, translate it into natural Indonesian and set target_language to id-ID.",
        "If the transcript is not Japanese, translate it into natural Japanese and set target_language to ja-JP.",
        "Return only strict JSON: {\"source_language\":\"ja-JP|id-ID|zh-CN|en-US|auto\",\"target_language\":\"ja-JP|id-ID\",\"translated_text\":\"...\"}.",
      ].join(" ")
    : [
        "You translate a short speech transcript for a speech conversion app.",
        `Translate into ${OPENAI_LANGUAGE_NAMES[requestedTarget] || requestedTarget}.`,
        "Detect the source language when possible.",
        "Return only strict JSON: {\"source_language\":\"ja-JP|id-ID|zh-CN|en-US|auto\",\"target_language\":\"...\",\"translated_text\":\"...\"}.",
      ].join(" ");
  const rawText = await openAiText(env, {
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions,
    input: JSON.stringify({
      source_language: sourceLanguage,
      target_language: requestedTarget,
      transcript,
    }),
  });
  return parseTranslationResponse(rawText, sourceLanguage, requestedTarget);
}

function parseTranslationResponse(rawText, sourceLanguage, requestedTarget) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    const payload = JSON.parse(text);
    const targetLanguage = requestedTarget === "user-auto"
      ? supportedValue(payload.target_language, ["ja-JP", "id-ID"], "ja-JP")
      : supportedValue(payload.target_language, Object.keys(OPENAI_LANGUAGE_NAMES), requestedTarget);
    return {
      source_language: supportedValue(payload.source_language, ["auto", ...Object.keys(OPENAI_LANGUAGE_NAMES)], sourceLanguage),
      target_language: targetLanguage || "ja-JP",
      translated_text: String(payload.translated_text || "").trim(),
    };
  } catch (_error) {
    const fallbackTarget = requestedTarget === "user-auto" ? "ja-JP" : requestedTarget;
    return {
      source_language: sourceLanguage,
      target_language: fallbackTarget,
      translated_text: text,
    };
  }
}

async function transformTranslationText(env, {
  translatedText,
  targetLanguage,
  textTransform,
  textTransformOptions,
  textTransformSuffix,
  textTransformUnit,
}) {
  if (textTransform === "append_suffix") {
    return appendSuffix(translatedText, textTransformSuffix || String(textTransformOptions?.suffix || ""), textTransformUnit || textTransformOptions?.unit || "text");
  }
  if (textTransform === "user_effects") {
    return transformUserText(translatedText, targetLanguage, textTransformOptions || {}, env);
  }
  return translatedText;
}

function appendSuffix(text, suffix, unit) {
  if (!suffix) {
    return text;
  }
  if (unit === "text") {
    return `${text}${suffix}`;
  }
  if (unit !== "sentence") {
    throw httpError(400, `unsupported append_suffix unit: ${unit}`);
  }
  return text.replace(/([^。！？!?]+[。！？!?]?)/g, (segment) => {
    const trimmed = segment.trim();
    return trimmed ? `${segment}${suffix}` : segment;
  });
}

async function saveAudioHistoryEntry(env, kind, { audio_base64, audio_mime_type, filename = "", metadata = {} }) {
  const kv = stateKv(env);
  if (!kv || !audio_base64 || !AUDIO_HISTORY_KINDS.has(kind)) {
    return null;
  }
  const index = await readAudioHistoryIndex(env);
  const mediaType = normalizeMimeType(audio_mime_type) || "application/octet-stream";
  const safeFilename = safeHistoryFilename(
    filename || `${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomUUID()}.${extensionForMimeType(mediaType)}`,
  );
  const audioKey = `audio-history:${kind}:${safeFilename}:audio`;
  const normalizedMetadata = normalizeMetadata(metadata);
  const entry = {
    kind,
    filename: safeFilename,
    audio_key: audioKey,
    media_type: mediaType,
    size_bytes: base64ByteLength(audio_base64),
    created_at: new Date().toISOString(),
    metadata: normalizedMetadata,
  };
  await kv.put(audioKey, audio_base64);
  index[kind] = [entry, ...index[kind].filter((item) => item.filename !== safeFilename)];
  await trimAudioHistoryIndex(kv, index, kind, audioHistoryLimit(env));
  await kv.put(AUDIO_HISTORY_INDEX_KV_KEY, JSON.stringify(index));
  return entry;
}

async function trimAudioHistoryIndex(kv, index, kind, limit) {
  const overflow = index[kind].slice(limit);
  index[kind] = index[kind].slice(0, limit);
  await Promise.all(overflow.map((entry) => kv.delete(entry.audio_key)));
}

async function readAudioHistoryIndex(env) {
  const kv = stateKv(env);
  if (!kv) {
    return { recordings: [], outputs: [] };
  }
  const stored = await kvGetJson(kv, AUDIO_HISTORY_INDEX_KV_KEY, null);
  return {
    recordings: normalizeAudioHistoryEntries(stored?.recordings, "recordings"),
    outputs: normalizeAudioHistoryEntries(stored?.outputs, "outputs"),
  };
}

function normalizeAudioHistoryEntries(entries, kind) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((entry) => entry && typeof entry === "object" && entry.filename && entry.audio_key)
    .map((entry) => ({
      kind,
      filename: String(entry.filename),
      audio_key: String(entry.audio_key),
      media_type: normalizeMimeType(entry.media_type) || "application/octet-stream",
      size_bytes: Number(entry.size_bytes || 0),
      created_at: String(entry.created_at || ""),
      metadata: normalizeMetadata(entry.metadata || {}),
    }));
}

function serializeAudioHistoryEntry(entry) {
  const metadata = normalizeMetadata(entry.metadata || {});
  const preview = metadataTextPreview(metadata);
  return {
    kind: entry.kind,
    filename: entry.filename,
    url: `/api/audio-history/${entry.kind}/${encodeURIComponent(entry.filename)}`,
    label: audioHistoryLabel(entry.kind, metadata, preview),
    media_type: entry.media_type,
    size_bytes: entry.size_bytes,
    created_at: entry.created_at,
    metadata,
    text_preview: preview,
    tts_text: String(metadata.tts_text || ""),
    details: audioHistoryDetails(entry.kind, metadata),
    playable_hint: entry.size_bytes > 0 && entry.size_bytes < 128
      ? "音声ファイルが小さすぎます。テスト用または失敗したダミー出力の可能性があります。"
      : "",
  };
}

function audioHistorySettings(env) {
  const enabled = Boolean(stateKv(env));
  const root = enabled ? "Cloudflare Workers KV: MO_SPEECH_KV" : "Cloudflare Workers KV未設定";
  return {
    enabled,
    root,
    resolved_root: root,
    recordings_dir: "audio-history:recordings",
    outputs_dir: "audio-history:outputs",
    limit: audioHistoryLimit(env),
    env_var: "CLOUDFLARE_AUDIO_HISTORY_LIMIT",
  };
}

function audioHistoryLimit(env) {
  return clampInt(env.CLOUDFLARE_AUDIO_HISTORY_LIMIT || AUDIO_HISTORY_DEFAULT_LIMIT, 1, 100, AUDIO_HISTORY_DEFAULT_LIMIT);
}

function historyTextMetadataFromResult(result) {
  const transformed = textPreview(result.transformed_text);
  const translated = textPreview(result.translated_text);
  const transcript = textPreview(result.transcript);
  const ttsText = String(result.transformed_text || result.translated_text || "").trim();
  return {
    text_preview: transformed || translated || transcript,
    tts_text: ttsText,
    transcript_preview: transcript,
    translated_text_preview: translated,
    transformed_text_preview: transformed,
  };
}

function metadataTextPreview(metadata) {
  for (const key of ["text_preview", "transformed_text_preview", "translated_text_preview", "transcript_preview"]) {
    const value = String(metadata[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function audioHistoryLabel(kind, metadata, preview) {
  if (preview) {
    return preview;
  }
  const endpoint = String(metadata.endpoint || "");
  const filename = String(metadata.filename || metadata.audio_file || "");
  if (endpoint === "voice-conversion-jobs") {
    return kind === "outputs" ? "VC出力" : filename || "VC入力音声";
  }
  if (endpoint === "user-joke-output") {
    return "ジョーク音声";
  }
  if (endpoint === "user-text-output") {
    return "ユーザー画面TTS";
  }
  if (endpoint === "openai-realtime-streaming") {
    return "Realtime streaming出力";
  }
  if (endpoint.startsWith("translate-speech")) {
    return kind === "outputs" ? "翻訳音声" : filename || "入力音声";
  }
  return filename || (kind === "outputs" ? "出力音声" : "入力音声");
}

function audioHistoryDetails(kind, metadata) {
  const details = [String(metadata.endpoint || kind)];
  const route = audioHistoryRoute(metadata);
  if (route) {
    details.push(route);
  }
  for (const key of ["translation_backend", "tts_backend", "voice_backend"]) {
    const value = String(metadata[key] || "");
    if (value) {
      details.push(value);
    }
  }
  const filename = String(metadata.filename || "");
  if (filename) {
    details.push(filename);
  }
  return details;
}

function audioHistoryRoute(metadata) {
  const sourceLanguage = String(metadata.source_language || "");
  const targetLanguage = String(metadata.target_language || "");
  if (sourceLanguage && targetLanguage) {
    return `${sourceLanguage} -> ${targetLanguage}`;
  }
  return targetLanguage;
}

function textPreview(value) {
  const text = String(value || "").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function normalizeMetadata(metadata) {
  const normalized = {};
  if (!metadata || typeof metadata !== "object") {
    return normalized;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key] = typeof value === "string" ? value : String(value);
  }
  return normalized;
}

function isPracticeHistoryEntry(entry) {
  return String(entry?.metadata?.endpoint || "").startsWith("practice-");
}

function validateAudioHistoryPath(kind, filename) {
  if (!AUDIO_HISTORY_KINDS.has(kind)) {
    throw httpError(400, "unsupported audio history kind");
  }
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw httpError(400, "invalid audio history filename");
  }
}

function stateKv(env) {
  return env.MO_SPEECH_KV || null;
}

function requireStateKv(env) {
  const kv = stateKv(env);
  if (!kv) {
    throw httpError(503, "MO_SPEECH_KV binding is required");
  }
  return kv;
}

async function kvGetJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === "audio/webm" || normalized === "video/webm") return "webm";
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/mp4" || normalized === "audio/m4a" || normalized === "audio/x-m4a") return "m4a";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/aac") return "aac";
  if (normalized === "audio/flac") return "flac";
  return "wav";
}

function safeHistoryToken(value) {
  return String(value || "history").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "history";
}

function safeHistoryFilename(value) {
  const filename = safeHistoryToken(value);
  return filename.includes(".") ? filename : `${filename}.wav`;
}

function base64ByteLength(base64) {
  const value = String(base64 || "").replace(/\s/g, "");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function optionalBlob(form, key) {
  const value = form.get(key);
  if (!value || typeof value.arrayBuffer !== "function") {
    return null;
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

function runpodVcReadyTtlSeconds(env) {
  return Math.max(30, numberFromEnv(env.RUNPOD_WARMUP_READY_TTL_SECONDS, 300));
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
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
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

function supportedPracticeTargetLanguage(value) {
  const language = String(value || "ja-JP");
  if (!Object.prototype.hasOwnProperty.call(PRACTICE_TARGET_LANGUAGES, language)) {
    throw httpError(400, `unsupported practice target language: ${language}`);
  }
  return language;
}

function evaluatePracticeAttempt(targetText, recognizedText, targetLanguage) {
  const normalizedTarget = normalizePracticeText(targetText, targetLanguage);
  const normalizedRecognized = normalizePracticeText(recognizedText, targetLanguage);
  const similarity = practiceSimilarity(normalizedTarget, normalizedRecognized);
  const grade = practiceGrade(similarity);
  return {
    normalized_target: normalizedTarget,
    normalized_recognized: normalizedRecognized,
    similarity: Math.round(similarity * 1000) / 1000,
    grade,
    grade_label: PRACTICE_GRADE_LABELS[grade],
    diff: practiceDiff(normalizedTarget, normalizedRecognized),
  };
}

function normalizePracticeText(text, targetLanguage) {
  let normalized = String(text || "").normalize("NFKC").trim().toLowerCase();
  if (targetLanguage === "ja-JP") {
    normalized = normalized.replace(/[\u30a1-\u30f6]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    );
  }
  if (targetLanguage === "zh-CN") {
    normalized = normalizeChineseVariants(normalized);
  }
  return Array.from(normalized)
    .filter((char) => !/[\p{P}\p{Z}\p{S}]/u.test(char))
    .join("");
}

function normalizeChineseVariants(text) {
  return Array.from(String(text || ""))
    .map((char) => ZH_TRADITIONAL_TO_SIMPLIFIED[char] || char)
    .join("");
}

function practiceSimilarity(normalizedTarget, normalizedRecognized) {
  if (!normalizedTarget && !normalizedRecognized) {
    return 1;
  }
  if (!normalizedTarget || !normalizedRecognized) {
    return 0;
  }
  if (normalizedTarget === normalizedRecognized) {
    return 1;
  }
  const distance = levenshteinDistance(normalizedTarget, normalizedRecognized);
  const sequenceScore = 1 - distance / Math.max(normalizedTarget.length, normalizedRecognized.length);
  const containmentScore =
    normalizedTarget.includes(normalizedRecognized) || normalizedRecognized.includes(normalizedTarget)
      ? Math.min(normalizedTarget.length, normalizedRecognized.length) /
        Math.max(normalizedTarget.length, normalizedRecognized.length)
      : 0;
  return Math.max(0, Math.min(1, Math.max(sequenceScore, containmentScore)));
}

function practiceGrade(similarity) {
  if (similarity >= 0.82) {
    return "ok";
  }
  if (similarity >= 0.45) {
    return "almost";
  }
  return "retry";
}

function practiceDiff(normalizedTarget, normalizedRecognized) {
  const rows = normalizedTarget.length + 1;
  const cols = normalizedRecognized.length + 1;
  const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let targetIndex = normalizedTarget.length - 1; targetIndex >= 0; targetIndex -= 1) {
    for (let recognizedIndex = normalizedRecognized.length - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
      if (normalizedTarget[targetIndex] === normalizedRecognized[recognizedIndex]) {
        lcs[targetIndex][recognizedIndex] = lcs[targetIndex + 1][recognizedIndex + 1] + 1;
      } else {
        lcs[targetIndex][recognizedIndex] = Math.max(
          lcs[targetIndex + 1][recognizedIndex],
          lcs[targetIndex][recognizedIndex + 1],
        );
      }
    }
  }
  const entries = [];
  let targetIndex = 0;
  let recognizedIndex = 0;
  while (targetIndex < normalizedTarget.length || recognizedIndex < normalizedRecognized.length) {
    const targetStart = targetIndex;
    const recognizedStart = recognizedIndex;
    let type;
    if (
      targetIndex < normalizedTarget.length &&
      recognizedIndex < normalizedRecognized.length &&
      normalizedTarget[targetIndex] === normalizedRecognized[recognizedIndex]
    ) {
      type = "equal";
      targetIndex += 1;
      recognizedIndex += 1;
    } else if (
      recognizedIndex < normalizedRecognized.length &&
      (targetIndex >= normalizedTarget.length || lcs[targetIndex][recognizedIndex + 1] >= lcs[targetIndex + 1][recognizedIndex])
    ) {
      type = "insert";
      recognizedIndex += 1;
    } else {
      type = "delete";
      targetIndex += 1;
    }
    const previous = entries[entries.length - 1];
    if (previous && previous.type === type && previous.target_end === targetStart && previous.recognized_end === recognizedStart) {
      previous.target_end = targetIndex;
      previous.recognized_end = recognizedIndex;
      previous.target = normalizedTarget.slice(previous.target_start, previous.target_end);
      previous.recognized = normalizedRecognized.slice(previous.recognized_start, previous.recognized_end);
    } else {
      entries.push({
        type,
        target: normalizedTarget.slice(targetStart, targetIndex),
        recognized: normalizedRecognized.slice(recognizedStart, recognizedIndex),
        target_start: targetStart,
        target_end: targetIndex,
        recognized_start: recognizedStart,
        recognized_end: recognizedIndex,
      });
    }
  }
  return entries.length > 0
    ? entries
    : [{
        type: "equal",
        target: "",
        recognized: "",
        target_start: 0,
        target_end: 0,
        recognized_start: 0,
        recognized_end: 0,
      }];
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
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
