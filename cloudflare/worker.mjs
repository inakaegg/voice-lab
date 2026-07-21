import { pinyin } from "pinyin-pro";
import { Converter } from "opencc-js/t2cn";

const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
const RUNPOD_TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const RUNPOD_RUNNING_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "RUNNING"]);
const USER_SETTINGS_KV_KEY = "user-settings";
const TRANSLATION_JOB_KV_PREFIX = "translation-job:";
const PRACTICE_LLM_ATTEMPT_OPTIONS_KV_PREFIX = "practice-attempt-llm-options:";
const PRACTICE_ATTEMPT_RESULT_KV_PREFIX = "practice-attempt-result:";
// フロントエンド(app_practice.js)のattempt-jobsポーリング締め切りは30分。RunPodジョブが
// 完了するまでこの時間だけ待たれ得るため、comparison_model等を保持するKVのTTLは
// その締め切りに余裕を持たせた長さが必要(短いと完了時にoptionsが消えて選択したモデルを
// 見失う)。
const PRACTICE_ATTEMPT_POLL_WINDOW_SECONDS = 30 * 60;
const PRACTICE_LLM_ATTEMPT_OPTIONS_DEFAULT_TTL_SECONDS = PRACTICE_ATTEMPT_POLL_WINDOW_SECONDS + 10 * 60;
const PRACTICE_MODEL_ASR_CACHE_KV_PREFIX = "practice-model-asr:";
const RUNPOD_VC_READY_KV_KEY_PREFIX = "runpod:seed-vc-ready:";
const PUBLIC_ACCESS_SETTINGS_KV_KEY = "public-access-settings";
const PUBLIC_AUDIT_LOG_KV_KEY = "public-audit-log";
const PUBLIC_AUDIT_D1_MIGRATED_KV_KEY = "public-audit-log:d1-migrated";
const PUBLIC_AUDIT_LOG_DEFAULT_LIMIT = 500;
const PUBLIC_AUDIT_RETENTION_SECONDS = 60 * 60 * 24 * 90;
const PUBLIC_DAILY_QUOTA_RETENTION_SECONDS = 60 * 60 * 48;
const PUBLIC_SAMPLE_AUDIOS_KV_KEY = "public-sample-audios";
const PUBLIC_SAMPLE_AUDIO_MAX_BASE64_CHARS = 2_500_000;
const PUBLIC_SAMPLE_LANGUAGES = ["ja-JP", "zh-CN", "en-US"];
const PUBLIC_USAGE_KV_PREFIX = "public-usage:";
const PUBLIC_SESSION_COOKIE = "mo_public_session";
const PUBLIC_OAUTH_STATE_COOKIE = "mo_google_oauth_state";
const PUBLIC_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PUBLIC_OAUTH_STATE_TTL_SECONDS = 60 * 10;
const PUBLIC_ACCESS_FEATURES = ["speakloop", "skitvoice", "fun", "voice_conversion"];
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
const OPENAI_PRACTICE_ASR_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
const OPENAI_DEFAULT_PRACTICE_ASR_MODEL = "whisper-1";
const FUNASR_DEFAULT_PRACTICE_ASR_MODEL = "funasr/paraformer-zh";
const OPENAI_TIMESTAMP_ASR_MODELS = new Set(["whisper-1"]);
const OPENAI_JSON_ONLY_ASR_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
const PRACTICE_TARGET_LANGUAGES = {
  "ja-JP": { label: "日本語", speech_name: "Japanese" },
  "zh-CN": { label: "中文", speech_name: "Mandarin Chinese" },
  "en-US": { label: "English", speech_name: "English" },
};
const VIBEVOICE_OUTPUT_LANGUAGES = {
  "en-US": { label: "英語", speech_name: "English" },
  "zh-CN": { label: "中国語", speech_name: "Chinese" },
  "ja-JP": { label: "日本語（低品質）", speech_name: "Japanese" },
};
const MAX_CANONICAL_TARGET_PHRASES = 16;
const PRACTICE_HARD_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const PRACTICE_CLOSING_PUNCTUATION = new Set([..."\"'”’」』】）》）)]}"]);
const PRACTICE_PROTECTED_ABBREVIATIONS = new Set(["dr", "jr", "mr", "mrs", "ms", "prof", "sr", "st"]);
const traditionalChineseToSimplified = Converter({ from: "t", to: "cn" });

export class PracticeAlignmentError extends Error {
  constructor(reason, { stage = "attempt_asr", retryable = true } = {}) {
    super(reason);
    this.name = "PracticeAlignmentError";
    this.error_code = "practice_alignment_provider_contract_error";
    this.reason = reason;
    this.stage = stage;
    this.retryable = retryable;
  }
}

export class PracticeAlignmentInputError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "PracticeAlignmentInputError";
    this.error_code = "practice_alignment_invalid_input";
    this.reason = reason;
    this.stage = "input";
    this.retryable = false;
  }
}

export class PracticeLlmError extends Error {
  constructor(detail, { stage }) {
    super(detail);
    this.name = "PracticeLlmError";
    this.detail = detail;
    this.stage = stage;
    this.fallback_to_legacy = false;
  }
}

const PRACTICE_LLM_COMPARISON_MODELS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano"];

// workerdは"function or ExportedHandler"以外のトップレベルexportをエントリポイント候補として
// 扱い、モジュール読み込み時にエラーにする。定数はfunction越しに公開する。
export function practiceLlmComparisonModels() {
  return PRACTICE_LLM_COMPARISON_MODELS;
}
const DEFAULT_PRACTICE_COMPARISON_MODEL = PRACTICE_LLM_COMPARISON_MODELS[0];
const DEFAULT_PLAYBACK_PADDING_SECONDS = 0.3;
const PRACTICE_COMPARISON_ERROR_MESSAGE = "比較結果を作成できませんでした。もう一度お試しください。";

// この文言はローカルFastAPI版(src/mo_speech/practice_llm.py)と同一に保つ。
const PRACTICE_LLM_PROMPT = `あなたは発音練習アプリの比較・採点処理です。入力された目標文、お手本ASR、復唱ASRだけを根拠に、UI表示とフレーズ比較再生にそのまま使える完成JSONを返してください。

規則:
- 目標文を意味と文法のまとまりでフレーズ分割する。フレーズのtarget_textを順に連結すると、空白・句読点を含めて元のtarget_textと完全一致すること。
- reference_asr.wordsとattempt_asr.wordsの配列位置を使う。word_start_indexは0始まりinclusive、word_end_indexはexclusive。
- referenceとattemptの各範囲はフレーズ順に並べ、前のフレーズと重複させない。
- 対応できる連続範囲だけをassignedまたはpartialにする。対応できない場合はmissingとし、word_start_indexとword_end_indexをnullにする。
- 復唱が目標と異なる場合も、誤って発話した語を含む対応発話全体を選ぶ。目標と一致した末尾だけへ狭めない。
- 一致文字列と再生時刻はアプリ側が選択した位置番号から直接計算するため、返す必要はない。word_start_index/word_end_indexで対応範囲を正確に選ぶことだけに集中する。
- scoreとoverall_scoreは0から100の整数。ASRで認識された内容と目標文の一致を評価する。声調や発音などASR文字列から分からないことを断定しない。
- commentとoverall_commentは日本語で簡潔に書く。
- アプリ側で意味判断や採点を作り直す必要がない完成結果を返す。
- schema以外の説明を出力しない。
`;

export function practiceLlmPromptText() {
  return PRACTICE_LLM_PROMPT;
}

function practiceLlmRangeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "word_start_index", "word_end_index"],
    properties: {
      status: { type: "string", enum: ["assigned", "partial", "missing"] },
      word_start_index: { type: ["integer", "null"] },
      word_end_index: { type: ["integer", "null"] },
    },
  };
}

const PRACTICE_LLM_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "overall_score", "overall_comment", "phrases"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    overall_score: { type: "integer", minimum: 0, maximum: 100 },
    overall_comment: { type: "string" },
    phrases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phrase_index", "target_text", "score", "comment", "reference", "attempt"],
        properties: {
          phrase_index: { type: "integer", minimum: 0 },
          target_text: { type: "string", minLength: 1 },
          score: { type: "integer", minimum: 0, maximum: 100 },
          comment: { type: "string" },
          reference: practiceLlmRangeSchema(),
          attempt: practiceLlmRangeSchema(),
        },
      },
    },
  },
};

export function supportedPracticeComparisonModel(value) {
  const model = String(value || DEFAULT_PRACTICE_COMPARISON_MODEL).trim();
  if (!PRACTICE_LLM_COMPARISON_MODELS.includes(model)) {
    throw httpError(400, "unsupported practice comparison model");
  }
  return model;
}

export function validatePlaybackPaddingSeconds(value) {
  const trimmed = String(value ?? "").trim();
  const padding = trimmed === "" ? DEFAULT_PLAYBACK_PADDING_SECONDS : Number(value);
  if (!Number.isFinite(padding)) {
    throw httpError(400, "playback padding must be a number");
  }
  const roundedSteps = Math.round(padding / 0.05);
  if (padding < 0 || padding > 0.5 || Math.abs(padding - roundedSteps * 0.05) > 1e-9) {
    throw httpError(400, "playback padding must be between 0.00 and 0.50 in 0.05 increments");
  }
  return Math.round(padding * 100) / 100;
}

export function buildPracticeLlmInput({
  targetLanguage,
  targetText,
  paddingSeconds,
  referenceAudioDuration,
  attemptAudioDuration,
  referenceAsr,
  attemptAsr,
}) {
  return {
    target_language: targetLanguage,
    target_text: targetText,
    padding_seconds: paddingSeconds,
    reference_audio_duration: referenceAudioDuration,
    attempt_audio_duration: attemptAudioDuration,
    reference_asr: referenceAsr,
    attempt_asr: attemptAsr,
  };
}

function practiceLlmPhrasesReconstructTarget(phrases, targetText) {
  // LLMが各フレーズの先頭・末尾へ空白を配分しない場合だけ許容する。
  // フレーズ内部は原文と完全一致させ、"an ice"と"a nice"のような
  // 単語境界の変更を空白除去で同一視しない。
  let cursor = 0;
  for (const phrase of phrases) {
    const phraseCore = String(phrase?.target_text || "").trim();
    if (!phraseCore) return false;
    while (cursor < targetText.length && /\s/u.test(targetText[cursor])) cursor += 1;
    if (!targetText.startsWith(phraseCore, cursor)) return false;
    cursor += phraseCore.length;
  }
  return targetText.slice(cursor).trim() === "";
}

function practiceLlmRequiredFiniteNumber(value, label) {
  if (typeof value === "boolean") {
    throw new PracticeLlmError(`${label} is invalid`, { stage: "validate_response" });
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new PracticeLlmError(`${label} is invalid`, { stage: "validate_response" });
  }
  return number;
}

function practiceLlmValidateScore(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new PracticeLlmError(`${label} is invalid`, { stage: "validate_response" });
  }
}

function practiceLlmValidateRange(value, asrValue, { duration, padding, label }) {
  if (!value || typeof value !== "object" || !asrValue || typeof asrValue !== "object") {
    throw new PracticeLlmError(`${label} range is invalid`, { stage: "validate_response" });
  }
  const words = asrValue.words;
  if (!Array.isArray(words)) {
    throw new PracticeLlmError(`${label} words are invalid`, { stage: "validate_response" });
  }
  const status = value.status;
  const startIndex = value.word_start_index;
  const endIndex = value.word_end_index;
  if (status === "missing") {
    if ((startIndex ?? null) !== null || (endIndex ?? null) !== null) {
      throw new PracticeLlmError(`${label} missing range has word indexes`, { stage: "validate_response" });
    }
    value.matched_text = "";
    value.start = null;
    value.end = null;
    value.playback_start = null;
    value.playback_end = null;
    return;
  }
  if (status !== "assigned" && status !== "partial") {
    throw new PracticeLlmError(`${label} status is invalid`, { stage: "validate_response" });
  }
  if (
    typeof startIndex !== "number" ||
    !Number.isInteger(startIndex) ||
    typeof endIndex !== "number" ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex <= startIndex ||
    endIndex > words.length
  ) {
    throw new PracticeLlmError(`${label} word range is invalid`, { stage: "validate_response" });
  }
  const selected = words.slice(startIndex, endIndex);
  if (!selected.length || selected.some((word) => !word || typeof word !== "object")) {
    throw new PracticeLlmError(`${label} selected words are invalid`, { stage: "validate_response" });
  }

  // start/end/playback_start/playback_endはword_start_index/word_end_indexが決まれば
  // 一意に定まる値なので、LLMには転記させずここで直接計算する。ローカルFastAPI版
  // (practice_llm.py)と同じ設計。詳細はdocs/speech-translation/ROADMAP.mdを参照。
  const start = practiceLlmRequiredFiniteNumber(selected[0].start, `${label} word start`);
  const end = practiceLlmRequiredFiniteNumber(selected[selected.length - 1].end, `${label} word end`);
  const audioDuration = practiceLlmRequiredFiniteNumber(duration, `${label} audio duration`);
  const playbackStart = Math.max(0, start - padding);
  const playbackEnd = Math.min(audioDuration, end + padding);
  if (playbackEnd <= playbackStart) {
    throw new PracticeLlmError(`${label} playback range is empty`, { stage: "validate_response" });
  }

  value.matched_text = selected.map((word) => String(word.text || "")).join("");
  value.start = start;
  value.end = end;
  value.playback_start = playbackStart;
  value.playback_end = playbackEnd;
}

export function validatePracticeLlmResult(value, inputPayload) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PracticeLlmError("response is not an object", { stage: "validate_response" });
  }
  const result = structuredClone(value);
  if (result.schema_version !== 1) {
    throw new PracticeLlmError("unsupported schema_version", { stage: "validate_response" });
  }
  practiceLlmValidateScore(result.overall_score, "overall_score");
  if (typeof result.overall_comment !== "string") {
    throw new PracticeLlmError("overall_comment is invalid", { stage: "validate_response" });
  }
  const phrases = result.phrases;
  if (!Array.isArray(phrases) || phrases.length === 0) {
    throw new PracticeLlmError("phrases is empty", { stage: "validate_response" });
  }
  const indices = phrases.map((phrase) => (phrase && typeof phrase === "object" ? phrase.phrase_index : null));
  const expectedIndices = phrases.map((_, index) => index);
  if (JSON.stringify(indices) !== JSON.stringify(expectedIndices)) {
    throw new PracticeLlmError("phrase_index must be sequential", { stage: "validate_response" });
  }
  if (!practiceLlmPhrasesReconstructTarget(phrases, String(inputPayload?.target_text || ""))) {
    throw new PracticeLlmError("target phrases do not reconstruct target_text", { stage: "validate_response" });
  }

  const padding = practiceLlmRequiredFiniteNumber(inputPayload?.padding_seconds, "padding_seconds");
  const previousWordEnds = { reference: 0, attempt: 0 };
  for (const phrase of phrases) {
    if (!phrase || typeof phrase !== "object" || !String(phrase.target_text || "")) {
      throw new PracticeLlmError("phrase is invalid", { stage: "validate_response" });
    }
    practiceLlmValidateScore(phrase.score, "phrase score");
    if (typeof phrase.comment !== "string") {
      throw new PracticeLlmError("phrase comment is invalid", { stage: "validate_response" });
    }
    for (const side of ["reference", "attempt"]) {
      const rangeValue = phrase[side];
      practiceLlmValidateRange(rangeValue, inputPayload?.[`${side}_asr`], {
        duration: inputPayload?.[`${side}_audio_duration`],
        padding,
        label: side,
      });
      if (rangeValue.status !== "missing") {
        if (rangeValue.word_start_index < previousWordEnds[side]) {
          throw new PracticeLlmError(`${side} word ranges overlap or are out of order`, {
            stage: "validate_response",
          });
        }
        previousWordEnds[side] = rangeValue.word_end_index;
      }
    }
  }
  return result;
}

