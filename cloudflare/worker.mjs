import { pinyin } from "pinyin-pro";
import { Converter } from "opencc-js/t2cn";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import {
  lookupPracticeModelAsrCache,
  practiceModelAsrCacheKey,
  serializeAsrTimestamps,
  storePracticeModelAsrCache,
} from "./src/practice-model-asr-cache.ts";
import { handleZoovoiceApiRequest } from "./zoovoice-gateway.mjs";
import {
  CREDIT_ERROR_INVALID_REQUEST,
  CREDIT_UNAVAILABLE_MISCONFIGURED,
  resolveCreditClient,
} from "./credit-client.mjs";

const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
const RUNPOD_TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const RUNPOD_RUNNING_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "RUNNING"]);
const PRACTICE_LLM_ATTEMPT_OPTIONS_KV_PREFIX = "practice-attempt-llm-options:";
const CREDIT_RESERVE_MARKER_KV_PREFIX = "credit-reserve:";
const CREDIT_PRODUCT = "voice-lab";
// 消費credit（credit-base docs/billing-spec.md §10）。事前に決まる固定額
const CREDIT_FEATURE_AMOUNTS = {
  "practice-prompts": 5,
  "practice-recordings": 8,
  "practice-attempt-jobs": 10,
  "voice-conversion-jobs": 30,
};
const CREDIT_SYNC_RESERVE_TTL_SECONDS = 600;
const CREDIT_JOB_RESERVE_TTL_SECONDS = 600;
// GPU実費の換算。§10の voice-conversion-jobs（120秒で予約額30）から 30/120 = 0.25。
// 実測で単価が確定したら差し替える（§11の未決事項）
const CREDIT_RUNPOD_CREDITS_PER_SECOND = 0.25;
// 状態を取り戻せなくなった予約を failed へ倒すまでの猶予
const CREDIT_UNKNOWN_JOB_GRACE_SECONDS = 60 * 60 * 24;
// 残高不足を伝える固定文言。残高の数値も台帳の状態も出さず、チャージが要ることだけを伝える
const CREDIT_INSUFFICIENT_PUBLIC_MESSAGE = "クレジットが不足しています。チャージしてからもう一度お試しください。";
const PRACTICE_ATTEMPT_RESULT_KV_PREFIX = "practice-attempt-result:";
// フロントエンド(app_practice.js)のattempt-jobsポーリング締め切りは30分。RunPodジョブが
// 完了するまでこの時間だけ待たれ得るため、comparison_model等を保持するKVのTTLは
// その締め切りに余裕を持たせた長さが必要(短いと完了時にoptionsが消えて選択したモデルを
// 見失う)。
const PRACTICE_ATTEMPT_POLL_WINDOW_SECONDS = 30 * 60;
const PRACTICE_LLM_ATTEMPT_OPTIONS_DEFAULT_TTL_SECONDS = PRACTICE_ATTEMPT_POLL_WINDOW_SECONDS + 10 * 60;
const RUNPOD_VC_READY_KV_KEY_PREFIX = "runpod:seed-vc-ready:";
const PUBLIC_ACCESS_SETTINGS_KV_KEY = "public-access-settings";
const PUBLIC_AUDIT_LOG_KV_KEY = "public-audit-log";
const PUBLIC_AUDIT_D1_MIGRATED_KV_KEY = "public-audit-log:d1-migrated";
const PUBLIC_AUDIT_LOG_DEFAULT_LIMIT = 500;
const PUBLIC_USERS_DEFAULT_LIMIT = 200;
const PUBLIC_USERS_MAX_LIMIT = 2000;
const PUBLIC_AUDIT_RETENTION_SECONDS = 60 * 60 * 24 * 90;
const PUBLIC_DAILY_QUOTA_RETENTION_SECONDS = 60 * 60 * 48;
const PUBLIC_SAMPLE_AUDIOS_KV_KEY = "public-sample-audios";
const PUBLIC_SAMPLE_AUDIO_MAX_BASE64_CHARS = 2_500_000;
const PUBLIC_SAMPLE_LANGUAGES = ["ja-JP", "zh-CN", "en-US"];
const PUBLIC_USAGE_KV_PREFIX = "public-usage:";
const PUBLIC_SESSION_COOKIE = "mo_public_session";
const PUBLIC_OAUTH_STATE_COOKIE = "mo_google_oauth_state";
const PUBLIC_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const NATIVE_SESSION_TTL_SECONDS = 60 * 60;
const GOOGLE_ID_TOKEN_MAX_BYTES = 16 * 1024;
const NATIVE_SESSION_REQUEST_MAX_BYTES = GOOGLE_ID_TOKEN_MAX_BYTES + 512;
const PUBLIC_OAUTH_STATE_TTL_SECONDS = 60 * 10;
const PUBLIC_ACCESS_FEATURES = ["speakloop", "voice_conversion"];
const GOOGLE_ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
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

function practiceLlmClampedPlaybackRange(words, { startIndex, endIndex, duration, padding, label }) {
  const selected = words.slice(startIndex, endIndex);
  const start = practiceLlmRequiredFiniteNumber(selected[0].start, `${label} word start`);
  const end = practiceLlmRequiredFiniteNumber(selected[selected.length - 1].end, `${label} word end`);
  const audioDuration = practiceLlmRequiredFiniteNumber(duration, `${label} audio duration`);

  let playbackStart = Math.max(0, start - padding);
  if (startIndex > 0) {
    const previousEnd = practiceLlmRequiredFiniteNumber(words[startIndex - 1].end, `${label} previous word end`);
    playbackStart = previousEnd < start ? Math.max(playbackStart, previousEnd) : start;
  }

  let playbackEnd = Math.min(audioDuration, end + padding);
  if (endIndex < words.length) {
    const nextStart = practiceLlmRequiredFiniteNumber(words[endIndex].start, `${label} next word start`);
    playbackEnd = nextStart > end ? Math.min(playbackEnd, nextStart) : Math.min(audioDuration, end);
  }
  return { playbackStart, playbackEnd };
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
  const { playbackStart, playbackEnd } = practiceLlmClampedPlaybackRange(words, {
    startIndex,
    endIndex,
    duration: audioDuration,
    padding,
    label,
  });
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
  const key = practiceModelAsrCacheKey(digest, "runpod-funasr-fa-zh-v1", sourceLanguage);
  const cached = await lookupPracticeModelAsrCache(env, key);
  return { key, cached };
}

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
    voice_conversion: null,
  },
};

let ephemeralPublicAccessSettings = null;
const ephemeralPracticeAttemptLlmOptions = new Map();
const ephemeralPracticeAttemptResults = new Map();
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
  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return robotsResponse(env, url);
  }
  if (request.method === "GET" && url.pathname === "/sitemap.xml") {
    return sitemapResponse(env, url);
  }
  return serveAsset(request, env, url);
}

const CRAWL_DISALLOWED_PATHS = ["/admin", "/speakloop/admin", "/api/", "/auth/"];
const SITEMAP_PUBLIC_PATHS = ["/", "/speakloop", "/privacy"];

// クロール許可は正規公開originだけに与える。PUBLIC_GOOGLE_AUTH_REQUIREDは生成API用の
// 設定でページ閲覧を制限しないため、クロール可否の判定に使わない。
function crawlingAllowed(env, url) {
  const canonical = String(env.PUBLIC_CANONICAL_ORIGIN || "").trim().replace(/\/+$/, "");
  return Boolean(canonical) && canonical === url.origin;
}