function practiceLlmPlaybackAlignment(phrases, side) {
  const playbackPhrases = phrases.map((phrase) => {
    const selected = phrase?.[side];
    if (!selected || typeof selected !== "object") {
      throw new PracticeLlmError(`${side} phrase is invalid`, { stage: "validate_response" });
    }
    return {
      index: phrase.phrase_index,
      target_text: phrase.target_text,
      available: selected.status !== "missing",
      audio_start: selected.playback_start ?? null,
      audio_end: selected.playback_end ?? null,
      matched_text: selected.matched_text,
      status: selected.status,
    };
  });
  const playable = playbackPhrases.filter((phrase) => phrase.available === true).length;
  const complete = playable === playbackPhrases.length;
  return {
    alignment_contract_version: 2,
    outcome: "evaluated",
    available: playable > 0,
    target_phrase_count: playbackPhrases.length,
    playable_phrase_count: playable,
    all_phrases_playable: complete,
    complete,
    phrases: playbackPhrases,
  };
}

export function comparisonAlignmentsFromLlmResult(result) {
  const phrases = result.phrases;
  if (!Array.isArray(phrases)) {
    throw new PracticeLlmError("phrases is invalid", { stage: "validate_response" });
  }
  return [practiceLlmPlaybackAlignment(phrases, "attempt"), practiceLlmPlaybackAlignment(phrases, "reference")];
}

export function practiceAudioDurationSeconds(transcription) {
  const duration = Number(transcription?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  const words = Array.isArray(transcription?.words) ? transcription.words : [];
  let max = 0;
  for (const word of words) {
    const end = Number(word?.end);
    if (Number.isFinite(end) && end > max) {
      max = end;
    }
  }
  return max;
}

export async function callPracticeLlmService(env, { model, inputPayload }) {
  const selectedModel = supportedPracticeComparisonModel(model);
  let stage = "call_api";
  try {
    const response = await runtimeFetch(env)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        instructions: PRACTICE_LLM_PROMPT,
        input: JSON.stringify(inputPayload),
        text: {
          format: {
            type: "json_schema",
            name: "speakloop_practice_comparison",
            strict: true,
            schema: PRACTICE_LLM_RESULT_SCHEMA,
          },
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PracticeLlmError(
        body?.error?.message || body?.error || `OpenAI request failed: ${response.status}`,
        { stage },
      );
    }
    const outputText = textFromOpenAiResponse(body);
    stage = "parse_response";
    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      throw new PracticeLlmError(`invalid JSON from model: ${errorMessage(error)}`, { stage });
    }
    stage = "validate_response";
    const result = validatePracticeLlmResult(parsed, inputPayload);
    return { result };
  } catch (error) {
    if (error instanceof PracticeLlmError) {
      throw error;
    }
    throw new PracticeLlmError(errorMessage(error), { stage });
  }
}

function practiceLlmErrorEnvelope(error) {
  return {
    error: {
      code: "practice_llm_failed",
      stage: error.stage,
      message: PRACTICE_COMPARISON_ERROR_MESSAGE,
      retryable: true,
      fallback_to_legacy: false,
    },
  };
}

async function savePracticeAttemptLlmOptions(env, jobId, options) {
  if (!jobId) {
    return;
  }
  const kv = stateKv(env);
  if (kv) {
    await kv.put(`${PRACTICE_LLM_ATTEMPT_OPTIONS_KV_PREFIX}${jobId}`, JSON.stringify(options), {
      expirationTtl: numberFromEnv(
        env.CLOUDFLARE_PRACTICE_LLM_OPTIONS_TTL_SECONDS,
        PRACTICE_LLM_ATTEMPT_OPTIONS_DEFAULT_TTL_SECONDS,
      ),
    });
  } else {
    ephemeralPracticeAttemptLlmOptions.set(jobId, options);
  }
}

async function readPracticeAttemptLlmOptions(env, jobId) {
  const kv = stateKv(env);
  if (kv) {
    return kvGetJson(kv, `${PRACTICE_LLM_ATTEMPT_OPTIONS_KV_PREFIX}${jobId}`, null);
  }
  return ephemeralPracticeAttemptLlmOptions.get(jobId) || null;
}

async function savePracticeAttemptResult(env, jobId, result) {
  if (!jobId) {
    return;
  }
  const kv = stateKv(env);
  if (kv) {
    await kv.put(`${PRACTICE_ATTEMPT_RESULT_KV_PREFIX}${jobId}`, JSON.stringify(result), {
      expirationTtl: numberFromEnv(
        env.CLOUDFLARE_PRACTICE_LLM_OPTIONS_TTL_SECONDS,
        PRACTICE_LLM_ATTEMPT_OPTIONS_DEFAULT_TTL_SECONDS,
      ),
    });
  } else {
    ephemeralPracticeAttemptResults.set(jobId, result);
  }
}

async function readPracticeAttemptResult(env, jobId) {
  const kv = stateKv(env);
  if (kv) {
    return kvGetJson(kv, `${PRACTICE_ATTEMPT_RESULT_KV_PREFIX}${jobId}`, null);
  }
  return ephemeralPracticeAttemptResults.get(jobId) || null;
}

function practiceModelAsrCacheKey(digest, model, sourceLanguage) {
  return `${PRACTICE_MODEL_ASR_CACHE_KV_PREFIX}${model}:${sourceLanguage}:${digest}`;
}

function practiceAsrHasSpeech(transcription) {
  const timestamps = serializeAsrTimestamps(transcription || {});
  return Boolean(
    String(transcription?.text || "").trim()
    || (timestamps?.words || []).length
    || (timestamps?.segments || []).length
  );
}

async function lookupPracticeModelAsrCache(env, key) {
  const kv = stateKv(env);
  const cached = kv ? await kvGetJson(kv, key, null) : ephemeralPracticeModelAsrCache.get(key) || null;
  return practiceAsrHasSpeech(cached) ? cached : null;
}

async function storePracticeModelAsrCache(env, key, transcription) {
  if (!practiceAsrHasSpeech(transcription)) {
    return;
  }
  const kv = stateKv(env);
  if (kv) {
    await kv.put(key, JSON.stringify(transcription), {
      expirationTtl: numberFromEnv(env.CLOUDFLARE_PRACTICE_MODEL_ASR_CACHE_TTL_SECONDS, 3600),
    });
  } else {
    ephemeralPracticeModelAsrCache.set(key, transcription);
  }
}

async function cachedPracticeModelTranscription(env, { audioBytes, audioMimeType, sourceLanguage, filename, model }) {
  // お手本音声は同じ目標文への再挑戦のたびに同じ内容で送られてくる。同一音声・
  // 言語・モデルの組で結果は変わらないため、復唱のたびにASRを再実行せず
  // KV(ローカル開発時はメモリ)キャッシュを再利用する。復唱(attempt)音声は
  // 毎回新しい録音なのでキャッシュしない。
  const digest = bufferToHex(await crypto.subtle.digest("SHA-256", audioBytes));
  const key = practiceModelAsrCacheKey(digest, model, sourceLanguage);
  const cached = await lookupPracticeModelAsrCache(env, key);
  if (cached) {
    return cached;
  }
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage,
    filename,
    model,
    includeTimestamps: true,
  });
  await storePracticeModelAsrCache(env, key, transcription);
  return transcription;
}

async function lookupRunpodPracticeModelAsrCache(env, { audioBytes, sourceLanguage }) {
  // 中国語(RunPod FunASR経由)のお手本音声も、OpenAI経路と同じKV(ローカル開発時は
  // メモリ)キャッシュ空間を使う。modelにはOpenAIのモデル名と衝突しないRunPod
  // provider名を使い、同じ音声でもproviderが違えば別キーになるようにする。
  const digest = bufferToHex(await crypto.subtle.digest("SHA-256", audioBytes));
  const key = practiceModelAsrCacheKey(digest, "runpod-funasr-paraformer-zh", sourceLanguage);
  const cached = await lookupPracticeModelAsrCache(env, key);
  return { key, cached };
}

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

const DEFAULT_PUBLIC_ACCESS_SETTINGS = {
  google_login_required: false,
  admin_google_emails: [],
  features: {
    speakloop: {
      daily_limit: 20,
      total_limit: 200,
      audio_max_bytes: 8_000_000,
      text_max_chars: 800,
    },
    skitvoice: {
      daily_limit: 2,
      total_limit: 20,
      audio_max_bytes: 10_000_000,
      script_max_chars: 1600,
    },
    fun: {
      daily_limit: 10,
      total_limit: 100,
      audio_max_bytes: 8_000_000,
      text_max_chars: 1000,
    },
    voice_conversion: {
      daily_limit: 3,
      total_limit: 30,
      audio_max_bytes: 10_000_000,
      text_max_chars: 0,
    },
  },
};

const DEFAULT_PUBLIC_SAMPLE_AUDIOS = {
  features: {
    speakloop: null,
    skitvoice: null,
    fun: null,
    voice_conversion: null,
  },
};

let ephemeralUserSettings = null;
let ephemeralPublicAccessSettings = null;
const ephemeralTranslationJobs = new Map();
const ephemeralPracticeAttemptLlmOptions = new Map();
const ephemeralPracticeAttemptResults = new Map();
const ephemeralPracticeModelAsrCache = new Map();
const ephemeralPublicUsage = new Map();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env) {
    await runPublicDataRetention(env, new Date(controller.scheduledTime));
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (isPublicAuthPath(url.pathname)) {
    return handlePublicAuthRequest(request, env, url);
  }
  if (url.pathname.startsWith("/api/")) {
    if (isProtectedAdminApiRequest(request.method, url.pathname)) {
      const authResponse = await adminApiAuthResponse(request, env);
      if (authResponse) {
        return authResponse;
      }
    }
    return handleApiRequest(request, env, ctx, url);
  }
  if (isProtectedAdminPagePath(url.pathname)) {
    const authResponse = await adminPageAuthResponse(request, env, url);
    if (authResponse) {
      return authResponse;
    }
  }
  return serveAsset(request, env, url);
}

function isPublicAuthPath(pathname) {
  const path = normalizePathname(pathname);
  return path === "/auth/google/login" || path === "/auth/google/callback" || path === "/auth/logout";
}

function isProtectedAdminPagePath(pathname) {
  const path = normalizePathname(pathname);
  return new Set([
    "/fun",
    "/admin",
    "/index.html",
    "/static/index.html",
    "/skitvoice/admin",
    "/static/vibevoice.html",
    "/speakloop/admin",
    "/practice_admin.html",
    "/static/practice_admin.html",
  ]).has(path);
}

function isProtectedAdminApiRequest(method, pathname) {
  if (method === "OPTIONS") {
    return false;
  }
  if (pathname === "/api/vibevoice" || pathname.startsWith("/api/vibevoice/")) {
    return true;
  }
  if (method === "PUT" && pathname === "/api/user-settings") {
    return true;
  }
  if ((method === "GET" || method === "PUT") && pathname === "/api/public-access-settings") {
    return true;
  }
  if (method === "PUT" && pathname === "/api/public-sample-audios") {
    return true;
  }
  if (method === "DELETE" && pathname.startsWith("/api/public-sample-audios/")) {
    return true;
  }
  if (method === "GET" && pathname === "/api/audio-history") {
    return true;
  }
  if (method === "GET" && pathname === "/api/practice-history") {
    return true;
  }
  if (method === "GET" && pathname === "/api/public-audit-log") {
    return true;
  }
  if (method === "POST" && pathname === "/api/warmup") {
    return true;
  }
  if (method === "GET" && pathname.startsWith("/api/warmup/")) {
    return true;
  }
  if (method === "GET" && /^\/api\/translate-speech-jobs\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (method === "GET" && /^\/api\/voice-conversion-jobs\/[^/]+$/.test(pathname)) {
    return true;
  }
  return false;
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

async function adminPageAuthResponse(request, env, url) {
  const settings = await readPublicAccessSettings(env);
  if (!adminAuthConfigured(env, settings)) {
    return adminSetupErrorResponse();
  }
  const session = await readPublicSession(request, env);
  if (!session) {
    return redirectResponse(`/auth/google/login?next=${encodeURIComponent(url.pathname)}`);
  }
  if (isPublicAdminEmail(session.email, settings)) {
    return null;
  }
  return adminAccessDeniedResponse(session.email);
}

async function adminApiAuthResponse(request, env) {
  const settings = await readPublicAccessSettings(env);
  if (!adminAuthConfigured(env, settings)) {
    return jsonResponse({ detail: "admin authentication is not configured" }, { status: 503 });
  }
  const session = await readPublicSession(request, env);
  if (!session) {
    return jsonResponse({ detail: "admin authentication required" }, { status: 401 });
  }
  if (!isPublicAdminEmail(session.email, settings)) {
    return jsonResponse({ detail: "admin access is forbidden" }, { status: 403 });
  }
  return null;
}

function adminAuthConfigured(env, settings) {
  return Boolean(publicGoogleAuthConfigured(env) && settings.admin_google_emails.length > 0);
}

function adminSetupErrorResponse() {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>管理認証が未設定 | Voice Lab</title><style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;margin:0;min-height:100svh;display:grid;place-items:center;background:#f5f3ee;color:#182235}main{box-sizing:border-box;width:min(90vw,520px);padding:28px;background:#fff;border:1px solid #d9d8d3;border-radius:20px;box-shadow:0 24px 70px #1e27391a}.brand{color:#66748a;font-size:12px;font-weight:800;letter-spacing:.14em}h1{font-size:26px;margin:8px 0 12px}p{color:#5c687b;line-height:1.7}@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#1f2937;border-color:#374151}p{color:#cbd5e1}}</style><main><div class=\"brand\">VOICE LAB · ADMIN</div><h1>管理認証が未設定です</h1><p>Google OAuth用のsecretと、ADMIN_GOOGLE_EMAILSに管理者のGoogleメールを設定してください。</p></main>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function adminAccessDeniedResponse(email) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理画面へのアクセス権がありません | Voice Lab</title><style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;margin:0;min-height:100svh;display:grid;place-items:center;background:#f5f3ee;color:#182235}main{box-sizing:border-box;width:min(90vw,520px);padding:28px;background:#fff;border:1px solid #d9d8d3;border-radius:20px;box-shadow:0 24px 70px #1e27391a}.brand{color:#66748a;font-size:12px;font-weight:800;letter-spacing:.14em}h1{font-size:26px;margin:8px 0 12px}p{color:#5c687b;line-height:1.7;overflow-wrap:anywhere}a{color:#274f8a;font-weight:700}@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#1f2937;border-color:#374151}p{color:#cbd5e1}a{color:#93c5fd}}</style><main><div class="brand">VOICE LAB · ADMIN</div><h1>管理画面へのアクセス権がありません</h1><p>${escapeHtml(email)} は管理者として登録されていません。</p><a href="/auth/logout?next=/">別のGoogleアカウントでログイン</a></main>`,
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function handlePublicAuthRequest(request, env, url) {
  try {
    const path = normalizePathname(url.pathname);
    if (path === "/auth/logout") {
      const session = await readPublicSession(request, env);
      if (session) {
        await appendPublicAuditEvent(env, {
          action: "google_logout",
          email: session.email,
          ...requestAuditContext(request),
        });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: safePublicNextPath(url.searchParams.get("next") || "/"),
          "Set-Cookie": expiredCookie(PUBLIC_SESSION_COOKIE),
        },
      });
    }
    if (!publicGoogleAuthConfigured(env)) {
      return jsonResponse({ detail: "Google login is not configured" }, { status: 503 });
    }
    if (path === "/auth/google/login") {
      return createGoogleLoginRedirect(env, url);
    }
    if (path === "/auth/google/callback") {
      return handleGoogleCallback(request, env, url);
    }
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

function publicGoogleAuthConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && publicSessionSecret(env));
}

function publicSessionSecret(env) {
  return String(env.PUBLIC_SESSION_SECRET || "").trim();
}

async function createGoogleLoginRedirect(env, url) {
  const next = safePublicNextPath(url.searchParams.get("next") || "/");
  const now = Math.floor(Date.now() / 1000);
  const state = await createSignedPayload({
    next,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + PUBLIC_OAUTH_STATE_TTL_SECONDS,
  }, publicSessionSecret(env));
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri(url));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `${PUBLIC_OAUTH_STATE_COOKIE}=${state}; Path=/; Max-Age=${PUBLIC_OAUTH_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function handleGoogleCallback(request, env, url) {
  const code = String(url.searchParams.get("code") || "");
  const state = String(url.searchParams.get("state") || "");
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const stateCookie = cookies.get(PUBLIC_OAUTH_STATE_COOKIE) || "";
  if (!code || !state || !stateCookie || !constantTimeEqual(state, stateCookie)) {
    throw httpError(400, "invalid Google OAuth state");
  }
  const statePayload = await verifySignedPayload(state, publicSessionSecret(env));
  const token = await exchangeGoogleOAuthCode(env, code, googleRedirectUri(url));
  const userInfo = await fetchGoogleUserInfo(env, token.access_token);
  const email = normalizeEmail(userInfo.email);
  if (!email || userInfo.email_verified === false) {
    throw httpError(403, "Google account email is not verified");
  }
  const sessionCookie = await createPublicSessionCookie(env, {
    email,
    name: String(userInfo.name || ""),
    picture: String(userInfo.picture || ""),
  });
  const settings = await readPublicAccessSettings(env);
  await recordPublicUserLogin(env, email);
  await appendPublicAuditEvent(env, {
    action: "google_login_success",
    email,
    is_admin: isPublicAdminEmail(email, settings),
    next: safePublicNextPath(statePayload.next || "/"),
    ...requestAuditContext(request),
  });
  const headers = new Headers({ Location: safePublicNextPath(statePayload.next || "/") });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", expiredCookie(PUBLIC_OAUTH_STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function exchangeGoogleOAuthCode(env, code, redirectUri) {
  const response = await runtimeFetch(env)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw httpError(response.status || 502, body.error_description || body.error || "Google OAuth token exchange failed");
  }
  return body;
}

async function fetchGoogleUserInfo(env, accessToken) {
  const response = await runtimeFetch(env)("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, body.error_description || body.error || "Google userinfo request failed");
  }
  return body;
}

function googleRedirectUri(url) {
  return new URL("/auth/google/callback", url.origin).toString();
}

function safePublicNextPath(next) {
  if (!next || !String(next).startsWith("/") || String(next).startsWith("//")) {
    return "/";
  }
  try {
    const parsed = new URL(String(next), "https://example.com");
    const path = normalizePathname(parsed.pathname);
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      return "/";
    }
    if (path === "/index.html" || path.startsWith("/static/")) {
      return isProtectedAdminPagePath(path) ? path : "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

async function createPublicSessionCookie(env, user) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.PUBLIC_SESSION_TTL_SECONDS || PUBLIC_SESSION_TTL_SECONDS) || PUBLIC_SESSION_TTL_SECONDS;
  const value = await createSignedPayload({
    email: normalizeEmail(user.email),
    iat: now,
    exp: now + ttl,
  }, publicSessionSecret(env));
  return `${PUBLIC_SESSION_COOKIE}=${value}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`;
}

async function readPublicSession(request, env) {
  const secret = publicSessionSecret(env);
  if (!secret) {
    return null;
  }
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const value = cookies.get(PUBLIC_SESSION_COOKIE);
  if (!value) {
    return null;
  }
  try {
    const payload = await verifySignedPayload(value, secret);
    const email = normalizeEmail(payload.email);
    if (!email) {
      return null;
    }
    return {
      email,
      name: String(payload.name || ""),
      picture: String(payload.picture || ""),
      exp: Number(payload.exp || 0),
    };
  } catch {
    return null;
  }
}

async function createSignedPayload(payload, secret) {
  const encoded = base64UrlEncodeString(JSON.stringify(payload || {}));
  const signature = await hmacSha256Hex(encoded, secret);
  return `${encoded}.${signature}`;
}

async function verifySignedPayload(value, secret) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) {
    throw httpError(400, "invalid signed payload");
  }
  const expectedSignature = await hmacSha256Hex(payload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw httpError(400, "invalid signed payload");
  }
  const parsed = JSON.parse(base64UrlDecodeToString(payload));
  if (Number(parsed.exp || 0) <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, "signed payload expired");
  }
  return parsed;
}

function expiredCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies.set(name, valueParts.join("="));
  }
  return cookies;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bufferToHex(digest);
}

async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return bufferToHex(signature);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function base64UrlEncodeString(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    if (request.method === "GET" && url.pathname === "/api/public-session") {
      return jsonResponse(await publicSessionPayload(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/public-sample-audios") {
      return jsonResponse(await publicSampleAudiosPayload(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/public-access-settings") {
      return jsonResponse(await readPublicAccessSettings(env));
    }
    if (request.method === "PUT" && url.pathname === "/api/public-access-settings") {
      const payload = await request.json();
      const settings = await writePublicAccessSettings(payload, env);
      await appendPublicAuditEvent(env, {
        action: "public_access_settings_updated",
        ...requestAuditContext(request),
      });
      return jsonResponse(settings);
    }
    if (request.method === "GET" && url.pathname === "/api/public-audit-log") {
      return jsonResponse(await readPublicAuditLog(env, url));
    }
    if (request.method === "PUT" && url.pathname === "/api/public-sample-audios") {
      const payload = await request.json();
      const samples = await writePublicSampleAudios(payload, env);
      await appendPublicAuditEvent(env, {
        action: "public_sample_audios_updated",
        ...requestAuditContext(request),
      });
      return jsonResponse(samples);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/public-sample-audios/")) {
      const feature = decodeURIComponent(url.pathname.slice("/api/public-sample-audios/".length));
      const samples = await deletePublicSampleAudioFeature(feature, env, url.searchParams.get("language") || "");
      await appendPublicAuditEvent(env, {
        action: "public_sample_audio_deleted",
        feature,
        ...requestAuditContext(request),
      });
      return jsonResponse(samples);
    }
    if (request.method === "GET" && url.pathname === "/api/audio-history") {
      return jsonResponse(await listAudioHistory(env));
    }
    if (request.method === "GET" && url.pathname === "/api/practice-history") {
      return jsonResponse(await listPracticeHistory(env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-display-text") {
      const payload = await request.json();
      const text = String(payload.text || "").trim();
      const targetLanguage = String(payload.target_language || "ja-JP");
      if (text && targetLanguage === "ja-JP") {
        await enforcePublicFeatureAccess(request, env, "fun", { textChars: text.length });
      }
      return jsonResponse(await createUserDisplayText(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-text-output") {
      const payload = await request.json();
      await enforcePublicFeatureAccess(request, env, "fun", {
        textChars: String(payload.translated_text || "").trim().length,
      });
      return jsonResponse(await createUserTextOutput(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-joke-output") {
      const payload = await request.json();
      await enforcePublicFeatureAccess(request, env, "fun", {
        textChars: String(payload.text || "").trim().length,
      });
      return jsonResponse(await createUserJokeOutput(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/prompts") {
      return jsonResponse(await createPracticePrompt(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/recordings") {
      return jsonResponse(await createPracticeRecording(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/attempt-jobs") {
      const snapshot = await createPracticeAttemptJob(request, env);
      const status = snapshot.status === "queued" || snapshot.status === "running" ? 202 : 200;
      return jsonResponse(snapshot, { status });
    }
    if (request.method === "GET" && /^\/api\/practice\/attempt-jobs\/[^/]+$/.test(url.pathname)) {
      await requirePublicFeaturePollingAccess(request, env, "speakloop");
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getPracticeAttemptJob(jobId, env));
    }
    if (request.method === "GET" && /^\/api\/practice\/voice-jobs\/[^/]+$/.test(url.pathname)) {
      await requirePublicFeaturePollingAccess(request, env, "speakloop");
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "voice_conversion"));
    }
    if (request.method === "GET" && url.pathname === "/api/vibevoice/status") {
      return jsonResponse(await vibeVoiceStatus(env));
    }
    if (request.method === "POST" && url.pathname === "/api/vibevoice/reference-audio-from-url") {
      return jsonResponse(await createVibeVoiceReferenceAudioFromUrl(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/vibevoice/scripts") {
      return jsonResponse(await createVibeVoiceScript(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/vibevoice/jobs") {
      return jsonResponse(await createVibeVoiceJob(request, env));
    }
    if (request.method === "GET" && /^\/api\/vibevoice\/jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "vibevoice"));
    }
    if (request.method === "POST" && /^\/api\/vibevoice\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const jobId = decodeURIComponent(parts[parts.length - 2] || "");
      return jsonResponse(await cancelRunpodJob(jobId, env, "vibevoice"));
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
    if (error instanceof PracticeAlignmentInputError) {
      return jsonResponse(practiceAlignmentErrorEnvelope(error), { status: 400 });
    }
    if (error instanceof PracticeAlignmentError) {
      return jsonResponse(practiceAlignmentErrorEnvelope(error), { status: 502 });
    }
    if (error instanceof PracticeLlmError) {
      return jsonResponse(practiceLlmErrorEnvelope(error), { status: 502 });
    }
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return new Response("Cloudflare static assets binding is not configured.", { status: 503 });
  }
  const assetUrl = new URL(request.url);
  const retiredPaths = new Set([
    "/user",
    "/vibevoice",
    "/vibevoice/simple",
    "/vibevoice/admin",
    "/seed-vc",
    "/user.html",
    "/vibevoice.html",
    "/vibevoice_simple.html",
    "/seed_vc.html",
    "/static/user.html",
    "/static/vibevoice_simple.html",
    "/static/seed_vc.html",
  ]);
  if (retiredPaths.has(normalizePathname(url.pathname))) {
    return new Response("Not Found", { status: 404 });
  }
  if (url.pathname === "/") {
    assetUrl.pathname = "/react/portal.html";
  } else if (url.pathname === "/privacy" || url.pathname === "/privacy/") {
    assetUrl.pathname = "/react/privacy.html";
  } else if (url.pathname === "/fun" || url.pathname === "/fun/") {
    assetUrl.pathname = "/user.html";
  } else if (url.pathname === "/speakloop" || url.pathname === "/speakloop/") {
    assetUrl.pathname = "/react/speakloop.html";
  } else if (
    url.pathname === "/speakloop/admin" ||
    url.pathname === "/speakloop/admin/"
  ) {
    assetUrl.pathname = "/practice_admin.html";
  } else if (
    url.pathname === "/skitvoice" ||
    url.pathname === "/skitvoice/"
  ) {
    assetUrl.pathname = "/react/skitvoice.html";
  } else if (
    url.pathname === "/skitvoice/admin" ||
    url.pathname === "/skitvoice/admin/"
  ) {
    assetUrl.pathname = "/vibevoice.html";
  } else if (url.pathname === "/admin" || url.pathname === "/admin/") {
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
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    supported_voice_modes: ["default", "convert"],
    ui_capabilities: {
      practice_developer_settings: false,
      practice_history_preview: false,
    },
    translation_backends: [
      {
        id: "openai",
        label: "音声翻訳（Cloudflare + OpenAI API）",
        available: openaiAvailable,
        reason: openaiAvailable ? "" : "OPENAI_API_KEY が設定されていません。",
        providers: {
          asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
          translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
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

async function readPublicAccessSettings(env) {
  const kv = stateKv(env);
  let stored = null;
  if (kv) {
    stored = await kvGetJson(kv, PUBLIC_ACCESS_SETTINGS_KV_KEY, null);
  } else if (ephemeralPublicAccessSettings) {
    stored = ephemeralPublicAccessSettings;
  } else if (env.PUBLIC_ACCESS_SETTINGS_JSON) {
    try {
      stored = JSON.parse(env.PUBLIC_ACCESS_SETTINGS_JSON);
    } catch (_error) {
      stored = null;
    }
  }
  const envDefaults = {
    google_login_required: env.PUBLIC_GOOGLE_AUTH_REQUIRED === "1",
    admin_google_emails: coerceEmailList(env.ADMIN_GOOGLE_EMAILS),
  };
  const settings = coercePublicAccessSettings(mergePublicAccessSettings(DEFAULT_PUBLIC_ACCESS_SETTINGS, envDefaults, stored || {}));
  settings.admin_google_emails = uniqueEmails([
    ...settings.admin_google_emails,
    ...coerceEmailList(env.ADMIN_GOOGLE_EMAILS),
  ]);
  return settings;
}

async function writePublicAccessSettings(payload, env) {
  const settings = coercePublicAccessSettings(payload);
  const kv = stateKv(env);
  if (kv) {
    await kv.put(PUBLIC_ACCESS_SETTINGS_KV_KEY, JSON.stringify(settings));
  } else {
    ephemeralPublicAccessSettings = settings;
  }
  return readPublicAccessSettings(env);
}

async function readPublicSampleAudios(env) {
  if (env.MO_SPEECH_DB && env.MO_SPEECH_AUDIO_R2) {
    const result = await env.MO_SPEECH_DB.prepare(
      "SELECT feature, language, title, description, filename, audio_mime_type, audio_r2_key, size_bytes FROM public_sample_audios ORDER BY feature, language",
    ).all();
    if ((result.results || []).length === 0 && stateKv(env)) {
      const legacy = await kvGetJson(stateKv(env), PUBLIC_SAMPLE_AUDIOS_KV_KEY, null);
      if (legacy && publicSampleRows(coercePublicSampleAudios(legacy)).length > 0) {
        return writePublicSampleAudios(legacy, env);
      }
    }
    const samples = coercePublicSampleAudios(DEFAULT_PUBLIC_SAMPLE_AUDIOS);
    samples.features.skitvoice = {
      samples: Object.fromEntries(PUBLIC_SAMPLE_LANGUAGES.map((language) => [language, null])),
    };
    for (const row of result.results || []) {
      const object = await env.MO_SPEECH_AUDIO_R2.get(row.audio_r2_key);
      if (!object || !PUBLIC_ACCESS_FEATURES.includes(row.feature)) continue;
      const sample = {
        title: row.title,
        description: row.description,
        filename: row.filename,
        audio_mime_type: row.audio_mime_type,
        audio_base64: bytesToBase64(new Uint8Array(await object.arrayBuffer())),
        size_bytes: Number(row.size_bytes || 0),
      };
      if (row.feature === "skitvoice" && row.language === "und") {
        samples.features.skitvoice.samples["ja-JP"] = sample;
      } else if (row.language && row.language !== "und") {
        samples.features[row.feature] ||= { samples: {} };
        samples.features[row.feature].samples ||= {};
        samples.features[row.feature].samples[row.language] = sample;
      } else {
        samples.features[row.feature] = sample;
      }
    }
    return samples;
  }
  const kv = stateKv(env);
  let stored = null;
  if (kv) {
    stored = await kvGetJson(kv, PUBLIC_SAMPLE_AUDIOS_KV_KEY, null);
  } else if (env.PUBLIC_SAMPLE_AUDIOS_JSON) {
    try {
      stored = JSON.parse(env.PUBLIC_SAMPLE_AUDIOS_JSON);
    } catch (_error) {
      stored = null;
    }
  }
  return coercePublicSampleAudios(stored || DEFAULT_PUBLIC_SAMPLE_AUDIOS);
}

async function publicSampleAudiosPayload(request, env) {
  const samples = await readPublicSampleAudios(env);
  const settings = await readPublicAccessSettings(env);
  const session = await readPublicSession(request, env);
  if (session && isPublicAdminEmail(session.email, settings)) {
    return samples;
  }
  const publicSamples = structuredClone(samples);
  publicSamples.features.skitvoice = null;
  return publicSamples;
}

async function writePublicSampleAudios(payload, env) {
  const samples = coercePublicSampleAudios(payload);
  if (env.MO_SPEECH_DB && env.MO_SPEECH_AUDIO_R2) {
    const existing = await env.MO_SPEECH_DB.prepare(
      "SELECT feature, language, audio_r2_key FROM public_sample_audios",
    ).all();
    const desired = publicSampleRows(samples);
    const desiredIds = new Set(desired.map((row) => `${row.feature}:${row.language}`));
    for (const row of existing.results || []) {
      if (!desiredIds.has(`${row.feature}:${row.language}`)) {
        await env.MO_SPEECH_DB.prepare("DELETE FROM public_sample_audios WHERE feature = ? AND language = ?")
          .bind(row.feature, row.language).run();
        await env.MO_SPEECH_AUDIO_R2.delete(row.audio_r2_key);
      }
    }
    for (const row of desired) {
      const r2Key = `public-samples/${row.feature}/${row.language}/${crypto.randomUUID()}-${row.sample.filename}`;
      const previous = (existing.results || []).find((item) => item.feature === row.feature && item.language === row.language);
      await env.MO_SPEECH_AUDIO_R2.put(r2Key, base64ToBytes(row.sample.audio_base64), {
        httpMetadata: { contentType: row.sample.audio_mime_type },
      });
      await env.MO_SPEECH_DB.prepare(
        "INSERT INTO public_sample_audios (feature, language, title, description, filename, audio_mime_type, audio_r2_key, size_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feature, language) DO UPDATE SET title = excluded.title, description = excluded.description, filename = excluded.filename, audio_mime_type = excluded.audio_mime_type, audio_r2_key = excluded.audio_r2_key, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at",
      ).bind(
        row.feature, row.language, row.sample.title, row.sample.description, row.sample.filename,
        row.sample.audio_mime_type, r2Key, row.sample.size_bytes, new Date().toISOString(),
      ).run();
      if (previous?.audio_r2_key && previous.audio_r2_key !== r2Key) {
        await env.MO_SPEECH_AUDIO_R2.delete(previous.audio_r2_key);
      }
    }
    return readPublicSampleAudios(env);
  }
  const kv = stateKv(env);
  if (kv) {
    await kv.put(PUBLIC_SAMPLE_AUDIOS_KV_KEY, JSON.stringify(samples));
  }
  return samples;
}

async function deletePublicSampleAudioFeature(feature, env, language = "") {
  if (!PUBLIC_ACCESS_FEATURES.includes(feature)) {
    throw httpError(404, "sample audio feature is not found");
  }
  const samples = await readPublicSampleAudios(env);
  if (language && samples.features[feature]?.samples) {
    samples.features[feature].samples[language] = null;
  } else {
    samples.features[feature] = null;
  }
  return writePublicSampleAudios(samples, env);
}

function coercePublicSampleAudios(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const features = source.features && typeof source.features === "object" ? source.features : source;
  const normalized = { features: {} };
  for (const feature of PUBLIC_ACCESS_FEATURES) {
    const raw = features[feature];
    if (raw?.samples && typeof raw.samples === "object") {
      normalized.features[feature] = { samples: {} };
      for (const language of PUBLIC_SAMPLE_LANGUAGES) {
        normalized.features[feature].samples[language] = coercePublicSampleAudio(raw.samples[language]);
      }
    } else {
      normalized.features[feature] = coercePublicSampleAudio(raw);
    }
  }
  return normalized;
}

function publicSampleRows(samples) {
  const rows = [];
  for (const feature of PUBLIC_ACCESS_FEATURES) {
    const value = samples.features[feature];
    if (value?.samples) {
      for (const language of PUBLIC_SAMPLE_LANGUAGES) {
        if (value.samples[language]) rows.push({ feature, language, sample: value.samples[language] });
      }
    } else if (value) {
      rows.push({ feature, language: feature === "skitvoice" ? "ja-JP" : "und", sample: value });
    }
  }
  return rows;
}

function coercePublicSampleAudio(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const audioBase64 = String(raw.audio_base64 || "").replace(/\s/g, "");
  if (!audioBase64) {
    return null;
  }
  if (audioBase64.length > PUBLIC_SAMPLE_AUDIO_MAX_BASE64_CHARS) {
    throw httpError(413, "sample audio is too large");
  }
  const mimeType = normalizeMimeType(raw.audio_mime_type || "audio/wav") || "audio/wav";
  if (!mimeType.startsWith("audio/")) {
    throw httpError(400, "sample audio MIME type is not supported");
  }
  return {
    title: String(raw.title || "").trim().slice(0, 80) || "サンプル音声",
    description: String(raw.description || "").trim().slice(0, 300),
    filename: safeHistoryToken(raw.filename || `sample.${extensionForMimeType(mimeType)}`),
    audio_mime_type: mimeType,
    audio_base64: audioBase64,
    size_bytes: base64ByteLength(audioBase64),
  };
}

function mergePublicAccessSettings(...items) {
  const merged = structuredClone(DEFAULT_PUBLIC_ACCESS_SETTINGS);
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(item, "google_login_required")) {
      merged.google_login_required = Boolean(item.google_login_required);
    }
    if (Object.prototype.hasOwnProperty.call(item, "admin_google_emails")) {
      merged.admin_google_emails = coerceEmailList(item.admin_google_emails);
    }
    const features = item.features && typeof item.features === "object" ? item.features : item;
    for (const feature of PUBLIC_ACCESS_FEATURES) {
      if (features[feature] && typeof features[feature] === "object") {
        merged.features[feature] = {
          ...merged.features[feature],
          ...features[feature],
        };
      }
    }
  }
  return merged;
}

function coercePublicAccessSettings(payload = {}) {
  const merged = mergePublicAccessSettings(DEFAULT_PUBLIC_ACCESS_SETTINGS, payload);
  const settings = {
    google_login_required: Boolean(merged.google_login_required),
    admin_google_emails: coerceEmailList(merged.admin_google_emails),
    features: {},
  };
  for (const feature of PUBLIC_ACCESS_FEATURES) {
    const defaults = DEFAULT_PUBLIC_ACCESS_SETTINGS.features[feature];
    const raw = merged.features[feature] || {};
    settings.features[feature] = {
      daily_limit: clampInt(raw.daily_limit, -1, 100000, defaults.daily_limit),
      total_limit: clampInt(raw.total_limit, -1, 1000000, defaults.total_limit),
      audio_max_bytes: clampInt(raw.audio_max_bytes, 0, 100_000_000, defaults.audio_max_bytes),
      text_max_chars: clampInt(raw.text_max_chars, 0, 100_000, defaults.text_max_chars || 0),
    };
    if (Object.prototype.hasOwnProperty.call(defaults, "script_max_chars")) {
      settings.features[feature].script_max_chars = clampInt(
        raw.script_max_chars,
        0,
        100_000,
        defaults.script_max_chars,
      );
    }
    if (Object.prototype.hasOwnProperty.call(defaults, "reference_url_duration_max_seconds")) {
      settings.features[feature].reference_url_duration_max_seconds = clampInt(
        raw.reference_url_duration_max_seconds,
        1,
        600,
        defaults.reference_url_duration_max_seconds,
      );
    }
  }
  return settings;
}

async function publicSessionPayload(request, env) {
  const settings = await readPublicAccessSettings(env);
  const session = await readPublicSession(request, env);
  const isAdmin = Boolean(session && isPublicAdminEmail(session.email, settings));
  return {
    google_login_required: Boolean(settings.google_login_required),
    google_login_configured: publicGoogleAuthConfigured(env),
    authenticated: Boolean(session),
    email: session?.email || "",
    name: session?.name || "",
    picture: session?.picture || "",
    is_admin: isAdmin,
    login_url: `/auth/google/login?next=${encodeURIComponent(new URL(request.url).pathname)}`,
    logout_url: "/auth/logout",
    features: isAdmin ? settings.features : { speakloop: settings.features.speakloop },
  };
}

function coerceEmailList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return uniqueEmails(source.map(normalizeEmail).filter(Boolean));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueEmails(values) {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))].slice(0, 100);
}

function isPublicAdminEmail(email, settings) {
  return settings.admin_google_emails.includes(normalizeEmail(email));
}

async function enforcePublicFeatureAccess(request, env, feature, limits = {}) {
  const settings = await readPublicAccessSettings(env);
  const featureSettings = settings.features[feature] || {};
  validatePublicInputLimits(featureSettings, limits);
  if (feature === "fun" || feature === "voice_conversion") {
    if (!adminAuthConfigured(env, settings)) {
      throw httpError(503, "admin authentication is not configured");
    }
    const session = await readPublicSession(request, env);
    if (!session) {
      throw httpError(401, "Google admin login is required");
    }
    if (!isPublicAdminEmail(session.email, settings)) {
      throw httpError(403, "admin access is forbidden");
    }
    await appendPublicAuditEvent(env, {
      action: "public_quota_exempt",
      email: session.email,
      feature,
      is_admin: true,
      ...requestAuditContext(request),
    });
    return { settings, consumed: false, authenticated: true, is_admin: true, email: session.email };
  }
  if (!settings.google_login_required) {
    return { settings, consumed: false, authenticated: false, is_admin: false };
  }
  if (!publicGoogleAuthConfigured(env)) {
    throw httpError(503, "Google login is not configured");
  }
  const session = await readPublicSession(request, env);
  if (!session) {
    throw httpError(401, "Google login is required");
  }
  const isAdmin = isPublicAdminEmail(session.email, settings);
  if (isAdmin) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_exempt",
      email: session.email,
      feature,
      is_admin: true,
      ...requestAuditContext(request),
    });
    return { settings, consumed: false, authenticated: true, is_admin: true, email: session.email };
  }
  await consumePublicQuota(env, feature, session.email, featureSettings, request);
  return { settings, consumed: true, authenticated: true, is_admin: false, email: session.email };
}

async function requirePublicFeaturePollingAccess(request, env, feature) {
  const settings = await readPublicAccessSettings(env);
  if (!settings.google_login_required) {
    return;
  }
  if (!publicGoogleAuthConfigured(env)) {
    throw httpError(503, "Google login is not configured");
  }
  const session = await readPublicSession(request, env);
  if (!session) {
    throw httpError(401, "Google login is required");
  }
  if (!settings.features[feature]) {
    throw httpError(400, `unsupported public feature: ${feature}`);
  }
}

function validatePublicInputLimits(featureSettings, limits) {
  const audioBytes = Number(limits.audioBytes || 0);
  const textChars = Number(limits.textChars || 0);
  const scriptChars = Number(limits.scriptChars || 0);
  const referenceUrlDurationSeconds = Number(limits.referenceUrlDurationSeconds || 0);
  if (featureSettings.audio_max_bytes > 0 && audioBytes > featureSettings.audio_max_bytes) {
    throw httpError(413, "audio is too large");
  }
  if (featureSettings.text_max_chars > 0 && textChars > featureSettings.text_max_chars) {
    throw httpError(413, "text is too large");
  }
  if (featureSettings.script_max_chars > 0 && scriptChars > featureSettings.script_max_chars) {
    throw httpError(413, "script is too large");
  }
  if (
    featureSettings.reference_url_duration_max_seconds > 0 &&
    referenceUrlDurationSeconds > featureSettings.reference_url_duration_max_seconds
  ) {
    throw httpError(413, "reference URL audio duration is too long");
  }
}

async function consumePublicQuota(env, feature, email, featureSettings, request = null) {
  const normalizedEmail = normalizeEmail(email);
  const dailyLimit = Number(featureSettings.daily_limit ?? -1);
  const totalLimit = Number(featureSettings.total_limit ?? -1);
  const today = new Date().toISOString().slice(0, 10);
  if (env.MO_SPEECH_DB) {
    return consumePublicQuotaD1(env, feature, normalizedEmail, featureSettings, request, today);
  }
  const emailHash = await publicIdentityHash(normalizedEmail);
  const dailyKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${emailHash}:${today}`;
  const totalKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${emailHash}:total`;
  const legacyDailyKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${normalizedEmail}:${today}`;
  const legacyTotalKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${normalizedEmail}:total`;
  const hashedDailyUsed = await publicUsageGet(env, dailyKey);
  const hashedTotalUsed = await publicUsageGet(env, totalKey);
  const legacyDailyUsed = await publicUsageGet(env, legacyDailyKey);
  const legacyTotalUsed = await publicUsageGet(env, legacyTotalKey);
  const dailyUsed = Math.max(hashedDailyUsed, legacyDailyUsed);
  const totalUsed = Math.max(hashedTotalUsed, legacyTotalUsed);
  if (legacyDailyUsed > hashedDailyUsed) {
    await publicUsagePut(env, dailyKey, legacyDailyUsed, PUBLIC_DAILY_QUOTA_RETENTION_SECONDS);
  }
  if (legacyTotalUsed > hashedTotalUsed) {
    await publicUsagePut(env, totalKey, legacyTotalUsed);
  }
  await publicUsageDelete(env, legacyDailyKey);
  await publicUsageDelete(env, legacyTotalKey);
  if (dailyLimit >= 0 && dailyUsed >= dailyLimit) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_blocked",
      email: normalizedEmail,
      feature,
      limit_type: "daily",
      used: dailyUsed,
      limit: dailyLimit,
      ...requestAuditContext(request),
    });
    throw httpError(429, "public quota exceeded");
  }
  if (totalLimit >= 0 && totalUsed >= totalLimit) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_blocked",
      email: normalizedEmail,
      feature,
      limit_type: "total",
      used: totalUsed,
      limit: totalLimit,
      ...requestAuditContext(request),
    });
    throw httpError(429, "public quota exceeded");
  }
  await publicUsagePut(env, dailyKey, dailyUsed + 1, PUBLIC_DAILY_QUOTA_RETENTION_SECONDS);
  await publicUsagePut(env, totalKey, totalUsed + 1);
  await appendPublicAuditEvent(env, {
    action: "public_quota_consumed",
    email: normalizedEmail,
    feature,
    daily_used: dailyUsed + 1,
    daily_limit: dailyLimit,
    total_used: totalUsed + 1,
    total_limit: totalLimit,
    ...requestAuditContext(request),
  });
}

async function consumePublicQuotaD1(env, feature, email, featureSettings, request, today) {
  const emailHash = await publicIdentityHash(email);
  const dailyLimit = Number(featureSettings.daily_limit ?? -1);
  const totalLimit = Number(featureSettings.total_limit ?? -1);
  const daily = await env.MO_SPEECH_DB.prepare(
    "SELECT usage_count FROM quota_usage_daily WHERE email_hash = ? AND feature = ? AND usage_date = ?",
  ).bind(emailHash, feature, today).first();
  const total = await env.MO_SPEECH_DB.prepare(
    "SELECT usage_count FROM quota_usage_total WHERE email_hash = ? AND feature = ?",
  ).bind(emailHash, feature).first();
  const legacyDailyKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${email}:${today}`;
  const legacyTotalKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${email}:total`;
  const dailyUsed = daily ? Number(daily.usage_count || 0) : await publicUsageGet(env, legacyDailyKey);
  const totalUsed = total ? Number(total.usage_count || 0) : await publicUsageGet(env, legacyTotalKey);
  if (dailyLimit >= 0 && dailyUsed >= dailyLimit) {
    await appendPublicAuditEvent(env, { action: "public_quota_blocked", email, feature, limit_type: "daily", used: dailyUsed, limit: dailyLimit, ...requestAuditContext(request) });
    throw httpError(429, "public quota exceeded");
  }
  if (totalLimit >= 0 && totalUsed >= totalLimit) {
    await appendPublicAuditEvent(env, { action: "public_quota_blocked", email, feature, limit_type: "total", used: totalUsed, limit: totalLimit, ...requestAuditContext(request) });
    throw httpError(429, "public quota exceeded");
  }
  const now = new Date().toISOString();
  await env.MO_SPEECH_DB.batch([
    env.MO_SPEECH_DB.prepare(
      "INSERT INTO public_users (email_hash, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(email_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at",
    ).bind(emailHash, now, now),
    env.MO_SPEECH_DB.prepare(
      "INSERT INTO quota_usage_daily (email_hash, feature, usage_date, usage_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_hash, feature, usage_date) DO UPDATE SET usage_count = quota_usage_daily.usage_count + 1, updated_at = excluded.updated_at",
    ).bind(emailHash, feature, today, dailyUsed + 1, now),
    env.MO_SPEECH_DB.prepare(
      "INSERT INTO quota_usage_total (email_hash, feature, usage_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email_hash, feature) DO UPDATE SET usage_count = quota_usage_total.usage_count + 1, updated_at = excluded.updated_at",
    ).bind(emailHash, feature, totalUsed + 1, now),
  ]);
  await appendPublicAuditEvent(env, {
    action: "public_quota_consumed", email, feature,
    daily_used: dailyUsed + 1, daily_limit: dailyLimit,
    total_used: totalUsed + 1, total_limit: totalLimit,
    ...requestAuditContext(request),
  });
}

async function readPublicAuditLog(env, url = null) {
  const requestedLimit = url ? Number(new URL(url).searchParams.get("limit") || "") : 0;
  const limit = clampInt(requestedLimit, 1, publicAuditLogLimit(env), 100);
  if (env.MO_SPEECH_DB) {
    await migrateLegacyAuditEventsToD1(env);
    const result = await env.MO_SPEECH_DB.prepare(
      "SELECT id, occurred_at, actor_email_hash, action, feature, path, detail_json FROM audit_events ORDER BY occurred_at DESC LIMIT ?",
    ).bind(limit).all();
    const count = await env.MO_SPEECH_DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first();
    return {
      events: (result.results || []).map((row) => ({
        id: row.id,
        created_at: row.occurred_at,
        email_hash: row.actor_email_hash || "",
        action: row.action,
        feature: row.feature || "",
        path: row.path || "",
        ...safeJsonObject(row.detail_json),
      })),
      limit,
      stored: Number(count?.count || 0),
    };
  }
  const kv = stateKv(env);
  const events = kv ? await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []) : [];
  const storedEvents = Array.isArray(events) ? events : [];
  const normalizedEvents = await retainedPublicAuditEvents(storedEvents);
  if (kv && JSON.stringify(normalizedEvents) !== JSON.stringify(storedEvents)) {
    try {
      if (normalizedEvents.length > 0) {
        await kv.put(PUBLIC_AUDIT_LOG_KV_KEY, JSON.stringify(normalizedEvents), {
          expirationTtl: PUBLIC_AUDIT_RETENTION_SECONDS,
        });
      } else {
        await kv.delete(PUBLIC_AUDIT_LOG_KV_KEY);
      }
    } catch (_error) {
      // 既存監査ログのhash化失敗で読み取りを止めない。
    }
  }
  return {
    events: normalizedEvents.slice(-limit).reverse(),
    limit,
    stored: normalizedEvents.length,
  };
}

async function appendPublicAuditEvent(env, event) {
  if (env.MO_SPEECH_DB) {
    await migrateLegacyAuditEventsToD1(env);
    const now = new Date();
    const entry = await publicAuditEventWithHashedEmail({ id: crypto.randomUUID(), created_at: now.toISOString(), created_at_unix: Math.floor(now.getTime() / 1000), ...event });
    const emailHash = entry.email_hash || null;
    const detail = { ...entry };
    for (const key of ["id", "created_at", "email_hash", "action", "feature", "path"]) delete detail[key];
    try {
      await env.MO_SPEECH_DB.prepare(
        "INSERT INTO audit_events (id, occurred_at, actor_email_hash, action, feature, path, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(entry.id, entry.created_at, emailHash, entry.action || "unknown", entry.feature || null, entry.path || null, JSON.stringify(detail)).run();
    } catch (_error) {
      // 監査ログ保存の失敗で本処理を止めない。
    }
    return;
  }
  const kv = stateKv(env);
  if (!kv) {
    return;
  }
  const now = new Date();
  const entry = await publicAuditEventWithHashedEmail({
    id: crypto.randomUUID(),
    created_at: now.toISOString(),
    created_at_unix: Math.floor(now.getTime() / 1000),
    ...event,
  });
  try {
    const current = await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []);
    const events = await retainedPublicAuditEvents(Array.isArray(current) ? current : [], now);
    events.push(entry);
    const limit = publicAuditLogLimit(env);
    await kv.put(PUBLIC_AUDIT_LOG_KV_KEY, JSON.stringify(events.slice(-limit)), {
      expirationTtl: PUBLIC_AUDIT_RETENTION_SECONDS,
    });
  } catch (_error) {
    // 監査ログ保存の失敗で、ログインや生成APIの本処理を止めない。
  }
}

async function migrateLegacyAuditEventsToD1(env) {
  const kv = stateKv(env);
  if (!kv || await kv.get(PUBLIC_AUDIT_D1_MIGRATED_KV_KEY)) return;
  const legacy = await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []);
  for (const raw of Array.isArray(legacy) ? legacy : []) {
    const entry = await publicAuditEventWithHashedEmail(raw);
    const emailHash = entry.email_hash || null;
    const detail = { ...entry };
    for (const key of ["id", "created_at", "email_hash", "action", "feature", "path"]) delete detail[key];
    await env.MO_SPEECH_DB.prepare(
      "INSERT OR IGNORE INTO audit_events (id, occurred_at, actor_email_hash, action, feature, path, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(entry.id || crypto.randomUUID(), entry.created_at || new Date().toISOString(), emailHash, entry.action || "unknown", entry.feature || null, entry.path || null, JSON.stringify(detail)).run();
  }
  await kv.put(PUBLIC_AUDIT_D1_MIGRATED_KV_KEY, "1");
}

export async function runPublicDataRetention(env = {}, now = new Date()) {
  const referenceTime = Number.isFinite(now?.getTime?.()) ? now : new Date();
  const dailyQuotaCutoff = new Date(referenceTime.getTime() - PUBLIC_DAILY_QUOTA_RETENTION_SECONDS * 1000).toISOString();
  const auditCutoff = new Date(referenceTime.getTime() - PUBLIC_AUDIT_RETENTION_SECONDS * 1000).toISOString();

  if (env.MO_SPEECH_DB) {
    await env.MO_SPEECH_DB.batch([
      env.MO_SPEECH_DB.prepare("DELETE FROM quota_usage_daily WHERE updated_at < ?").bind(dailyQuotaCutoff),
      env.MO_SPEECH_DB.prepare("DELETE FROM audit_events WHERE occurred_at < ?").bind(auditCutoff),
    ]);
  }

  const kv = stateKv(env);
  if (!kv) {
    return;
  }
  const current = await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []);
  const events = await retainedPublicAuditEvents(Array.isArray(current) ? current : [], referenceTime);
  if (events.length > 0) {
    await kv.put(PUBLIC_AUDIT_LOG_KV_KEY, JSON.stringify(events), {
      expirationTtl: PUBLIC_AUDIT_RETENTION_SECONDS,
    });
  } else {
    await kv.delete(PUBLIC_AUDIT_LOG_KV_KEY);
  }
}

async function retainedPublicAuditEvents(events, now = new Date()) {
  const cutoff = now.getTime() - PUBLIC_AUDIT_RETENTION_SECONDS * 1000;
  const normalized = await Promise.all(events.map((entry) => publicAuditEventWithHashedEmail(entry)));
  return normalized.filter((entry) => {
    const occurredAt = Date.parse(String(entry.created_at || ""));
    return Number.isFinite(occurredAt) && occurredAt >= cutoff;
  });
}

async function recordPublicUserLogin(env, email) {
  if (!env.MO_SPEECH_DB) {
    return;
  }
  const now = new Date().toISOString();
  const emailHash = await publicIdentityHash(email);
  try {
    await env.MO_SPEECH_DB.prepare(
      "INSERT INTO public_users (email_hash, email, created_at, last_seen_at, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_hash) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at",
    ).bind(emailHash, normalizeEmail(email), now, now, now).run();
  } catch (_error) {
    // 利用者記録の失敗でログインを止めない。
  }
}

async function publicIdentityHash(email) {
  const bytes = new TextEncoder().encode(normalizeEmail(email));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function publicAuditEventWithHashedEmail(event) {
  const entry = sanitizePublicAuditEvent(event);
  const existingHash = /^[0-9a-f]{64}$/.test(String(entry.email_hash || "")) ? entry.email_hash : "";
  const emailHash = existingHash || (entry.email ? await publicIdentityHash(entry.email) : "");
  delete entry.email;
  if (emailHash) {
    entry.email_hash = emailHash;
  } else {
    delete entry.email_hash;
  }
  return entry;
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function publicAuditLogLimit(env) {
  return clampInt(env.PUBLIC_AUDIT_LOG_LIMIT, 10, 5000, PUBLIC_AUDIT_LOG_DEFAULT_LIMIT);
}

function sanitizePublicAuditEvent(event) {
  const allowed = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (["email", "email_hash", "action", "feature", "path", "method", "limit_type", "auth_method", "next", "cf_country", "cf_ray"].includes(key)) {
      allowed[key] = String(value).slice(0, 256);
    } else if (["id", "created_at"].includes(key)) {
      allowed[key] = String(value).slice(0, 128);
    } else if (["is_admin"].includes(key)) {
      allowed[key] = Boolean(value);
    } else if (
      [
        "created_at_unix",
        "daily_used",
        "daily_limit",
        "total_used",
        "total_limit",
        "used",
        "limit",
      ].includes(key)
    ) {
      allowed[key] = Number(value);
    }
  }
  return allowed;
}

function requestAuditContext(request) {
  if (!request) {
    return {};
  }
  const url = new URL(request.url);
  const cf = request.cf || {};
  return {
    method: request.method,
    path: url.pathname,
    cf_country: cf.country || "",
    cf_ray: request.headers.get("cf-ray") || "",
  };
}

async function publicUsageGet(env, key) {
  const kv = stateKv(env);
  if (kv) {
    return clampInt(await kv.get(key), 0, 1_000_000_000, 0);
  }
  return clampInt(ephemeralPublicUsage.get(key), 0, 1_000_000_000, 0);
}

async function publicUsagePut(env, key, value, expirationTtl = null) {
  const kv = stateKv(env);
  if (kv) {
    const options = expirationTtl ? { expirationTtl } : undefined;
    await kv.put(key, String(value), options);
  } else {
    ephemeralPublicUsage.set(key, String(value));
  }
}

async function publicUsageDelete(env, key) {
  const kv = stateKv(env);
  if (kv) {
    await kv.delete(key);
  } else {
    ephemeralPublicUsage.delete(key);
  }
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
    model: env.OPENAI_JOKE_VARIATION_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
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
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const sourceLanguage = stringFormValue(form, "source_language", "auto");
  const targetLanguage = stringFormValue(form, "target_language", "user-auto");
  const voiceMode = stringFormValue(form, "voice_mode", "default");
  const textTransform = optionalStringFormValue(form, "text_transform");
  const textTransformOptions = parseJsonFormValue(form, "text_transform_options", {});
  const textTransformSuffix = optionalStringFormValue(form, "text_transform_suffix");
  const textTransformUnit = stringFormValue(form, "text_transform_unit", "text");
  const jobId = `cf-${crypto.randomUUID()}`;

  await enforcePublicFeatureAccess(request, env, "fun", { audioBytes: audioBytes.byteLength });

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
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
      ...(textTransform ? { text_transform: textTransform } : {}),
    },
    warnings: [],
    target_language: translation.target_language,
    detected_source_language: translation.source_language,
  };
  const snapshot = completedJobSnapshot(jobId, "translation", result);
  await saveTranslationJobSnapshot(env, snapshot);
  return snapshot;
}

async function createVoiceConversionJob(request, env) {
  const form = await request.formData();
  const sourceAudio = requiredBlob(form, "source_audio");
  const referenceAudio = requiredBlob(form, "reference_audio");
  await enforcePublicFeatureAccess(request, env, "voice_conversion", {
    audioBytes: Math.max(Number(sourceAudio.size || 0), Number(referenceAudio.size || 0)),
  });
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
  const health = kind === "vibevoice" ? await runpodHealthForQueuedJob(body, env) : null;
  const snapshot = jobSnapshotFromRunpod(body, kind, health);
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, kind)) {
    await saveRunpodVcReadyState(env, snapshot, kind);
  }
  return snapshot;
}

async function cancelRunpodJob(jobId, env, kind) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/cancel/${encodeURIComponent(jobId)}`, { method: "POST" });
  return jobSnapshotFromRunpod(body, kind);
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