function robotsResponse(env, url) {
  const lines = crawlingAllowed(env, url)
    ? [
      "User-agent: *",
      ...CRAWL_DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
      "",
      `Sitemap: ${url.origin}/sitemap.xml`,
    ]
    : ["User-agent: *", "Disallow: /"];
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function sitemapResponse(env, url) {
  if (!crawlingAllowed(env, url)) {
    return new Response("Not Found", { status: 404 });
  }
  const urls = SITEMAP_PUBLIC_PATHS
    .map((path) => `  <url><loc>${url.origin}${path}</loc></url>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

function isPublicAuthPath(pathname) {
  const path = normalizePathname(pathname);
  return path === "/auth/google/login" || path === "/auth/google/callback" || path === "/auth/logout";
}

function isProtectedAdminPagePath(pathname) {
  const path = normalizePathname(pathname);
  return new Set([
    "/admin",
    "/index.html",
    "/static/index.html",
    "/speakloop/admin",
    "/practice_admin.html",
    "/static/practice_admin.html",
  ]).has(path);
}

function isProtectedAdminApiRequest(method, pathname) {
  if (method === "OPTIONS") {
    return false;
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
  if (method === "GET" && pathname === "/api/public-users") {
    return true;
  }
  if (method === "POST" && pathname === "/api/warmup") {
    return true;
  }
  if (method === "GET" && pathname.startsWith("/api/warmup/")) {
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
    sub: String(userInfo.sub || ""),
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

async function handleNativeSessionRequest(request, env) {
  const responseInit = { headers: { "Cache-Control": "no-store" } };
  try {
    if (!String(env.GOOGLE_CLIENT_ID || "").trim() || !publicSessionSecret(env)) {
      throw httpError(503, "native session is not configured");
    }
    const text = await readRequestTextWithLimit(request, NATIVE_SESSION_REQUEST_MAX_BYTES);
    let body;
    try {
      body = JSON.parse(text);
    } catch (_error) {
      throw httpError(400, "invalid native session request");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id_token !== "string" || !body.id_token) {
      throw httpError(400, "invalid native session request");
    }
    const idToken = body.id_token;
    if (new TextEncoder().encode(idToken).byteLength > GOOGLE_ID_TOKEN_MAX_BYTES) {
      throw httpError(413, "Google ID token is too large");
    }
    const identity = await verifyNativeGoogleIdToken(idToken, env);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(now + NATIVE_SESSION_TTL_SECONDS, identity.exp);
    if (expiresAt <= now) {
      throw httpError(401, "invalid Google ID token");
    }
    const sessionToken = await createPublicSessionValue(env, { email: identity.email, sub: identity.sub }, expiresAt);
    const settings = await readPublicAccessSettings(env);
    await recordPublicUserLogin(env, identity.email);
    await appendPublicAuditEvent(env, {
      action: "google_native_login_success",
      email: identity.email,
      is_admin: isPublicAdminEmail(identity.email, settings),
      ...requestAuditContext(request),
    });
    return jsonResponse({
      session_token: sessionToken,
      token_type: "Bearer",
      expires_at: expiresAt,
    }, responseInit);
  } catch (error) {
    const status = Number(error?.status || 500);
    if (status >= 500) {
      console.error("native session exchange failed", JSON.stringify({ status }));
    }
    const detail = status === 500 ? "native session exchange failed" : errorMessage(error);
    return jsonResponse({ detail }, { ...responseInit, status });
  }
}

async function verifyNativeGoogleIdToken(idToken, env) {
  const audience = String(env.GOOGLE_CLIENT_ID || "").trim();
  const keyResolver = env.__googleJwks || GOOGLE_JWKS;
  let verified;
  try {
    verified = await jwtVerify(idToken, keyResolver, {
      algorithms: ["RS256"],
      issuer: GOOGLE_ID_TOKEN_ISSUERS,
      audience,
      requiredClaims: ["exp", "sub", "email", "email_verified"],
    });
  } catch (error) {
    if (
      error instanceof joseErrors.JWKSTimeout
      || error instanceof joseErrors.JWKInvalid
      || error instanceof joseErrors.JWKSInvalid
      || error?.constructor === joseErrors.JOSEError
      || !(error instanceof joseErrors.JOSEError)
    ) {
      throw httpError(503, "Google token verification is unavailable");
    }
    throw httpError(401, "invalid Google ID token");
  }
  const { payload, protectedHeader } = verified;
  const email = normalizeEmail(payload.email);
  if (
    protectedHeader.alg !== "RS256"
    || payload.aud !== audience
    || !GOOGLE_ID_TOKEN_ISSUERS.includes(String(payload.iss || ""))
    || typeof payload.sub !== "string"
    || !payload.sub.trim()
    || typeof payload.email !== "string"
    || !email
    || payload.email_verified !== true
    || !Number.isFinite(payload.exp)
  ) {
    throw httpError(401, "invalid Google ID token");
  }
  return { sub: payload.sub, email, exp: Number(payload.exp) };
}

async function readRequestTextWithLimit(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw httpError(413, "request body is too large");
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("request body is too large");
      throw httpError(413, "request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
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
  const value = await createPublicSessionValue(env, user, now + ttl, now);
  return `${PUBLIC_SESSION_COOKIE}=${value}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`;
}

async function createPublicSessionValue(env, user, expiresAt, issuedAt = Math.floor(Date.now() / 1000)) {
  return createSignedPayload({
    email: normalizeEmail(user.email),
    // Googleのsubject IDは課金基盤の主体ID（google:<sub>）を組むために要る。
    // emailは変わり得るので、台帳の主体をemailに紐づけない。
    sub: String(user.sub || ""),
    iat: issuedAt,
    exp: expiresAt,
  }, publicSessionSecret(env));
}

async function readPublicSession(request, env) {
  const secret = publicSessionSecret(env);
  if (!secret) {
    return null;
  }
  const authorization = request.headers.get("Authorization");
  let value = "";
  if (authorization !== null) {
    const match = /^Bearer[\t ]+([^\s,]+)[\t ]*$/i.exec(authorization);
    value = match?.[1] || "";
  } else {
    const cookies = parseCookies(request.headers.get("cookie") || "");
    value = cookies.get(PUBLIC_SESSION_COOKIE) || "";
  }
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
      // subを持たないのはこの項目を載せる前に発行されたセッション。空文字で返し、
      // 呼び出し側がクレジット消費を見送れるようにする（再ログインで解消する）。
      sub: String(payload.sub || ""),
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
    if (request.method === "POST" && url.pathname === "/api/native-session") {
      return handleNativeSessionRequest(request, env);
    }
    const zoovoiceResponse = await handleZoovoiceApiRequest(request, env, url);
    if (zoovoiceResponse) {
      return zoovoiceResponse;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/internal/credit-jobs/")) {
      // awaitを外すと、rejectがこのtryを抜けた後に起きて401へ変換されない
      return await handleCreditJobStatusRequest(request, env, url);
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
    if (request.method === "GET" && url.pathname === "/api/public-users") {
      return jsonResponse(await readPublicUsers(env, url));
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
    // 予約を取った後に落ちたリクエストの枠を返す。取っていなければ何もしない
    await releaseCreditConsumptionForRequest(request);
    if (error instanceof PracticeAlignmentInputError) {
      return jsonResponse(practiceAlignmentErrorEnvelope(error), { status: 400 });
    }
    if (error instanceof PracticeAlignmentError) {
      return jsonResponse(practiceAlignmentErrorEnvelope(error), { status: 502 });
    }
    if (error instanceof PracticeLlmError) {
      return jsonResponse(practiceLlmErrorEnvelope(error), { status: 502 });
    }
    console.error("api request failed", JSON.stringify({
      method: request.method,
      path: url.pathname,
      status: error.status || 500,
      detail: errorMessage(error).slice(0, 300),
    }));
    // codeは機械判定用の追加情報。codeを持たない既存のエラーの応答本文は変わらない
    const envelope = { detail: errorMessage(error) };
    if (error?.code) envelope.code = error.code;
    return jsonResponse(envelope, { status: error.status || 500 });
  }
}

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return new Response("Cloudflare static assets binding is not configured.", { status: 503 });
  }
  if (
    env.ZOOVOICE_ENABLED !== "1"
    && ["/zoovoice", "/react/zoovoice.html"].includes(normalizePathname(url.pathname))
  ) {
    return new Response("Not Found", { status: 404 });
  }
  const assetUrl = new URL(request.url);
  const retiredPaths = new Set([
    "/fun",
    "/user",
    "/skitvoice",
    "/skitvoice/admin",
    "/vibevoice",
    "/vibevoice/simple",
    "/vibevoice/admin",
    "/seed-vc",
    "/user.html",
    "/vibevoice.html",
    "/vibevoice_simple.html",
    "/seed_vc.html",
    "/static/user.html",
    "/static/app_user.js",
    "/static/app_realtime.js",
    "/static/app_admin_settings.js",
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
  } else if (url.pathname === "/speakloop" || url.pathname === "/speakloop/") {
    assetUrl.pathname = "/react/speakloop.html";
  } else if (url.pathname === "/zoovoice" || url.pathname === "/zoovoice/") {
    assetUrl.pathname = "/react/zoovoice.html";
  } else if (
    url.pathname === "/speakloop/admin" ||
    url.pathname === "/speakloop/admin/"
  ) {
    assetUrl.pathname = "/practice_admin.html";
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

export async function runtimeResponse(env = {}) {
  try {
    return jsonResponse(await runtimePayload(env));
  } catch (error) {
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

export async function runtimePayload(env) {
  const runpodAvailable = Boolean(env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY);
  const openaiAvailable = Boolean(env.OPENAI_API_KEY);
  const health = runpodAvailable && env.RUNPOD_RUNTIME_HEALTH_CHECK !== "0"
    ? await runpodHealthSummary(env)
    : { checked: false, warm: false, worker_counts: {} };
  const warmup = runpodAvailable ? await readRunpodVcReadyState(env) : runpodVcReadyState(false);
  const seedVcModelResident = Boolean(warmup.ready);
  return {
    provider_mode: "cloudflare",
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    supported_voice_modes: ["default"],
    ui_capabilities: {
      practice_developer_settings: false,
      practice_history_preview: false,
    },
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
      if (row.language && row.language !== "und") {
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
  return structuredClone(samples);
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
      rows.push({ feature, language: "und", sample: value });
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

async function enforcePublicFeatureAccess(request, env, feature, limits = {}, credit = null) {
  const settings = await readPublicAccessSettings(env);
  const featureSettings = settings.features[feature] || {};
  validatePublicInputLimits(featureSettings, limits);
  if (feature === "voice_conversion") {
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
    return { settings, consumed: false, authenticated: true, is_admin: true, email: session.email, consumption: inactiveCreditConsumption() };
  }
  if (!settings.google_login_required) {
    return { settings, consumed: false, authenticated: false, is_admin: false, consumption: inactiveCreditConsumption() };
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
    return { settings, consumed: false, authenticated: true, is_admin: true, email: session.email, consumption: inactiveCreditConsumption() };
  }
  try {
    await consumePublicQuota(env, feature, session.email, featureSettings, request);
  } catch (error) {
    // 無料枠の超過だけをクレジット経路へ回す。他の429と取り違えないよう目印で判定する
    if (!error?.publicQuotaExceeded) throw error;
    const consumption = await startCreditConsumption(request, env, session, credit);
    if (!consumption) throw error;
    return { settings, consumed: false, authenticated: true, is_admin: false, email: session.email, consumption };
  }
  return { settings, consumed: true, authenticated: true, is_admin: false, email: session.email, consumption: inactiveCreditConsumption() };
}

/**
 * 進行中の予約をリクエストごとに覚えておく。
 *
 * 予約を取ってから応答が確定するまでのあいだに何が落ちても枠を返せるよう、後始末は
 * リクエストの出口（handleApiRequest の catch）に1か所だけ置く。各ハンドラの本文を
 * try/catch で囲って回ると、AI呼び出しと応答生成のどちらの失敗も拾い漏らしやすい。
 */
const activeCreditConsumptions = new WeakMap();

/** 応答が確定しなかったリクエストの枠を返す。精算済みなら何もしない */
async function releaseCreditConsumptionForRequest(request) {
  const consumption = request ? activeCreditConsumptions.get(request) : null;
  if (!consumption) return;
  activeCreditConsumptions.delete(request);
  try {
    await consumption.release();
  } catch (error) {
    // 課金の後始末の失敗で、利用者が受け取るエラーの中身をすり替えない
    console.error("credit release failed", JSON.stringify({ detail: errorMessage(error).slice(0, 200) }));
  }
}

/** クレジットを使わなかったときの受け皿。呼び出し元が分岐せずに済むようにする */
function inactiveCreditConsumption() {
  return {
    active: false,
    reserveKey: "",
    amount: 0,
    async settle() {},
    async release() {},
    async attachJob() {},
  };
}

/**
 * 無料枠を超えた利用者のために、credit-base で枠を取る。
 *
 * 取れなければ null を返し、呼び出し元は元の429をそのまま投げる。クレジットを使えない理由は
 * 監査ログへ種別つきで残す。原因（未設定・設定の誤り・subject不明）を後から分けられないと運用で困る。
 *
 * 仕様§4の charge ではなく reserve→settle を使う。charge は「残高判定 → AI実行 → 記帳」の
 * 3手に分かれ、判定と記帳のあいだに同一subjectの並行リクエストが残高を使い切れる。
 * reserve は条件付きINSERTひとつで枠取りと残高判定を同時に行うので、その競合が閉じる。
 */
async function startCreditConsumption(request, env, session, credit) {
  if (!credit?.feature) return null;
  if (env.CREDIT_CONSUME_ENABLED !== "1") return null;

  const auditBase = { feature: credit.feature, email: session.email, ...requestAuditContext(request) };
  if (!env.MO_SPEECH_DB) {
    // 対応表を書けない。予約を作ると誰も精算できなくなるので、クレジット経路ごと止める
    await appendPublicAuditEvent(env, { action: "credit_disabled_no_db", ...auditBase });
    return null;
  }
  const { client, reason } = resolveCreditClient(env);
  if (!client) {
    await appendPublicAuditEvent(env, {
      action: reason === CREDIT_UNAVAILABLE_MISCONFIGURED ? "credit_disabled_misconfigured" : "credit_disabled_no_client",
      ...auditBase,
    });
    return null;
  }
  if (!(creditRunpodRatePerSecond(env) > 0)) {
    // 単価の打ち間違いを黙って通すと、どのGPUジョブも最小の1creditへ丸められて請求漏れが続く
    await appendPublicAuditEvent(env, { action: "credit_disabled_misconfigured", ...auditBase });
    return null;
  }
  if (!String(env.CREDIT_BASE_CALLBACK_SECRET || "").trim() || !String(env.PUBLIC_CANONICAL_ORIGIN || "").trim()) {
    // 照会先を署名して組めないと callback_url なしで予約することになる。credit-base の cron は
    // 照会先の無い予約を掃除せず保留し続けるので、手で精算するまで残り続ける
    await appendPublicAuditEvent(env, { action: "credit_disabled_misconfigured", ...auditBase });
    return null;
  }
  if (!session.sub) {
    // この項目を載せる前に発行されたセッション。再ログインで解消する
    await appendPublicAuditEvent(env, { action: "credit_skipped_no_subject", ...auditBase });
    return null;
  }

  const subjectId = `google:${session.sub}`;
  const amount = CREDIT_FEATURE_AMOUNTS[credit.feature];
  const reserveKey = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const ttlSeconds = credit.kind === "sync" ? creditSyncReserveTtl(env) : creditJobReserveTtl(env);

  let result;
  try {
    result = await client.reserve({
      subjectId,
      amount,
      product: CREDIT_PRODUCT,
      feature: credit.feature,
      idempotencyKey: reserveKey,
      callbackUrl: await creditCallbackUrl(env, reserveKey, issuedAt),
      ttlSeconds,
    });
  } catch (error) {
    await appendPublicAuditEvent(env, {
      action: error?.creditKind === CREDIT_ERROR_INVALID_REQUEST ? "credit_call_invalid" : "credit_call_failed",
      method: "reserve",
      idempotency_key: reserveKey,
      ...auditBase,
    });
    // AIをまだ呼んでいないので中止する。課金基盤が使えない状態を無料枠超過と偽らない
    throw httpError(503, "credit service is unavailable");
  }

  if (result.status === "insufficient_balance") {
    await appendPublicAuditEvent(env, { action: "credit_insufficient", amount, ...auditBase });
    throw httpError(402, CREDIT_INSUFFICIENT_PUBLIC_MESSAGE, { code: "credit_insufficient" });
  }

  const consumption = {
    active: true,
    reserveKey,
    amount,
    async settle(actualAmount) {
      activeCreditConsumptions.delete(request);
      await settleCreditReservation(env, { client, reserveKey, actualAmount, reservedAmount: amount, auditBase });
    },
    async release() {
      activeCreditConsumptions.delete(request);
      await releaseCreditReservation(env, { client, reserveKey, auditBase });
    },
    // 非同期経路は投入後に精算をポーリング側へ渡す。ここで登録を解いて、
    // 応答が返った後に枠が返されないようにする
    async attachJob(jobId) {
      activeCreditConsumptions.delete(request);
      if (!jobId) {
        // RunPodがidを返さなければ、あとからジョブの終了状態を照会する手立てが無い。
        // 予約のTTL切れをcronに待たせず、その場で枠を返す
        await releaseCreditReservation(env, { client, reserveKey, auditBase });
        return;
      }
      await attachCreditReservationJobId(env, reserveKey, jobId);
      await saveCreditReserveMarker(env, jobId, reserveKey, ttlSeconds + CREDIT_UNKNOWN_JOB_GRACE_SECONDS);
    },
  };
  // 対応表へ書く前に登録する。書き込みが落ちたとき、credit-base には予約だけが残り、
  // 対応表に行が無いので照会エンドポイントは「状態不明」の猶予（24時間）へ落ちる。
  // 先に登録しておけば、このリクエストの出口でその場で枠が返る
  activeCreditConsumptions.set(request, consumption);
  await insertCreditReservation(env, {
    reserveKey,
    subjectId,
    feature: credit.feature,
    kind: credit.kind,
    reservedAmount: amount,
    now: issuedAt,
  });
  await appendPublicAuditEvent(env, { action: "credit_reserved", amount, idempotency_key: reserveKey, ...auditBase });
  return consumption;
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
    throw httpError(429, "public quota exceeded", { publicQuotaExceeded: true });
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
    throw httpError(429, "public quota exceeded", { publicQuotaExceeded: true });
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
    throw httpError(429, "public quota exceeded", { publicQuotaExceeded: true });
  }
  if (totalLimit >= 0 && totalUsed >= totalLimit) {
    await appendPublicAuditEvent(env, { action: "public_quota_blocked", email, feature, limit_type: "total", used: totalUsed, limit: totalLimit, ...requestAuditContext(request) });
    throw httpError(429, "public quota exceeded", { publicQuotaExceeded: true });
  }
  const now = new Date().toISOString();
  await env.MO_SPEECH_DB.batch([
    env.MO_SPEECH_DB.prepare(
      "INSERT INTO public_users (email_hash, email, created_at, last_seen_at, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_hash) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at",
    ).bind(emailHash, normalizeEmail(email), now, now, null),
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

/**
 * credit-base の予約と、voice-lab 側の処理・RunPodジョブの対応表。
 *
 * SQLはこの定数群だけに置く。テストのfake D1はこの定数と完全一致で分岐するので、
 * 本体側で文を変えるとfakeが即座に「知らない問い合わせ」で落ちる。部分一致で拾わせると、
 * 文を変えてもfakeが古い解釈のまま応え続け、テストが素通りする。
 */
const CREDIT_RESERVATION_COLUMNS =
  "reserve_key, job_id, subject_id, feature, kind, reserved_amount, status, "
  + "job_status, execution_time_ms, settled_amount, created_at, resolved_at";

export const CREDIT_RESERVATION_SQL = {
  insert:
    "INSERT INTO credit_job_reservations "
    + "(reserve_key, job_id, subject_id, feature, kind, reserved_amount, status, created_at) "
    + "VALUES (?, NULL, ?, ?, ?, ?, 'in_flight', ?)",
  attachJobId:
    "UPDATE credit_job_reservations SET job_id = ? WHERE reserve_key = ?",
  recordOutcome:
    "UPDATE credit_job_reservations SET job_status = ?, execution_time_ms = ? "
    + "WHERE reserve_key = ? AND status = 'in_flight'",
  finalize:
    "UPDATE credit_job_reservations SET status = ?, settled_amount = ?, resolved_at = ? "
    + "WHERE reserve_key = ? AND status = 'in_flight'",
  selectByKey:
    `SELECT ${CREDIT_RESERVATION_COLUMNS} FROM credit_job_reservations WHERE reserve_key = ?`,
  selectByJobId:
    `SELECT ${CREDIT_RESERVATION_COLUMNS} FROM credit_job_reservations WHERE job_id = ?`,
  deleteResolved:
    "DELETE FROM credit_job_reservations WHERE status != 'in_flight' AND resolved_at < ?",
};

async function insertCreditReservation(env, { reserveKey, subjectId, feature, kind, reservedAmount, now }) {
  await env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.insert)
    .bind(reserveKey, subjectId, feature, kind, reservedAmount, now)
    .run();
}

async function attachCreditReservationJobId(env, reserveKey, jobId) {
  await env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.attachJobId).bind(jobId, reserveKey).run();
}

/**
 * 観測したジョブの終了状態を残す。精算より先に呼ぶ。
 * 精算が落ちても、この記録があればcronが照会エンドポイント経由で決着できる。
 */
async function recordCreditReservationOutcome(env, reserveKey, jobStatus, executionTimeMs) {
  await env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.recordOutcome)
    .bind(jobStatus, Number.isFinite(executionTimeMs) ? Math.max(0, Math.round(executionTimeMs)) : null, reserveKey)
    .run();
}

/** 精算が決着したことを記録し、以後の再試行を止める */
async function finalizeCreditReservation(env, reserveKey, status, settledAmount, now) {
  await env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.finalize)
    .bind(status, Number.isFinite(settledAmount) ? settledAmount : null, now, reserveKey)
    .run();
}

async function findCreditReservationByKey(env, reserveKey) {
  return env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.selectByKey).bind(reserveKey).first();
}

async function findCreditReservationByJobId(env, jobId) {
  return env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.selectByJobId).bind(jobId).first();
}

/**
 * 予約のあるジョブだけに印を付けておく。
 *
 * ポーリングはまずこの印を読み、無ければ対応表を引かない。無料枠の利用者は印を持たないので、
 * 課金と無関係なポーリングにD1読みが増えない。KVが無い環境では印を介さず対応表を直接引く
 * （印は読みを省くための最適化であって、正しさをここへ預けない）。
 */
async function saveCreditReserveMarker(env, jobId, reserveKey, ttlSeconds) {
  const kv = stateKv(env);
  if (!kv || !jobId) return;
  await kv.put(`${CREDIT_RESERVE_MARKER_KV_PREFIX}${jobId}`, reserveKey, { expirationTtl: ttlSeconds });
}

async function readCreditReserveMarker(env, jobId) {
  const kv = stateKv(env);
  if (!kv || !jobId) return null;
  return kv.get(`${CREDIT_RESERVE_MARKER_KV_PREFIX}${jobId}`);
}

async function deleteCreditReserveMarker(env, jobId) {
  const kv = stateKv(env);
  if (!kv || !jobId) return;
  await kv.delete(`${CREDIT_RESERVE_MARKER_KV_PREFIX}${jobId}`);
}

/**
 * 精算する。対応表へ観測結果を先に書いてから credit-base を呼ぶ。
 *
 * 先に書くのは2つの理由から。credit-base の呼び出しが落ちても、cron が照会エンドポイント経由で
 * 決着できる。そして精算額を必ず記録値から算出できるので、再試行のたびに額が変わって
 * 冪等キーの衝突（idempotency_key_conflict）になることがない。
 */
async function settleCreditReservation(env, { client, reserveKey, actualAmount, reservedAmount, executionTimeMs = null, auditBase = {} }) {
  await recordOutcomeQuietly(env, reserveKey, "succeeded", executionTimeMs, auditBase);
  const amount = Number.isFinite(actualAmount) && actualAmount >= 1 ? Math.round(actualAmount) : reservedAmount;
  let result;
  try {
    result = await client.settle({ reserveKey, actualAmount: amount, idempotencyKey: `vl:${reserveKey}:settle` });
  } catch (error) {
    await appendPublicAuditEvent(env, {
      action: error?.creditKind === CREDIT_ERROR_INVALID_REQUEST ? "credit_call_invalid" : "credit_call_failed",
      method: "settle",
      idempotency_key: `vl:${reserveKey}:settle`,
      ...auditBase,
    });
    return;
  }
  await finishCreditSettlement(env, {
    reserveKey,
    result,
    settledAmount: amount,
    recordedAction: "credit_settled",
    auditBase: { ...auditBase, amount },
  });
  if (Number(result.unbilledOverage || 0) > 0) {
    await appendPublicAuditEvent(env, {
      action: "credit_unbilled_overage",
      unbilled_overage: Number(result.unbilledOverage),
      ...auditBase,
    });
  }
}

/** 枠を返す。処理が失敗したときと、ジョブを投入できなかったときに使う */
async function releaseCreditReservation(env, { client, reserveKey, auditBase = {} }) {
  await recordOutcomeQuietly(env, reserveKey, "failed", null, auditBase);
  let result;
  try {
    result = await client.release({ reserveKey, idempotencyKey: `vl:${reserveKey}:release` });
  } catch (error) {
    await appendPublicAuditEvent(env, {
      action: error?.creditKind === CREDIT_ERROR_INVALID_REQUEST ? "credit_call_invalid" : "credit_call_failed",
      method: "release",
      idempotency_key: `vl:${reserveKey}:release`,
      ...auditBase,
    });
    return;
  }
  await finishCreditSettlement(env, {
    reserveKey,
    result,
    settledAmount: 0,
    recordedAction: "credit_released",
    auditBase,
  });
}

/**
 * 対応表を終端へ移し、再試行を止める。
 *
 * recorded 以外の3つも「これ以上呼んでも状況が変わらない」ことを意味する。in_flight のまま
 * 残すとポーリングのたびに同じ呼び出しを繰り返し、保持規則（終端の行だけ消す）で永久に残る。
 */
async function finishCreditSettlement(env, { reserveKey, result, settledAmount, recordedAction, auditBase }) {
  const now = new Date().toISOString();
  if (result.status === "recorded") {
    const status = recordedAction === "credit_settled" ? "settled" : "released";
    // 記録するのは台帳へ実際に入った額。実費が予約額を超えるとcredit-base側で頭打ちになるので、
    // こちらが送った額のまま残すと、照会エンドポイントが台帳と食い違う値を返す
    const billed = Number.isFinite(Number(result.billed)) ? Number(result.billed) : settledAmount;
    await finalizeQuietly(env, reserveKey, status, billed, now, auditBase);
    await appendPublicAuditEvent(env, { action: recordedAction, idempotency_key: reserveKey, ...auditBase });
    return;
  }
  await finalizeQuietly(env, reserveKey, "resolved_elsewhere", settledAmount, now, auditBase);
  if (result.status === "idempotency_key_conflict") {
    // 単価を改定した直後の再試行を除き、起きてはならない
    await appendPublicAuditEvent(env, {
      action: "credit_idempotency_conflict",
      idempotency_key: reserveKey,
      ...auditBase,
    });
  }
}

/**
 * 台帳の記帳が確定した後の手元の後始末は、落ちても利用者への応答を壊さない。
 *
 * ここで例外を投げると、課金は済んでいるのに同期経路が500を返し、利用者は結果を失う。
 * 行が `in_flight` のまま残っても、次のポーリングが `duplicate` か `already_settled` を受けて
 * 終端化するか、cronが照会エンドポイント経由で決着させる。
 */
async function finalizeQuietly(env, reserveKey, status, settledAmount, now, auditBase) {
  try {
    await finalizeCreditReservation(env, reserveKey, status, settledAmount, now);
  } catch (_error) {
    await appendPublicAuditEvent(env, { action: "credit_call_failed", method: "finalize", ...auditBase });
  }
}

/** 観測結果の記録が落ちても精算は試みる。ここで止めると、成功した処理が無料になる */
async function recordOutcomeQuietly(env, reserveKey, jobStatus, executionTimeMs, auditBase) {
  try {
    await recordCreditReservationOutcome(env, reserveKey, jobStatus, executionTimeMs);
  } catch (_error) {
    await appendPublicAuditEvent(env, { action: "credit_call_failed", method: "record_outcome", ...auditBase });
  }
}

function creditSyncReserveTtl(env) {
  return numberFromEnv(env.CREDIT_SYNC_RESERVE_TTL_SECONDS, CREDIT_SYNC_RESERVE_TTL_SECONDS);
}

function creditJobReserveTtl(env) {
  return numberFromEnv(env.CREDIT_JOB_RESERVE_TTL_SECONDS, CREDIT_JOB_RESERVE_TTL_SECONDS);
}

/**
 * cronがジョブの終了状態を照会する先を組む。
 *
 * credit-base のcronは認証ヘッダを送らないので、URL自体に署名を載せる。iat を署名対象へ含めるのは、
 * 対応表の行が失われても予約の経過時間が分かるようにするため。ISO8601のZ表記に固定するのは、
 * `+09:00` 形式だとクエリ文字列で `+` が空白へ解釈されて署名が合わなくなるため。
 */
async function creditCallbackUrl(env, reserveKey, issuedAt) {
  const secret = String(env.CREDIT_BASE_CALLBACK_SECRET || "").trim();
  const origin = String(env.PUBLIC_CANONICAL_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!secret || !origin) return null;
  const signature = await creditCallbackSignature(reserveKey, issuedAt, secret);
  const query = new URLSearchParams({ iat: issuedAt, sig: signature });
  return `${origin}/api/internal/credit-jobs/${encodeURIComponent(reserveKey)}?${query}`;
}

async function creditCallbackSignature(reserveKey, issuedAt, secret) {
  return (await hmacSha256Hex(`${reserveKey}\n${issuedAt}`, secret)).slice(0, 32);
}

/**
 * ジョブのポーリングに合わせて予約を精算する。
 *
 * RunPodを呼ぶ前に対応表を見るのが肝。`runpodRequest` は404も5xxもtimeoutも例外にするので
 * （非2xxをhttpErrorへ変える）、RunPodを先に呼ぶと、1回目の精算が落ちた後にRunPodが結果を
 * 捨てた時点で例外が先に出て、精算の再試行へ二度と到達できない。予約は in_flight のまま残る。
 *
 * 戻り値はRunPodの生の応答（呼び出し元がそのまま使う）。
 */
async function settleCreditForPolledJob(env, jobId, fetchRunpodBody) {
  const reservation = await findCreditReservationForJob(env, jobId);
  if (!reservation || reservation.status !== "in_flight") {
    if (reservation) await deleteCreditReserveMarker(env, jobId);
    return fetchRunpodBody();
  }

  const { client } = resolveCreditClient(env);
  if (!client) return fetchRunpodBody();
  const auditBase = { feature: reservation.feature, job_id: jobId };

  // 終了状態を観測済みなら、RunPodを呼ばずに記録値で精算をやり直す
  if (reservation.job_status) {
    await settleFromCreditReservationRecord(env, client, reservation, auditBase);
    return fetchRunpodBody();
  }

  const body = await fetchRunpodBody();
  const status = String(body?.status || "").toUpperCase();
  if (status === "COMPLETED") {
    // 後段のLLM比較が失敗しても精算する。GPUの原価は既に発生している
    await recordCreditReservationOutcome(env, reservation.reserve_key, "succeeded", Number(body?.executionTime));
  } else if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    await recordCreditReservationOutcome(env, reservation.reserve_key, "failed", Number(body?.executionTime));
  } else {
    return body;
  }
  await settleFromCreditReservationRecord(env, client, await findCreditReservationByKey(env, reservation.reserve_key), auditBase);
  return body;
}

/** 対応表に記録した終了状態と実行時間だけを見て精算する。再試行しても額が変わらない */
async function settleFromCreditReservationRecord(env, client, reservation, auditBase) {
  if (!reservation || reservation.status !== "in_flight" || !reservation.job_status) return;
  if (reservation.job_status === "succeeded") {
    await settleCreditReservation(env, {
      client,
      reserveKey: reservation.reserve_key,
      actualAmount: creditCostFromExecutionTime(env, reservation.execution_time_ms, reservation.reserved_amount),
      reservedAmount: reservation.reserved_amount,
      executionTimeMs: reservation.execution_time_ms,
      auditBase,
    });
  } else {
    await releaseCreditReservation(env, { client, reserveKey: reservation.reserve_key, auditBase });
  }
  // 印を消すのは決着したときだけ。精算が落ちた回にも消すと、次のポーリングが
  // 「予約なし」と判断して再試行へ到達できなくなる
  const settled = await findCreditReservationByKey(env, reservation.reserve_key);
  if (settled && settled.status !== "in_flight") {
    await deleteCreditReserveMarker(env, reservation.job_id);
  }
}

/**
 * 予約のあるジョブだけ対応表を引く。
 *
 * 印が無ければ予約も無いので、無料枠の利用者のポーリングにD1読みが増えない。
 * KVが無い環境では印を作れないので対応表を直接引く（印は読みを省くための最適化で、
 * 正しさをここへ預けない）。
 */
async function findCreditReservationForJob(env, jobId) {
  if (!env.MO_SPEECH_DB) return null;
  if (stateKv(env)) {
    const reserveKey = await readCreditReserveMarker(env, jobId);
    if (!reserveKey) return null;
    return findCreditReservationByKey(env, reserveKey);
  }
  return findCreditReservationByJobId(env, jobId);
}

/**
 * GPUの実行時間を消費creditへ換算する。
 *
 * 切り上げて最小1にするのは、credit-base の settle が1以上の整数しか受けず、cronが
 * `cost_credits === 0` を「成功したが原価0」として枠を返してしまうため。切り捨てると
 * 短いジョブが無料になる。上限は設けない。予約額での頭打ちと超過分の記録はcredit-base側が行う。
 */
function creditCostFromExecutionTime(env, executionTimeMs, reservedAmount) {
  const perSecond = creditRunpodRatePerSecond(env);
  // 単価が壊れているときに最小の1creditへ倒すと請求漏れになる。予約額をそのまま実費とする
  if (!(perSecond > 0)) return reservedAmount;
  if (!Number.isFinite(executionTimeMs)) return reservedAmount;
  return Math.max(1, Math.ceil((executionTimeMs / 1000) * perSecond));
}

function creditRunpodRatePerSecond(env) {
  return numberFromEnv(env.CREDIT_RUNPOD_CREDITS_PER_SECOND, CREDIT_RUNPOD_CREDITS_PER_SECOND);
}

/**
 * credit-base のcronが、予約に対応するジョブの終了状態を尋ねてくる先。
 *
 * cronは認証ヘッダを送らないので、URLに載せた署名だけで守る。応答は状態と実費だけで、
 * 主体を特定できる情報を返さない。署名は予約ごとに異なり、他の予約には使えない。
 *
 * 200以外を返すと cron は「保留」にして状態が伝わらないので、署名が通ったら必ず200を返す。
 */
async function handleCreditJobStatusRequest(request, env, url) {
  let reserveKey;
  try {
    reserveKey = decodeURIComponent(url.pathname.slice("/api/internal/credit-jobs/".length));
  } catch (_error) {
    // 壊れたパーセントエンコード。こちらが発行したURLではないので、署名なしと同じ扱いにする
    throw httpError(401, "invalid credit job signature");
  }
  const issuedAt = url.searchParams.get("iat") || "";
  const signature = url.searchParams.get("sig") || "";
  if (!reserveKey || !issuedAt || !signature) {
    throw httpError(401, "invalid credit job signature");
  }
  if (!(await creditCallbackSignatureMatches(env, reserveKey, issuedAt, signature))) {
    throw httpError(401, "invalid credit job signature");
  }
  return jsonResponse(await creditJobStatusPayload(env, reserveKey, issuedAt));
}

/**
 * 現行の鍵と、回転中の旧鍵の両方を受ける。
 * 鍵を差し替えた瞬間に発行済みのURLが401になると、cronが保留し続けて予約が永久に残る。
 */
async function creditCallbackSignatureMatches(env, reserveKey, issuedAt, presented) {
  for (const key of [env.CREDIT_BASE_CALLBACK_SECRET, env.CREDIT_BASE_CALLBACK_SECRET_PREVIOUS]) {
    const secret = String(key || "").trim();
    if (!secret) continue;
    if (constantTimeEqual(presented, await creditCallbackSignature(reserveKey, issuedAt, secret))) return true;
  }
  return false;
}

async function creditJobStatusPayload(env, reserveKey, issuedAt) {
  const reservation = env.MO_SPEECH_DB ? await findCreditReservationByKey(env, reserveKey) : null;

  if (reservation?.status === "settled") {
    return { status: "succeeded", cost_credits: Number(reservation.settled_amount || 0) };
  }
  // 別の経路が先に精算した予約。credit-base 側は already_settled で止まるので、どちらを返しても
  // 台帳は変わらない。実装で迷わないよう1つに固定する
  if (reservation && reservation.status !== "in_flight") {
    return { status: "failed", cost_credits: 0 };
  }
  if (reservation?.job_status === "succeeded") {
    return {
      status: "succeeded",
      cost_credits: reservation.kind === "sync"
        ? Number(reservation.reserved_amount || 0)
        : creditCostFromExecutionTime(env, reservation.execution_time_ms, reservation.reserved_amount),
    };
  }
  if (reservation?.job_status === "failed") {
    return { status: "failed", cost_credits: 0 };
  }

  // ここから先は終了状態を誰も観測していない。同期経路と、ジョブIDを記録できなかった予約は
  // RunPodへ尋ねる手立てがないので、予約のTTLを過ぎたら失敗として枠を返す
  if (reservation && (reservation.kind === "sync" || !reservation.job_id)) {
    const ttl = reservation.kind === "sync" ? creditSyncReserveTtl(env) : creditJobReserveTtl(env);
    return creditElapsedSeconds(issuedAt) > ttl
      ? { status: "failed", cost_credits: 0 }
      : { status: "running", cost_credits: 0 };
  }

  if (reservation?.job_id) {
    let body;
    try {
      body = await runpodRequest(env, `/status/${encodeURIComponent(reservation.job_id)}`, { method: "GET" });
    } catch (error) {
      // 404は「もう結果が無い」という確定した答えで、通信の失敗ではない。
      // timeout・5xx・ネットワーク例外は running を返して credit-base 側の保留に載せる
      if (Number(error?.status) !== 404) return { status: "running", cost_credits: 0 };
      return creditUnknownJobPayload(issuedAt);
    }
    const status = String(body?.status || "").toUpperCase();
    if (status === "COMPLETED") {
      // 照会側で終了を観測したときも記録しておく。次のポーリングがRunPodへ問い直さずに済む
      await recordCreditReservationOutcome(env, reserveKey, "succeeded", Number(body?.executionTime));
      return {
        status: "succeeded",
        cost_credits: creditCostFromExecutionTime(env, Number(body?.executionTime), reservation.reserved_amount),
      };
    }
    if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
      await recordCreditReservationOutcome(env, reserveKey, "failed", Number(body?.executionTime));
      return { status: "failed", cost_credits: 0 };
    }
    return { status: "running", cost_credits: 0 };
  }

  // 対応表に行が無い。予約は通ったが行を書けなかったか、行が消えている
  return creditUnknownJobPayload(issuedAt);
}

/**
 * 状態を取り戻す手立てが無くなった予約の扱い。
 *
 * その日のうちに運用が気づける長さだけ running で保留し、過ぎたら失敗として枠を返す。
 * 取りはぐれる原価は予約額に有界なので、永久に保留して利用者の枠を塞ぐより返すほうがよい。
 */
function creditUnknownJobPayload(issuedAt) {
  return creditElapsedSeconds(issuedAt) > CREDIT_UNKNOWN_JOB_GRACE_SECONDS
    ? { status: "failed", cost_credits: 0 }
    : { status: "running", cost_credits: 0 };
}

function creditElapsedSeconds(issuedAt) {
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) return Number.POSITIVE_INFINITY;
  return (Date.now() - issued) / 1000;
}

async function readPublicUsers(env, url = null) {
  // limit未指定を0として渡すとclampIntが下限1へ丸めるため、未指定はnullのままfallbackさせる。
  const requestedLimit = url ? new URL(url).searchParams.get("limit") : null;
  const limit = clampInt(requestedLimit, 1, PUBLIC_USERS_MAX_LIMIT, PUBLIC_USERS_DEFAULT_LIMIT);
  if (!env.MO_SPEECH_DB) {
    return { users: [], limit, stored: 0 };
  }
  const settings = await readPublicAccessSettings(env);
  const rows = await env.MO_SPEECH_DB.prepare(`
    WITH selected_users AS (
      SELECT email_hash, email, created_at, last_seen_at, last_login_at
      FROM public_users
      ORDER BY last_login_at IS NULL, last_login_at DESC
      LIMIT ?
    )
    SELECT
      selected_users.email_hash,
      selected_users.email,
      selected_users.created_at,
      selected_users.last_seen_at,
      selected_users.last_login_at,
      quota_usage_total.feature,
      quota_usage_total.usage_count
    FROM selected_users
    LEFT JOIN quota_usage_total
      ON quota_usage_total.email_hash = selected_users.email_hash
    ORDER BY selected_users.last_login_at IS NULL, selected_users.last_login_at DESC, quota_usage_total.feature
  `).bind(limit).all();
  const stored = await env.MO_SPEECH_DB.prepare("SELECT COUNT(*) AS count FROM public_users").first();
  const usersByHash = new Map();
  for (const row of rows.results || []) {
    let user = usersByHash.get(row.email_hash);
    if (!user) {
      user = { ...row, usage: {} };
      usersByHash.set(row.email_hash, user);
    }
    if (row.feature !== null && row.feature !== undefined) {
      user.usage[String(row.feature)] = Number(row.usage_count || 0);
    }
  }
  const users = [...usersByHash.values()].map((row) => {
    const usage = row.usage;
    const usedTotal = Object.values(usage).reduce((sum, value) => sum + value, 0);
    const email = normalizeEmail(row.email);
    return {
      email,
      email_hash: String(row.email_hash || ""),
      created_at: String(row.created_at || ""),
      last_login_at: String(row.last_login_at || ""),
      // ログインだけの利用者はlast_seen_atが初回記録時刻と同じになる。実利用がない時刻を最終利用として見せない。
      last_seen_at: usedTotal > 0 ? String(row.last_seen_at || "") : "",
      is_admin: Boolean(email) && isPublicAdminEmail(email, settings),
      usage,
    };
  });
  return { users, limit, stored: Number(stored?.count || 0) };
}

async function readPublicAuditLog(env, url = null) {
  // limit未指定を0として渡すとclampIntが下限1へ丸めるため、未指定はnullのままfallbackさせる。
  const requestedLimit = url ? new URL(url).searchParams.get("limit") : null;
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
      // 決着した予約だけを消す。in_flight の行は resolved_at がNULLで比較が偽になるため残る
      env.MO_SPEECH_DB.prepare(CREDIT_RESERVATION_SQL.deleteResolved).bind(auditCutoff),
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

async function createVoiceConversionJob(request, env) {
  const form = await request.formData();
  const sourceAudio = requiredBlob(form, "source_audio");
  const referenceAudio = requiredBlob(form, "reference_audio");
  const { consumption } = await enforcePublicFeatureAccess(
    request,
    env,
    "voice_conversion",
    { audioBytes: Math.max(Number(sourceAudio.size || 0), Number(referenceAudio.size || 0)) },
    { feature: "voice-conversion-jobs", kind: "job" },
  );
  const sourceAudioBase64 = await blobToBase64(sourceAudio);
  const sourceAudioMimeType = normalizeMimeType(sourceAudio.type || guessAudioMimeType(sourceAudio.name));
  const referenceAudioBase64 = await blobToBase64(referenceAudio);
  const referenceAudioMimeType = normalizeMimeType(referenceAudio.type || guessAudioMimeType(referenceAudio.name));
  const voiceBackend = stringFormValue(form, "voice_backend", "seed-vc");
  const payload = {
    operation_mode: "voice_conversion",
    source_audio_base64: sourceAudioBase64,
    source_audio_mime_type: sourceAudioMimeType,
    reference_audio_base64: referenceAudioBase64,
    reference_audio_mime_type: referenceAudioMimeType,
    voice_backend: voiceBackend,
    ...seedVcPayloadFromForm(form),
  };
  const body = await submitRunpodJob(env, payload);
  const snapshot = jobSnapshotFromRunpod(body, "voice_conversion");
  await consumption.attachJob(snapshot.job_id);
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, "voice_conversion")) {
    await saveRunpodVcReadyState(env, snapshot, "voice_conversion");
  }
  return snapshot;
}

async function createWarmupJob(env) {
  const payload = {
    operation_mode: "warmup",
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
  const body = await settleCreditForPolledJob(env, jobId, () =>
    runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" }));
  const health = null;
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
  const currentStage = kind === "voice_conversion"
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
  if (kind === "warmup") {
    return [{ stage: "warmup", label: "準備", provider: "RunPod Serverless" }];
  }
  throw new Error(`unsupported RunPod job kind: ${kind}`);
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
  throw new Error(`unsupported RunPod job kind: ${kind}`);
}

async function createLearnerDisplayText(payload, env) {
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
    model: env.OPENAI_TEXT_DISPLAY_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.6-terra",
    instructions:
      "Convert the Japanese sentence to hiragana only for display to language learners. Return only the hiragana text, with no notes. Keep punctuation and Arabic numerals readable.",
    input: text,
  });
  return { kanji_text: text, hiragana_text: hiragana || text, indonesian_text: "" };
}

async function createPracticePrompt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  const { consumption } = await enforcePublicFeatureAccess(
    request,
    env,
    "speakloop",
    { audioBytes: Number(audio.size || 0) },
    { feature: "practice-prompts", kind: "sync" },
  );
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
  await consumption.settle(consumption.amount);
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
  const { consumption } = await enforcePublicFeatureAccess(
    request,
    env,
    "speakloop",
    { audioBytes: Number(audio.size || 0), textChars: currentTargetText.trim().length },
    { feature: "practice-recordings", kind: "sync" },
  );
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
  // 声質変換の付随ジョブは practice-recordings の固定額に含める（別に予約を取らない）
  await consumption.settle(consumption.amount);
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
  const { consumption } = await enforcePublicFeatureAccess(
    request,
    env,
    "speakloop",
    { audioBytes: Number(audio.size || 0) + Number(modelAudio.size || 0), textChars: targetText.length },
    // zh-CNはRunPodへ非同期投入するのでポーリング側で精算する。それ以外は同じリクエスト内で完結する
    { feature: "practice-attempt-jobs", kind: targetLanguage === "zh-CN" ? "job" : "sync" },
  );
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
      align_timestamps: true,
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
    // 投入後の後片付けより先に予約を結び付ける。ここより後で落ちると、GPUジョブが走っているのに
    // リクエストの出口が枠を返してしまい、請求できない実行になる
    await consumption.attachJob(jobId);
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
  await consumption.settle(consumption.amount);
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
  const body = await settleCreditForPolledJob(env, jobId, () =>
    runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" }));
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
    if (!Number.isFinite(contractVersion) || contractVersion < 3) {
      return failedPracticeAttemptJob(
        jobId,
        stages,
        metrics,
        "RunPod imageがpractice ASR contract v3に対応していません。現在のRunPod imageを再デプロイしてください。",
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
  console.error("practice attempt job failed", JSON.stringify({
    job_id: jobId,
    label,
    detail: detail.slice(0, 300),
  }));
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
  const display = await createLearnerDisplayText({ text, target_language: targetLanguage }, env);
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

const OPENAI_QUOTA_PUBLIC_MESSAGE = "現在サーバー側のAI利用枠を超えているため処理できません。時間をおいてもう一度お試しください。";

// クレジット枯渇だけ利用者向けカテゴリ文言へ変換し、他の失敗は呼び出し元の従来メッセージに任せる。
// provider名を含む従来メッセージはフロント側のマスク(SPEC.mdのエラー文言方針)で汎用文言になる。
function throwIfOpenAiQuotaError(operation, status, errorBody) {
  const upstream = errorBody && typeof errorBody === "object" ? errorBody.error : null;
  const code = upstream && typeof upstream === "object" ? String(upstream.code || upstream.type || "") : "";
  const upstreamMessage = upstream && typeof upstream === "object"
    ? String(upstream.message || "")
    : String(upstream || "");
  console.error(`openai ${operation} failed`, JSON.stringify({
    status,
    code,
    message: upstreamMessage.slice(0, 300),
  }));
  if (status === 402 || code === "insufficient_quota") {
    throw httpError(503, OPENAI_QUOTA_PUBLIC_MESSAGE);
  }
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
    let errorBody = null;
    try {
      errorBody = JSON.parse(text);
    } catch (_error) {
      errorBody = null;
    }
    throwIfOpenAiQuotaError("asr", response.status, errorBody);
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

async function translateTranscript(env, { transcript, sourceLanguage, targetLanguage }) {
  if (!transcript.trim()) {
    return {
      source_language: sourceLanguage === "auto" ? "" : sourceLanguage,
      target_language: targetLanguage,
      translated_text: "",
    };
  }
  const requestedTarget = supportedValue(targetLanguage, Object.keys(OPENAI_LANGUAGE_NAMES), "ja-JP");
  const instructions = [
    "You translate a short speech transcript into model text for pronunciation practice.",
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
    const targetLanguage = supportedValue(
      payload.target_language,
      Object.keys(OPENAI_LANGUAGE_NAMES),
      requestedTarget,
    );
    return {
      source_language: supportedValue(payload.source_language, ["auto", ...Object.keys(OPENAI_LANGUAGE_NAMES)], sourceLanguage),
      target_language: targetLanguage || "ja-JP",
      translated_text: String(payload.translated_text || "").trim(),
    };
  } catch (_error) {
    return {
      source_language: sourceLanguage,
      target_language: requestedTarget,
      translated_text: text,
    };
  }
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
    throwIfOpenAiQuotaError("text", response.status, body);
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
    throwIfOpenAiQuotaError("tts", response.status, body);
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
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(init.status === 204 ? null : JSON.stringify(payload), { ...init, headers });
}

function httpError(status, message, extra = null) {
  const error = new Error(String(message));
  error.status = status;
  // extra は内部の目印。応答本文へ出すのは `code` だけで、他は外へ漏らさない
  if (extra) Object.assign(error, extra);
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