function jobSnapshotFromRunpod(body, kind, health = null, modelId = "") {
  const jobId = String(body.id || body.job_id || "");
  const status = String(body.status || "").toUpperCase();
  const metrics = runpodPracticeMetrics(body);
  if (status === "COMPLETED") {
    return {
      job_id: jobId,
      status: "succeeded",
      current_stage: { stage: "complete", label: "完了", provider: "" },
      stages: completedStages(kind),
      metrics,
      progress_log: [{ stage: "complete", label: "完了", provider: "" }],
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
      metrics,
      progress_log: [],
      result: null,
      error: runpodUserErrorMessage(body),
    };
  }
  const queued = status === "IN_QUEUE" || status === "QUEUED" || !status;
  const currentStage = kind === "vibevoice"
    ? vibeVoiceRunpodStage(body, health, modelId)
    : kind === "voice_conversion"
      ? voiceConversionRunpodStage(body, queued)
      : currentStageForKind(kind, queued);
  return {
    job_id: jobId,
    status: queued ? "queued" : "running",
    current_stage: currentStage,
    stages: plannedStages(kind),
    metrics,
    progress_log: [currentStage],
    result: null,
    error: null,
  };
}

function voiceConversionRunpodStage(body, queued) {
  if (queued) {
    return {
      stage: "gpu_wait",
      label: "利用可能なGPUを待っています",
      provider: "RunPod Serverless",
      model: "Seed-VC",
      detail: "RunPodのqueueでworkerの割り当てを待っています。",
    };
  }
  const progress = body?.output;
  if (progress && typeof progress === "object" && typeof progress.stage === "string") {
    return {
      stage: String(progress.stage || "voice_conversion"),
      label: String(progress.label || "自分の声に変換しています"),
      provider: String(progress.provider || "RunPod Serverless"),
      model: String(progress.model || "Seed-VC"),
      detail: String(progress.detail || ""),
    };
  }
  return {
    stage: "voice_conversion",
    label: "自分の声に変換しています",
    provider: "RunPod Serverless",
    model: "Seed-VC",
    detail: "",
  };
}

function plannedStages(kind) {
  if (kind === "voice_conversion") {
    return [
      { stage: "gpu_wait", label: "GPU待ち", provider: "RunPod Serverless" },
      { stage: "initializing", label: "Worker初期化", provider: "RunPod Serverless" },
      { stage: "loading_seed_vc_model", label: "Seed-VCモデル読込", provider: "RunPod Serverless" },
      { stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" },
    ];
  }
  if (kind === "vibevoice") {
    return [
      { stage: "gpu_wait", label: "GPU待ち", provider: "RunPod Serverless" },
      { stage: "initializing", label: "Worker初期化", provider: "RunPod Serverless" },
      { stage: "loading_vibevoice_model", label: "VibeVoiceモデル読込", provider: "RunPod Serverless" },
      { stage: "vibevoice_generation", label: "VibeVoice生成", provider: "RunPod Serverless" },
      { stage: "directed_asr", label: "指定台詞ASR", provider: "RunPod Serverless" },
      { stage: "loading_seed_vc_model", label: "Seed-VCモデル読込", provider: "RunPod Serverless" },
      { stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" },
      { stage: "reconstruct", label: "音声再配置", provider: "RunPod Serverless" },
      { stage: "finalizing", label: "出力仕上げ", provider: "RunPod Serverless" },
    ];
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

function vibeVoiceRunpodStage(body, health = null, modelId = "") {
  const status = String(body?.status || "").toUpperCase();
  const progress = body?.output;
  if ((status === "IN_PROGRESS" || status === "RUNNING") && progress && typeof progress === "object") {
    return {
      stage: String(progress.stage || "processing"),
      label: String(progress.label || "RunPodでSkitVoiceを処理しています"),
      provider: String(progress.provider || "RunPod Serverless"),
      model: String(progress.model || modelId || "vibevoice-large-aoi-pinned"),
      detail: String(progress.detail || ""),
    };
  }
  if (status === "" || status === "IN_QUEUE" || status === "QUEUED") {
    const counts = runpodWorkerCounts(health);
    if ((counts.initializing || 0) > 0) {
      return {
        stage: "initializing",
        label: "GPUワーカーを初期化しています",
        provider: "RunPod Serverless",
        model: modelId || "vibevoice-large-aoi-pinned",
        detail: "worker起動後にVibeVoiceモデルを読み込みます。",
      };
    }
    return {
      stage: "gpu_wait",
      label: "利用可能なGPUを待っています",
      provider: "RunPod Serverless",
      model: modelId || "vibevoice-large-aoi-pinned",
      detail: "RunPodのqueueでworkerの割り当てを待っています。",
    };
  }
  return {
    stage: "processing",
    label: "RunPodでSkitVoiceを処理しています",
    provider: "RunPod Serverless",
    model: modelId || "vibevoice-large-aoi-pinned",
    detail: "",
  };
}

async function runpodHealthForQueuedJob(body, env) {
  const status = String(body?.status || "").toUpperCase();
  if (status && status !== "IN_QUEUE" && status !== "QUEUED") {
    return null;
  }
  try {
    return await runpodRequest(env, "/health", { method: "GET", timeoutMs: 3000 });
  } catch (_error) {
    return null;
  }
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
  if (kind === "vibevoice") {
    return { stage: "vibevoice", label: "VibeVoice生成", provider: "RunPod Serverless" };
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
    model: env.OPENAI_TEXT_DISPLAY_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
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
  return result;
}

async function createUserJokeOutput(payload, env) {
  const text = String(payload.text || "").trim();
  if (!text) {
    throw httpError(400, "text is required");
  }
  const targetLanguage = String(payload.target_language || "id-ID");
  const translatedText = await openAiText(env, {
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
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
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    warnings: [],
    target_language: targetLanguage,
  };
  return result;
}

async function createPracticePrompt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  await enforcePublicFeatureAccess(request, env, "speakloop", { audioBytes: Number(audio.size || 0) });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: "auto",
    filename: audio.name || `native.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
    includeTimestamps: true,
  });
  const transcript = transcription.text;
  const asrMs = Date.now() - asrStarted;

  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript,
    sourceLanguage: "auto",
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;
  const targetText = canonicalPracticeText(translation.translated_text, targetLanguage);

  const tts = await openAiSpeech(env, targetText);
  const result = {
    transcript,
    target_text: targetText,
    translated_text: targetText,
    transformed_text: targetText,
    target_language: targetLanguage,
    target_language_label: PRACTICE_TARGET_LANGUAGES[targetLanguage].label,
    display_text: await createPracticeDisplayText(targetText, targetLanguage, env, {
      includePinyin,
    }),
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    asr_model: asrModel,
    asr_timestamps: serializeAsrTimestamps(transcription),
    timings_ms: {
      asr: asrMs,
      translation: translationMs,
      ...(tts.timings_ms || {}),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: `openai-asr-${asrModel}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    detected_source_language: translation.source_language,
  };
  return result;
}

async function createPracticeRecording(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const currentTargetText = stringFormValue(form, "current_target_text", "");
  const recordingIntent = stringFormValue(form, "recording_intent", "").trim();
  if (recordingIntent !== "prompt") {
    throw httpError(400, "recording_intent must be prompt");
  }
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  const useOwnVoice = optionEnabled(stringFormValue(form, "use_own_voice", "false"));
  if (useOwnVoice) {
    const separateReferenceFields = [
      "reference_audio",
      "reference_audio_base64",
      "reference_audio_file",
      "reference_audio_url",
      "reference_url",
      "reference_tab_audio",
      "tab_audio",
      "voice_file",
      "voice_url",
    ];
    if (separateReferenceFields.some((field) => form.has(field))) {
      throw httpError(400, "own voice only accepts the same-session SpeakLoop recording");
    }
  }
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0),
    textChars: currentTargetText.trim().length,
  });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  const autoStarted = Date.now();
  const autoTranscription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: "auto",
    filename: audio.name || `practice.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
    includeTimestamps: true,
  });
  const autoAsrMs = Date.now() - autoStarted;
  const totalStarted = Date.now();
  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript: autoTranscription.text,
    sourceLanguage: "auto",
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;
  const targetText = canonicalPracticeText(translation.translated_text, targetLanguage);

  const tts = await openAiSpeech(env, targetText);
  const result = {
    recording_kind: "prompt",
    transcript: autoTranscription.text,
    target_text: targetText,
    translated_text: targetText,
    transformed_text: targetText,
    target_language: targetLanguage,
    target_language_label: PRACTICE_TARGET_LANGUAGES[targetLanguage].label,
    display_text: await createPracticeDisplayText(targetText, targetLanguage, env, {
      includePinyin,
    }),
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    asr_model: asrModel,
    asr_timestamps: serializeAsrTimestamps(autoTranscription),
    timings_ms: {
      asr: autoAsrMs,
      translation: translationMs,
      ...(tts.timings_ms || {}),
      total: Date.now() - totalStarted + autoAsrMs,
    },
    providers: {
      asr: `openai-asr-${asrModel}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    detected_source_language: translation.source_language,
  };
  if (useOwnVoice) {
    const body = await submitRunpodJob(env, {
      operation_mode: "voice_conversion",
      source_audio_base64: tts.audio_base64,
      source_audio_mime_type: tts.audio_mime_type || "audio/wav",
      reference_audio_base64: arrayBufferToBase64(audioBytes),
      reference_audio_mime_type: audioMimeType || "audio/webm",
      voice_backend: "seed-vc",
      seed_vc_reference_max_seconds: 10,
      seed_vc_reference_auto_select: true,
      seed_vc_length_adjust: 1.0,
      seed_vc_inference_cfg_rate: 0.7,
    });
    result.voice_conversion_job = jobSnapshotFromRunpod(body, "voice_conversion");
  }
  return result;
}

function validatePracticeTargetForAlignment(targetText) {
  const phrases = splitPracticePhrases(targetText);
  if (!phrases.length) {
    throw new PracticeAlignmentInputError("empty_target");
  }
  if (phrases.length > MAX_CANONICAL_TARGET_PHRASES) {
    throw new PracticeAlignmentInputError("alignment_input_too_large");
  }
}

async function createPracticeAttemptJob(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const modelAudio = requiredBlob(form, "model_audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "en-US"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const targetText = canonicalPracticeText(stringFormValue(form, "target_text", "").trim(), targetLanguage);
  validatePracticeTargetForAlignment(targetText);
  if (targetLanguage !== "zh-CN" && !OPENAI_TIMESTAMP_ASR_MODELS.has(asrModel)) {
    throw httpError(
      400,
      `asr_model '${asrModel}' does not return word timestamps, which the LLM comparison requires; use whisper-1 for comparison_model requests`,
    );
  }
  const comparisonModel = supportedPracticeComparisonModel(stringFormValue(form, "comparison_model", ""));
  const playbackPaddingSeconds = validatePlaybackPaddingSeconds(
    stringFormValue(form, "playback_padding_seconds", ""),
  );
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0) + Number(modelAudio.size || 0),
    textChars: targetText.length,
  });
  const [audioBytes, modelAudioBytes] = await Promise.all([audio.arrayBuffer(), modelAudio.arrayBuffer()]);
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const modelAudioMimeType = normalizeMimeType(modelAudio.type || guessAudioMimeType(modelAudio.name));

  if (targetLanguage === "zh-CN") {
    const { key: modelAudioCacheKey, cached: cachedModelTranscription } = await lookupRunpodPracticeModelAsrCache(env, {
      audioBytes: modelAudioBytes,
      sourceLanguage: targetLanguage,
    });
    const body = await submitRunpodJob(env, {
      operation_mode: "practice_asr",
      source_language: targetLanguage,
      target_text: targetText,
      audio_mime_type: audioMimeType || "audio/wav",
      audio_base64: arrayBufferToBase64(audioBytes),
      // お手本音声のASR結果が既にキャッシュ済みの場合はmodel_audio_base64を送らない。
      // RunPod側のhandlerはmodel_audio_base64が無ければお手本側のFunASR推論を省略する。
      ...(cachedModelTranscription
        ? {}
        : {
          model_audio_mime_type: modelAudioMimeType || "audio/wav",
          model_audio_base64: arrayBufferToBase64(modelAudioBytes),
        }),
    });
    const jobId = String(body?.id || body?.job_id || "");
    await savePracticeAttemptLlmOptions(env, jobId, {
      comparison_model: comparisonModel,
      playback_padding_seconds: playbackPaddingSeconds,
      model_audio_cache_key: modelAudioCacheKey,
      cached_model_transcription: cachedModelTranscription || null,
    });
    let health = null;
    if (["", "IN_QUEUE", "QUEUED"].includes(String(body.status || "").toUpperCase())) {
      try {
        health = await runpodRequest(env, "/health", { method: "GET", timeoutMs: 3000 });
      } catch (_error) {
        health = null;
      }
    }
    return practiceAttemptJobSnapshot(body, health, env);
  }

  const started = Date.now();
  const transcribeWithTiming = async (options) => {
    const transcriptionStarted = Date.now();
    const transcription = await openAiTranscribeDetail(env, options);
    return { transcription, elapsedMs: Date.now() - transcriptionStarted };
  };
  const [modelAsr, attemptAsr] = await Promise.all([
    (async () => {
      const transcriptionStarted = Date.now();
      const transcription = await cachedPracticeModelTranscription(env, {
        audioBytes: modelAudioBytes,
        audioMimeType: modelAudioMimeType,
        sourceLanguage: targetLanguage,
        filename: modelAudio.name || `model.${extensionForMimeType(modelAudioMimeType)}`,
        model: asrModel,
      });
      return { transcription, elapsedMs: Date.now() - transcriptionStarted };
    })(),
    transcribeWithTiming({
      audioBytes,
      audioMimeType,
      sourceLanguage: targetLanguage,
      filename: audio.name || `attempt.${extensionForMimeType(audioMimeType)}`,
      model: asrModel,
      includeTimestamps: true,
    }),
  ]);
  const totalMs = Date.now() - started;
  const modelTranscription = modelAsr.transcription;
  const attemptTranscription = attemptAsr.transcription;
  const result = await practiceAttemptComparisonResult({
    targetLanguage,
    targetText,
    attemptTranscription: {
      ...attemptTranscription,
      provider: `openai-asr-${attemptTranscription.model}`,
    },
    modelTranscription: {
      ...modelTranscription,
      provider: `openai-asr-${modelTranscription.model}`,
    },
    timings: { asr: attemptAsr.elapsedMs, model_asr: modelAsr.elapsedMs, total: totalMs },
    comparisonModel,
    playbackPaddingSeconds,
    env,
  });
  return {
    job_id: "",
    status: "succeeded",
    current_stage: {
      stage: "complete",
      label: "比較準備が完了しました",
      provider: `OpenAI ${asrModel}`,
      model: asrModel,
    },
    stages: [{ stage: "complete", label: "完了", provider: `OpenAI ${asrModel}`, model: asrModel }],
    metrics: {},
    result,
    error: null,
  };
}

async function getPracticeAttemptJob(jobId, env) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" });
  let health = null;
  if (["", "IN_QUEUE", "QUEUED"].includes(String(body.status || "").toUpperCase())) {
    try {
      health = await runpodRequest(env, "/health", { method: "GET", timeoutMs: 3000 });
    } catch (_error) {
      health = null;
    }
  }
  return practiceAttemptJobSnapshot(body, health, env);
}

async function practiceAttemptJobSnapshot(body, health = null, env = {}) {
  const jobId = String(body?.id || body?.job_id || "");
  const status = String(body?.status || "").toUpperCase();
  const metrics = runpodPracticeMetrics(body);
  const stages = practiceAttemptJobStages();
  if (status === "COMPLETED") {
    // このjobIdが既に確定済みなら、再ポーリングのたびにLLM比較を再実行して
    // 二重課金・スコアの揺れが起きないよう、確定済みsnapshotをそのまま返す。
    const cachedSnapshot = await readPracticeAttemptResult(env, jobId);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }
    const output = body?.output;
    if (!output || typeof output !== "object") {
      return failedPracticeAttemptJob(jobId, stages, metrics, "RunPod job completed without an output object");
    }
    const contractVersion = Number(output.practice_asr_contract_version || 0);
    if (!Number.isFinite(contractVersion) || contractVersion < 2) {
      return failedPracticeAttemptJob(
        jobId,
        stages,
        metrics,
        "RunPod imageがpractice ASR contract v2に対応していません。現在のRunPod imageを再デプロイしてください。",
        "RunPod imageの更新が必要です",
      );
    }
    const llmOptions = await readPracticeAttemptLlmOptions(env, jobId);
    const modelTranscriptionReturned = output.model_transcription && typeof output.model_transcription === "object";
    if (!modelTranscriptionReturned && !llmOptions?.cached_model_transcription) {
      return failedPracticeAttemptJob(jobId, stages, metrics, "RunPod practice job did not return model_transcription");
    }
    const attemptTranscription = runpodPracticeTranscription(output);
    const modelTranscription = modelTranscriptionReturned
      ? runpodPracticeTranscription(output.model_transcription)
      : llmOptions.cached_model_transcription;
    if (modelTranscriptionReturned && llmOptions?.model_audio_cache_key) {
      // このjobはお手本音声ASRのキャッシュが無かったため、model_audio_base64を送って
      // RunPod側でFunASR推論した。次回以降の同じお手本音声への再挑戦がRunPod側の
      // 推論を省略できるよう、確定したtranscriptionをキャッシュへ書き込む。
      await storePracticeModelAsrCache(env, llmOptions.model_audio_cache_key, modelTranscription);
    }
    let result;
    try {
      result = await practiceAttemptComparisonResult({
        targetLanguage: "zh-CN",
        targetText: canonicalPracticeText(output.target_text || "", "zh-CN"),
        attemptTranscription,
        modelTranscription,
        timings: output.timings_ms || {},
        comparisonModel: llmOptions?.comparison_model || "",
        playbackPaddingSeconds: llmOptions?.playback_padding_seconds ?? DEFAULT_PLAYBACK_PADDING_SECONDS,
        env,
      });
    } catch (error) {
      if (error instanceof PracticeLlmError) {
        const snapshot = failedPracticeAttemptJob(
          jobId,
          stages,
          metrics,
          practiceLlmErrorEnvelope(error).error,
          "比較結果を作成できませんでした",
        );
        await savePracticeAttemptResult(env, jobId, snapshot);
        return snapshot;
      }
      if (!(error instanceof PracticeAlignmentError)) throw error;
      const snapshot = failedPracticeAttemptJob(
        jobId,
        stages,
        metrics,
        practiceAlignmentErrorEnvelope(error).error,
        "音声の解析結果を確認できませんでした",
      );
      await savePracticeAttemptResult(env, jobId, snapshot);
      return snapshot;
    }
    const snapshot = {
      job_id: jobId,
      status: "succeeded",
      current_stage: {
        stage: "complete",
        label: "比較準備が完了しました",
        provider: "Voice Lab",
        model: attemptTranscription.model,
      },
      stages: [...stages, { stage: "complete", label: "完了", provider: "Voice Lab", model: attemptTranscription.model }],
      metrics,
      result,
      error: null,
    };
    await savePracticeAttemptResult(env, jobId, snapshot);
    return snapshot;
  }
  if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    return failedPracticeAttemptJob(jobId, stages, metrics, runpodUserErrorMessage(body));
  }
  const queued = status === "" || status === "IN_QUEUE" || status === "QUEUED";
  return {
    job_id: jobId,
    status: queued ? "queued" : "running",
    current_stage: practiceRunpodStage(body, health),
    stages,
    metrics,
    result: null,
    error: null,
  };
}

async function practiceAttemptComparisonResult({
  targetLanguage,
  targetText,
  attemptTranscription,
  modelTranscription,
  timings = {},
  comparisonModel = "",
  playbackPaddingSeconds = DEFAULT_PLAYBACK_PADDING_SECONDS,
  env = {},
}) {
  const recognizedText = canonicalPracticeText(attemptTranscription.text || "", targetLanguage);
  const modelRecognizedText = canonicalPracticeText(modelTranscription.text || "", targetLanguage);
  const asrTimestamps = serializeAsrTimestamps(attemptTranscription);
  const modelAsrTimestamps = serializeAsrTimestamps(modelTranscription);

  const referenceNoSpeech =
    !String(modelRecognizedText || "").trim() &&
    !(modelAsrTimestamps?.words || []).length &&
    !(modelAsrTimestamps?.segments || []).length;
  if (referenceNoSpeech) {
    throw new PracticeAlignmentError("empty_reference_asr", { stage: "reference_asr" });
  }
  const noSpeech =
    !String(recognizedText || "").trim() &&
    !(asrTimestamps?.words || []).length &&
    !(asrTimestamps?.segments || []).length;
  if (noSpeech) {
    const attemptMs = Number(timings.asr || 0);
    const modelMs = Number(timings.model_asr || 0);
    return {
      recording_kind: "attempt",
      target_language: targetLanguage,
      target_text: targetText,
      recognized_text: recognizedText,
      model_recognized_text: modelRecognizedText,
      asr_model: attemptTranscription.model,
      asr_timestamps: asrTimestamps,
      model_asr_timestamps: modelAsrTimestamps,
      outcome: "no_speech",
      message: "音声を検出できませんでした。もう一度録音してください。",
      comparison_alignment: null,
      model_comparison_alignment: null,
      comparison_model: comparisonModel,
      playback_padding_seconds: playbackPaddingSeconds,
      timings_ms: {
        asr: attemptMs,
        model_asr: modelMs,
        compare: 0,
        total: attemptMs + modelMs,
      },
      providers: {
        asr: attemptTranscription.provider,
        model_asr: modelTranscription.provider || attemptTranscription.provider,
        comparison: "openai-responses",
      },
    };
  }
  const llmInput = buildPracticeLlmInput({
    targetLanguage,
    targetText,
    paddingSeconds: playbackPaddingSeconds,
    referenceAudioDuration: practiceAudioDurationSeconds(modelTranscription),
    attemptAudioDuration: practiceAudioDurationSeconds(attemptTranscription),
    referenceAsr: {
      recognized_text: modelRecognizedText,
      model: modelTranscription.model,
      words: modelAsrTimestamps.words,
    },
    attemptAsr: {
      recognized_text: recognizedText,
      model: attemptTranscription.model,
      words: asrTimestamps.words,
    },
  });
  const compareStarted = Date.now();
  const { result: llmResult } = await callPracticeLlmService(env, {
    model: comparisonModel,
    inputPayload: llmInput,
  });
  const [comparisonAlignment, modelComparisonAlignment] = comparisonAlignmentsFromLlmResult(llmResult);
  const compareMs = Date.now() - compareStarted;
  const attemptMs = Number(timings.asr || 0);
  const modelMs = Number(timings.model_asr || 0);
  const comparisonTargetPinyin = targetLanguage === "zh-CN" ? practiceDiffPinyinChars(targetText) : [];
  const comparisonRecognizedPinyin = targetLanguage === "zh-CN" ? practiceDiffPinyinChars(recognizedText) : [];
  return {
    recording_kind: "attempt",
    target_language: targetLanguage,
    target_text: targetText,
    recognized_text: recognizedText,
    model_recognized_text: modelRecognizedText,
    asr_model: attemptTranscription.model,
    asr_timestamps: asrTimestamps,
    model_asr_timestamps: modelAsrTimestamps,
    outcome: "evaluated",
    overall_score: llmResult.overall_score,
    overall_comment: llmResult.overall_comment,
    llm_comparison: llmResult,
    comparison_alignment: comparisonAlignment,
    model_comparison_alignment: modelComparisonAlignment,
    comparison_target_pinyin: comparisonTargetPinyin,
    comparison_recognized_pinyin: comparisonRecognizedPinyin,
    comparison_model: comparisonModel,
    playback_padding_seconds: playbackPaddingSeconds,
    timings_ms: {
      asr: attemptMs,
      model_asr: modelMs,
      compare: compareMs,
      total: attemptMs + modelMs + compareMs,
    },
    providers: {
      asr: attemptTranscription.provider,
      model_asr: modelTranscription.provider || attemptTranscription.provider,
      comparison: "openai-responses",
    },
  };
}

function runpodPracticeTranscription(output) {
  const providers = output?.providers && typeof output.providers === "object" ? output.providers : {};
  return {
    text: String(output?.text || "").trim(),
    model: String(output?.model || FUNASR_DEFAULT_PRACTICE_ASR_MODEL),
    timestamp_granularities: Array.isArray(output?.timestamp_granularities)
      ? output.timestamp_granularities.map(String)
      : [],
    words: normalizedAsrTimingRows(output?.words, "text"),
    segments: normalizedAsrTimingRows(output?.segments, "text"),
    raw_timestamp_word_count: Array.isArray(output?.words) ? output.words.length : 0,
    raw_timestamp_segment_count: Array.isArray(output?.segments) ? output.segments.length : 0,
    provider: String(providers.asr || "funasr-paraformer-zh"),
  };
}

function practiceAttemptJobStages() {
  const model = FUNASR_DEFAULT_PRACTICE_ASR_MODEL;
  return [
    { stage: "gpu_wait", label: "GPU待機", provider: "RunPod Serverless", model },
    { stage: "loading_model", label: "モデル読込", provider: "RunPod Serverless", model },
    { stage: "transcribing_model", label: "お手本解析", provider: "RunPod Serverless", model },
    { stage: "transcribing_attempt", label: "録音解析", provider: "RunPod Serverless", model },
    { stage: "finalizing", label: "比較準備", provider: "Voice Lab", model },
  ];
}

function failedPracticeAttemptJob(jobId, stages, metrics, error, label = "処理に失敗しました") {
  const detail = typeof error === "object" && error !== null ? String(error.message || "") : String(error || "");
  return {
    job_id: jobId,
    status: "failed",
    current_stage: {
      stage: "failed",
      label,
      provider: "RunPod Serverless",
      model: FUNASR_DEFAULT_PRACTICE_ASR_MODEL,
      detail,
    },
    stages,
    metrics,
    result: null,
    error,
  };
}

function practiceAlignmentErrorEnvelope(error) {
  const message = error instanceof PracticeAlignmentInputError
    ? "入力内容を確認して、もう一度お試しください。"
    : "音声の解析結果を確認できませんでした。もう一度お試しください。";
  return {
    error: {
      code: error.error_code,
      reason: error.reason,
      stage: error.stage,
      retryable: error.retryable,
      message,
      diagnostic_flags: [error.reason],
    },
  };
}

function practiceRunpodStage(body, health) {
  const status = String(body?.status || "").toUpperCase();
  const progress = body?.output;
  if ((status === "IN_PROGRESS" || status === "RUNNING") && progress && typeof progress === "object") {
    return {
      stage: String(progress.stage || "processing"),
      label: String(progress.label || "RunPodで処理しています"),
      provider: String(progress.provider || "RunPod Serverless"),
      model: String(progress.model || FUNASR_DEFAULT_PRACTICE_ASR_MODEL),
      detail: String(progress.detail || ""),
    };
  }
  if (status === "" || status === "IN_QUEUE" || status === "QUEUED") {
    const counts = runpodWorkerCounts(health);
    if ((counts.initializing || 0) > 0) {
      return {
        stage: "initializing",
        label: "GPUワーカーを初期化しています",
        provider: "RunPod Serverless",
        model: FUNASR_DEFAULT_PRACTICE_ASR_MODEL,
        detail: "worker起動後にFunASRモデルを読み込みます。",
      };
    }
    return {
      stage: "gpu_wait",
      label: "利用可能なGPUを待っています",
      provider: "RunPod Serverless",
      model: FUNASR_DEFAULT_PRACTICE_ASR_MODEL,
      detail: "RunPodのqueueでworkerの割り当てを待っています。",
    };
  }
  return {
    stage: "processing",
    label: "RunPodで処理しています",
    provider: "RunPod Serverless",
    model: FUNASR_DEFAULT_PRACTICE_ASR_MODEL,
    detail: "",
  };
}

function runpodWorkerCounts(health) {
  const workers = health?.workers;
  if (Array.isArray(workers)) {
    return workers.reduce((counts, worker) => {
      const state = String(worker?.state || "unknown").toLowerCase();
      counts[state] = (counts[state] || 0) + 1;
      return counts;
    }, {});
  }
  if (workers && typeof workers === "object") {
    return Object.fromEntries(
      Object.entries(workers)
        .map(([key, value]) => [String(key).toLowerCase(), Number(value)])
        .filter(([, value]) => Number.isFinite(value)),
    );
  }
  return {};
}

function runpodPracticeMetrics(body) {
  const metrics = {};
  const delayTime = Number(body?.delayTime);
  const executionTime = Number(body?.executionTime);
  if (Number.isFinite(delayTime)) metrics.delay_time_ms = delayTime;
  if (Number.isFinite(executionTime)) metrics.execution_time_ms = executionTime;
  return metrics;
}

function runpodUserErrorMessage(body) {
  const detail = runpodErrorMessage(body);
  if (/insufficient.*(?:balance|fund|credit)|(?:balance|fund|credit).*insufficient|payment required/iu.test(detail)) {
    return `RunPodの残高不足でGPU処理を開始できません。RunPodのBillingを確認してください。詳細: ${detail}`;
  }
  return detail;
}

async function createPracticeDisplayText(text, targetLanguage, env, { includePinyin = false } = {}) {
  if (targetLanguage === "zh-CN") {
    const pinyinText = includePinyin ? createChinesePinyinText(text) : "";
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

async function vibeVoiceStatus(env) {
  const runpodAvailable = Boolean(env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY);
  return {
    backends: {
      local: {
        available: false,
        provider: "cloudflare-worker",
        default_model_id: "vibevoice-large-aoi-pinned",
        model_presets: vibeVoiceModelPresets(),
        cli_exists: false,
        cli_path: "Cloudflare Worker",
        comfyui_vibevoice_exists: false,
        comfyui_vibevoice_path: "RunPod Serverless",
        model_cache_found: false,
        model_cache_path: "",
        tokenizer_found: false,
        tokenizer_path: "",
        timeout_seconds: 0,
      },
      runpod_serverless: {
        available: runpodAvailable,
        provider: "runpod-serverless-vibevoice",
        configured: runpodAvailable,
        endpoint_id: env.RUNPOD_ENDPOINT_ID || "",
        request_mode: "async",
        default_model_id: "vibevoice-large-aoi-pinned",
        model_presets: vibeVoiceModelPresets(),
        reason: runpodAvailable ? "" : "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
      },
    },
  };
}

async function createVibeVoiceReferenceAudioFromUrl(_request, _env) {
  throw httpError(501, "URL reference audio extraction is only available in the local FastAPI app");
}

async function createVibeVoiceJob(request, env) {
  const form = await request.formData();
  const originalScript = await readVibeVoiceScriptFromForm(form);
  if (!originalScript.trim()) {
    throw httpError(400, "script is required");
  }
  const scriptPlan = await prepareVibeVoiceScriptForGeneration(form, env, originalScript);
  const voiceBlobs = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const blob = optionalBlob(form, `voice_file_${slot}`);
    if (blob && Number(blob.size || 0) > 0) {
      voiceBlobs.push({ slot, blob });
      continue;
    }
    if (stringFormValue(form, `voice_url_${slot}`, "").trim()) {
      throw httpError(
        400,
        "URL reference audio is not available on the Cloudflare public demo. Upload or record reference audio instead.",
      );
    }
  }
  if (voiceBlobs.length < 1) {
    throw httpError(400, "voice sample is required");
  }
  await enforcePublicFeatureAccess(request, env, "skitvoice", {
    scriptChars: originalScript.trim().length,
    audioBytes: Math.max(0, ...voiceBlobs.map((item) => Number(item.blob.size || 0))),
  });
  const voices = [];
  for (const item of voiceBlobs) {
    const audioBytes = await item.blob.arrayBuffer();
    const audioMimeType = normalizeMimeType(item.blob.type || guessAudioMimeType(item.blob.name));
    voices.push({
      speaker: item.slot,
      filename: item.blob.name || `voice-${item.slot}.${extensionForMimeType(audioMimeType)}`,
      audio_mime_type: audioMimeType,
      audio_base64: arrayBufferToBase64(audioBytes),
    });
  }
  const body = await submitRunpodJob(env, {
    operation_mode: "vibevoice",
    script: scriptPlan.script,
    script_translation: scriptPlan.diagnostics,
    voices,
    generation: vibeVoiceGenerationPayloadFromForm(form),
    response_audio_format: stringFormValue(form, "response_audio_format", "mp3"),
  });
  const health = await runpodHealthForQueuedJob(body, env);
  return jobSnapshotFromRunpod(
    body,
    "vibevoice",
    health,
    stringFormValue(form, "model_id", "vibevoice-large-aoi-pinned"),
  );
}

async function readVibeVoiceScriptFromForm(form) {
  const inline = stringFormValue(form, "script", "").trim();
  if (inline) {
    return normalizeVibeVoiceScriptLineEndings(inline);
  }
  const file = optionalBlob(form, "script_file");
  if (file && Number(file.size || 0) > 0 && typeof file.text === "function") {
    return normalizeVibeVoiceScriptLineEndings((await file.text()).trim());
  }
  return "";
}

function normalizeVibeVoiceScriptLineEndings(text) {
  return String(text || "").replace(/\r\n?/g, "\n");
}

async function prepareVibeVoiceScriptForGeneration(form, env, script) {
  const outputLanguage = supportedVibeVoiceOutputLanguage(stringFormValue(form, "output_language", "zh-CN"));
  const translationMode = stringFormValue(form, "translate_script", "false").trim().toLowerCase();
  const auto = translationMode === "auto";
  const requested = auto || optionEnabled(translationMode);
  const diagnostics = {
    requested,
    enabled: false,
    output_language: outputLanguage,
    source_language: auto ? "auto" : "ja-JP",
    source_script: script,
    translated_script: script,
    model: "",
    provider: "",
  };
  if (!requested) {
    return { script, diagnostics };
  }
  const model = env.OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra";
  const translationResult = parseVibeVoiceTranslationResult(await openAiText(env, {
    model,
    instructions: [
      "Detect the dialogue language of this skit script.",
      `If it is not ${VIBEVOICE_OUTPUT_LANGUAGES[outputLanguage].speech_name}, translate only dialogue text into that language; if it is already the target language, return it unchanged.`,
      "Preserve speaker tags exactly.",
      "Preserve the number of non-empty lines and preserve line order.",
      "Return strict JSON with keys source_language and script.",
      "source_language must be a BCP 47 language code and script must contain the final script.",
    ].join(" "),
    input: script,
  }));
  const translated = normalizeVibeVoiceTranslatedScript(translationResult.script);
  validateVibeVoiceTranslatedScript(script, translated);
  return {
    script: translated,
    diagnostics: {
      ...diagnostics,
      enabled: translated !== script,
      source_language: translationResult.source_language,
      translated_script: translated,
      model,
      provider: "openai-responses",
    },
  };
}

async function createVibeVoiceScript(request, env) {
  const settings = await readPublicAccessSettings(env);
  if (settings.google_login_required) {
    if (!publicGoogleAuthConfigured(env)) {
      throw httpError(503, "Google login is not configured");
    }
    if (!(await readPublicSession(request, env))) {
      throw httpError(401, "Google login is required");
    }
  }
  const payload = await request.json().catch(() => ({}));
  const seedScript = String(payload?.seed_script || "").trim();
  if (seedScript.length > 5_000) {
    throw httpError(413, "seed_script must be 5000 characters or fewer");
  }
  const model = env.OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra";
  const script = normalizeVibeVoiceTranslatedScript(await openAiText(env, {
    model,
    instructions: [
      "Write a natural, friendly Japanese everyday conversation for speech synthesis.",
      "Return exactly five non-empty lines, alternating speakers 1, 2, 1, 2, 1.",
      "Every line must start with the speaker number and one space.",
      "Return only the script with no title or notes.",
    ].join(" "),
    input: seedScript
      ? `次の台本を着想元として、話題や状況を自然に連想・発展させて再構成してください。\n\n${seedScript}`
      : "短い日常会話を新規に作ってください。",
  }));
  const lines = script.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 5 || lines.map((line) => line.trim().split(/\s+/, 1)[0]).join(",") !== "1,2,1,2,1") {
    throw httpError(502, "AI script generation must return exactly five alternating speaker lines");
  }
  return { script: lines.join("\n") };
}

function parseVibeVoiceTranslationResult(value) {
  const text = normalizeVibeVoiceTranslatedScript(value);
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || !String(payload.script || "").trim()) {
      throw new Error("missing script");
    }
    return {
      source_language: String(payload.source_language || "auto"),
      script: String(payload.script),
    };
  } catch (error) {
    if (text.startsWith("{")) {
      throw httpError(502, `VibeVoice script translation returned invalid JSON: ${error.message || error}`);
    }
    return { source_language: "auto", script: text };
  }
}

function supportedVibeVoiceOutputLanguage(value) {
  const language = String(value || "zh-CN").trim();
  if (!Object.prototype.hasOwnProperty.call(VIBEVOICE_OUTPUT_LANGUAGES, language)) {
    throw httpError(400, `unsupported VibeVoice output language: ${language}`);
  }
  return language;
}

function normalizeVibeVoiceTranslatedScript(text) {
  let translated = String(text || "").trim();
  if (translated.startsWith("```")) {
    translated = translated.replace(/^```(?:text|txt)?/i, "").replace(/```$/i, "").trim();
  }
  return translated.split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trim();
}

function validateVibeVoiceTranslatedScript(sourceScript, translatedScript) {
  if (!translatedScript.trim()) {
    throw httpError(502, "VibeVoice script translation returned empty text");
  }
  const sourceLines = String(sourceScript || "").split(/\r?\n/).filter((line) => line.trim());
  const translatedLines = String(translatedScript || "").split(/\r?\n/).filter((line) => line.trim());
  if (sourceLines.length > 0 && sourceLines.length !== translatedLines.length) {
    throw httpError(
      502,
      `VibeVoice script translation must preserve non-empty line count: source=${sourceLines.length} translated=${translatedLines.length}`,
    );
  }
}

function vibeVoiceGenerationPayloadFromForm(form) {
  return {
    model_id: stringFormValue(form, "model_id", "vibevoice-large-aoi-pinned"),
    cfg_scale: numberFormValue(form, "cfg_scale", 1.3),
    inference_steps: clampInt(stringFormValue(form, "inference_steps", "10"), 1, 50, 10),
    seed: clampInt(stringFormValue(form, "seed", "42"), 0, 999999999, 42),
    do_sample: optionEnabled(stringFormValue(form, "do_sample", "true")),
    temperature: numberFormValue(form, "temperature", 0.95),
    top_p: numberFormValue(form, "top_p", 0.95),
    top_k: clampInt(stringFormValue(form, "top_k", "0"), 0, 1000, 0),
    max_voice_seconds: numberFormValue(form, "max_voice_seconds", 5),
    line_by_line: optionEnabled(stringFormValue(form, "line_by_line", "false")),
    line_gap: numberFormValue(form, "line_gap", 1),
    directed_line_mode: optionEnabled(stringFormValue(form, "directed_line_mode", "true")),
    directed_retry_low_score: optionEnabled(stringFormValue(form, "directed_retry_low_score", "true")),
    directed_retry_score_threshold: numberFormValue(form, "directed_retry_score_threshold", 0.65),
    directed_retry_max_multiplier: numberFormValue(form, "directed_retry_max_multiplier", 1),
  };
}

function vibeVoiceModelPresets() {
  return [
    { model_id: "vibevoice-1.5b-pinned", label: "VibeVoice 1.5B 固定版", supported_backends: ["local", "runpod_serverless"] },
    { model_id: "vibevoice-1.5b-latest", label: "VibeVoice 1.5B 最新", supported_backends: ["local", "runpod_serverless"] },
    { model_id: "vibevoice-large-aoi-pinned", label: "VibeVoice Large (RunPod)", supported_backends: ["runpod_serverless"] },
  ];
}

function createChinesePinyinText(text) {
  try {
    return pinyin(text, {
      nonZh: "removed",
      toneType: "symbol",
      type: "array",
    })
      .map((token) => String(token || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  } catch (error) {
    console.warn("practice pinyin generation failed", error);
    return "";
  }
}

// 「聞こえた言葉」の文字単位diffが使う正規化と同じ結果を返す。
// フロント側 practiceDisplayComparableText (practice_playback.js) と同じ規則
// (NFKC正規化、Punctuation/Symbolカテゴリの除去、空白の圧縮)にする。ここで返す
// 文字列のArray.from()した添字が、practiceDiffPinyinCharsの返り値の添字と一致する。
function practiceDiffComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// diff比較用の文字ごとの声調つきピンイン配列(非漢字は空文字列)を返す。
// 連続する漢字は文脈付きでまとめて変換する。非漢字位置を空文字列として残し、
// Array.from(comparable text)と同じ長さ・同じ添字を保証する。
function practiceDiffPinyinChars(text) {
  const comparable = practiceDiffComparableText(text);
  if (!comparable) return [];
  try {
    const chars = Array.from(comparable);
    const result = chars.map(() => "");
    const isHan = (char) => /\p{Script=Han}/u.test(char);
    let index = 0;
    while (index < chars.length) {
      if (!isHan(chars[index])) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < chars.length && isHan(chars[end])) end += 1;
      const tokens = pinyin(chars.slice(index, end).join(""), {
        toneType: "num",
        type: "array",
        nonZh: "removed",
      });
      if (tokens.length === end - index) {
        tokens.forEach((token, offset) => {
          result[index + offset] = token || "";
        });
      }
      index = end;
    }
    return result;
  } catch (error) {
    console.warn("practice diff pinyin generation failed", error);
    return Array.from(comparable).map(() => "");
  }
}

async function listAudioHistory(env) {
  return {
    settings: cloudflareHistoryDisabledSettings(),
    recordings: [],
    outputs: [],
  };
}

async function listPracticeHistory(env) {
  return {
    settings: cloudflareHistoryDisabledSettings(),
    recordings: [],
    outputs: [],
  };
}

function cloudflareHistoryDisabledSettings() {
  return {
    enabled: false,
    root: "Cloudflare公開版では音声履歴を保存しません。",
    resolved_root: "",
    metadata_store: "none",
    blob_store: "none",
    recordings_dir: "",
    outputs_dir: "",
    limit: 0,
    env_var: "",
  };
}

async function openAiTranscribe(env, { audioBytes, audioMimeType, sourceLanguage, filename }) {
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage,
    filename,
    model: env.OPENAI_ASR_MODEL || "gpt-4o-transcribe",
    includeTimestamps: false,
  });
  return transcription.text;
}

async function openAiTranscribeDetail(env, {
  audioBytes,
  audioMimeType,
  sourceLanguage,
  filename,
  model,
  includeTimestamps = false,
}) {
  requireEnv(env, "OPENAI_API_KEY");
  const requestedModel = String(model || env.OPENAI_ASR_MODEL || "gpt-4o-transcribe").trim() || "gpt-4o-transcribe";
  const asrModel = includeTimestamps ? supportedPracticeAsrModel(requestedModel) : requestedModel;
  const useTimestamps = includeTimestamps && OPENAI_TIMESTAMP_ASR_MODELS.has(asrModel);
  const responseFormat = useTimestamps ? "verbose_json" : openAiAsrResponseFormat(asrModel);
  const form = new FormData();
  form.append("model", asrModel);
  form.append("response_format", responseFormat);
  if (useTimestamps) {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }
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
  if (responseFormat === "text") {
    return {
      text: text.trim(),
      model: asrModel,
      timestamp_granularities: [],
      words: [],
      segments: [],
    };
  }
  return transcriptionFromOpenAiJson(text, asrModel, useTimestamps ? ["word", "segment"] : []);
}

function openAiAsrResponseFormat(model) {
  return OPENAI_JSON_ONLY_ASR_MODELS.has(model) ? "json" : "text";
}

function transcriptionFromOpenAiJson(text, model, timestampGranularities) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    return {
      text: String(text || "").trim(),
      model,
      timestamp_granularities: [],
      words: [],
      segments: [],
    };
  }
  return {
    text: String(payload.text || "").trim(),
    model,
    timestamp_granularities: timestampGranularities,
    words: normalizedAsrTimingRows(payload.words, "word"),
    segments: normalizedAsrTimingRows(payload.segments, "text"),
    raw_timestamp_word_count: Array.isArray(payload.words) ? payload.words.length : 0,
    raw_timestamp_segment_count: Array.isArray(payload.segments) ? payload.segments.length : 0,
    duration: Number.isFinite(Number(payload.duration)) && Number(payload.duration) > 0 ? Number(payload.duration) : null,
  };
}

function normalizedAsrTimingRows(rows, textKey) {
  return (rows || []).flatMap((row) => {
    const start = Number(row?.start);
    const end = Number(row?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return [];
    }
    return [{
      text: String(row?.[textKey] ?? row?.text ?? row?.word ?? ""),
      start,
      end,
    }];
  });
}

function serializeAsrTimestamps(transcription) {
  const words = transcription?.words || [];
  const segments = transcription?.segments || [];
  const rawWordCount = Number(transcription?.raw_timestamp_word_count ?? words.length);
  const rawSegmentCount = Number(transcription?.raw_timestamp_segment_count ?? segments.length);
  return {
    available: Boolean(rawWordCount || rawSegmentCount),
    model: transcription?.model || "",
    timestamp_granularities: transcription?.timestamp_granularities || [],
    words,
    segments,
    raw_timestamp_word_count: rawWordCount,
    raw_timestamp_segment_count: rawSegmentCount,
  };
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
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
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

function stateKv(env) {
  return env.MO_SPEECH_KV || null;
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

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
      model: env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
      instructions: instructions.join(" "),
      input: text,
    })
  ) || text;
}

async function submitRunpodJob(env, inputPayload) {
  return runpodRequest(env, "/run", {
    method: "POST",
    payload: runpodRequestPayload(inputPayload),
  });
}

function runpodRequestPayload(inputPayload) {
  return { input: inputPayload };
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
      throw httpError(response.status, `RunPod request failed with HTTP ${response.status}`);
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

function numberFormValue(form, key, fallback) {
  const number = Number.parseFloat(stringFormValue(form, key, String(fallback)));
  return Number.isFinite(number) ? number : fallback;
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
  const status = String(body?.status || "").toUpperCase();
  return status ? `RunPod job failed with status ${status}` : "RunPod job failed";
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
    throw new PracticeAlignmentInputError("unsupported_target_language");
  }
  return language;
}

function supportedPracticeAsrModel(value) {
  const model = String(value || OPENAI_DEFAULT_PRACTICE_ASR_MODEL).trim() || OPENAI_DEFAULT_PRACTICE_ASR_MODEL;
  if (!OPENAI_PRACTICE_ASR_MODELS.has(model)) {
    throw httpError(400, `unsupported practice ASR model: ${model}`);
  }
  return model;
}

export function splitPracticePhrases(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const phrases = [];
  let buffer = "";
  let index = 0;
  while (index < normalized.length) {
    const character = normalized[index];
    if (character === "\n") {
      appendSplitPhrase(phrases, buffer);
      buffer = "";
      index += 1;
      continue;
    }

    buffer += character;
    let isBoundary = PRACTICE_HARD_BOUNDARIES.has(character);
    if (character === ".") {
      isBoundary = !isProtectedPhrasePeriod(normalized, index);
    }
    if (!isBoundary) {
      index += 1;
      continue;
    }

    index += 1;
    while (index < normalized.length) {
      const suffix = normalized[index];
      if (PRACTICE_HARD_BOUNDARIES.has(suffix) || suffix === "." || PRACTICE_CLOSING_PUNCTUATION.has(suffix)) {
        buffer += suffix;
        index += 1;
        continue;
      }
      break;
    }
    appendSplitPhrase(phrases, buffer);
    buffer = "";
  }
  appendSplitPhrase(phrases, buffer);
  return phrases;
}

function appendSplitPhrase(phrases, value) {
  const phrase = String(value || "").trim();
  if (phrase && /[\p{L}\p{M}\p{N}]/u.test(phrase)) {
    phrases.push(phrase);
  }
}

function isProtectedPhrasePeriod(text, index) {
  const previous = index > 0 ? text[index - 1] : "";
  const following = index + 1 < text.length ? text[index + 1] : "";
  if (previous === "." || following === ".") return true;
  if (/\d/u.test(previous) && /\d/u.test(following)) return true;

  let tokenStart = index;
  while (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1])) tokenStart -= 1;
  let tokenEnd = index + 1;
  while (tokenEnd < text.length && !/\s/u.test(text[tokenEnd])) tokenEnd += 1;
  const token = text.slice(tokenStart, tokenEnd);
  const position = index - tokenStart;
  if (token.includes("@") && position + 1 < token.length && /[\p{L}\p{N}]/u.test(token[position + 1])) {
    return true;
  }
  if (/^(https?:\/\/|www\.)/iu.test(token) && position + 1 < token.length) {
    return !PRACTICE_HARD_BOUNDARIES.has(token[position + 1]);
  }

  let wordStart = index;
  while (wordStart > 0 && /[a-z]/iu.test(text[wordStart - 1])) wordStart -= 1;
  const abbreviation = text.slice(wordStart, index).toLowerCase();
  const hasFollowingWord = [...text.slice(index + 1)].some((character) => !/\s/u.test(character));
  return PRACTICE_PROTECTED_ABBREVIATIONS.has(abbreviation) && hasFollowingWord;
}

function normalizeChineseVariants(text) {
  return traditionalChineseToSimplified(String(text || ""));
}

function canonicalPracticeText(text, targetLanguage) {
  return targetLanguage === "zh-CN"
    ? normalizeChineseVariants(text)
    : String(text || "");
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
