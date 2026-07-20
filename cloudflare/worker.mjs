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
const PRACTICE_GRADE_LABELS = {
  perfect: "できました",
  ok: "いいかんじ",
  almost: "まあまあ",
  retry: "もう一回",
};
const PRACTICE_EDGE_FILLERS = {
  "en-US": new Set(["ah", "er", "erm", "hmm", "mm", "uh", "um", "well"]),
  "ja-JP": new Set(["あの", "ええと", "えっと", "えー", "うーん"]),
  "zh-CN": new Set(["啊", "呃", "额", "嗯", "唔"]),
};
const PRACTICE_BOUNDARY_FILLER_SEQUENCES = {
  "en-US": new Set(["youknow", "letmethink", "youknowletmethink"]),
  "ja-JP": new Set(["あの", "ええと", "えっと", "ちょっとまって"]),
  "zh-CN": new Set(["那个", "我想一下", "那个我想一下"]),
};
const PRACTICE_NON_SPECIFIC_ALIGNMENT_PIECES = {
  "en-US": new Set(["a", "an", "finally", "next", "please", "the", "then"]),
  "ja-JP": new Set(["そして", "それから", "つぎ", "次", "最後"]),
  "zh-CN": new Set(["然后", "最后", "接着", "再", "先", "请", "把"]),
};
const PRACTICE_DIAGNOSTIC_STOP_PIECES = {
  "en-US": new Set([
    "a", "an", "and", "are", "at", "finally", "for", "from", "i", "in", "is", "it", "my",
    "next", "of", "on", "or", "please", "the", "then", "to", "was", "were", "with", "your",
  ]),
  "ja-JP": new Set(["そして", "それから", "つぎ", "次", "最後", "私", "を", "が", "に", "で", "は"]),
  "zh-CN": new Set([
    "然后", "最后", "接着", "再", "先", "请", "把", "我", "你", "的", "到", "在", "上", "下", "要", "还要",
  ]),
};
const PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD = 0.75;
const PRACTICE_PAUSE_PARTITION_GAP_SECONDS = 0.18;
const PRACTICE_DETACHED_SPEECH_GAP_SECONDS = 0.65;
const MAX_ALIGNMENT_CANDIDATES_PER_PHRASE = 4096;
const MAX_CANONICAL_TARGET_PHRASES = 16;
const MAX_CANONICAL_TIMESTAMP_UNITS = 256;
const MAX_CANONICAL_ALIGNMENT_COMPLEXITY = 1024;
const PRACTICE_HARD_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const PRACTICE_CLOSING_PUNCTUATION = new Set([..."\"'”’」』】）》）)]}"]);
const PRACTICE_PROTECTED_ABBREVIATIONS = new Set(["dr", "jr", "mr", "mrs", "ms", "prof", "sr", "st"]);
const ENGLISH_SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const ENGLISH_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const CHINESE_SMALL_NUMBER_UNITS = ["", "十", "百", "千"];
const CHINESE_LARGE_NUMBER_UNITS = ["", "万", "亿", "兆", "京", "垓", "秭", "穰", "沟", "涧", "正", "载"];
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

export const PRACTICE_LLM_COMPARISON_MODELS = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano"];
const DEFAULT_PRACTICE_COMPARISON_MODEL = PRACTICE_LLM_COMPARISON_MODELS[0];
const DEFAULT_PLAYBACK_PADDING_SECONDS = 0.1;
const PRACTICE_COMPARISON_ERROR_MESSAGE = "比較結果を作成できませんでした。もう一度お試しください。";

// この文言はローカルFastAPI版(src/mo_speech/practice_llm.py)と同一に保つ。
export const PRACTICE_LLM_PROMPT = `あなたは発音練習アプリの比較・採点処理です。入力された目標文、お手本ASR、復唱ASRだけを根拠に、UI表示とフレーズ比較再生にそのまま使える完成JSONを返してください。

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
  const reconstructed = phrases.map((phrase) => String(phrase?.target_text || "")).join("");
  if (reconstructed !== String(inputPayload?.target_text || "")) {
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
    if (request.method === "POST" && url.pathname === "/api/practice/attempts") {
      return jsonResponse(await createPracticeAttempt(request, env));
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
  if (recordingIntent !== "prompt" && recordingIntent !== "attempt") {
    throw httpError(400, "recording_intent must be prompt or attempt");
  }
  const attemptTargetText = recordingIntent === "attempt"
    ? canonicalPracticeText(currentTargetText, targetLanguage)
    : "";
  if (recordingIntent === "attempt") {
    validatePracticeTargetForAlignment(attemptTargetText);
  }
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  const useOwnVoice = recordingIntent === "prompt" && optionEnabled(stringFormValue(form, "use_own_voice", "false"));
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

  if (recordingIntent === "attempt") {
    const targetText = attemptTargetText;
    const targetStarted = Date.now();
    const targetTranscription = await practiceAttemptTranscription(env, {
      audioBytes,
      audioMimeType,
      targetLanguage,
      filename: audio.name || `practice.${extensionForMimeType(audioMimeType)}`,
      model: asrModel,
    });
    const targetAsrMs = Date.now() - targetStarted;
    const recognizedText = canonicalPracticeText(targetTranscription.text, targetLanguage);
    const asrTimestamps = serializeAsrTimestamps(targetTranscription);
    const evaluation = practiceEvaluationWithOutcome(targetText, recognizedText, targetLanguage, asrTimestamps);
    const result = {
      recording_kind: "attempt",
      target_language: targetLanguage,
      target_text: targetText,
      recognized_text: recognizedText,
      asr_model: targetTranscription.model,
      asr_timestamps: asrTimestamps,
      ...evaluation,
      comparison_alignment: practiceComparisonAlignmentCanonical({
        targetText,
        recognizedText,
        targetLanguage,
        asrTimestamps,
      }),
      timings_ms: {
        asr: targetAsrMs,
        compare: 0,
        total: targetAsrMs,
      },
      providers: {
        asr: targetTranscription.provider,
      },
    };
    return result;
  }

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

async function createPracticeAttempt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const targetText = canonicalPracticeText(stringFormValue(form, "target_text", "").trim(), targetLanguage);
  validatePracticeTargetForAlignment(targetText);
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0),
    textChars: targetText.length,
  });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const transcription = await practiceAttemptTranscription(env, {
    audioBytes,
    audioMimeType,
    targetLanguage,
    filename: audio.name || `repeat.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
  });
  const recognizedText = canonicalPracticeText(transcription.text, targetLanguage);
  const asrMs = Date.now() - asrStarted;
  const asrTimestamps = serializeAsrTimestamps(transcription);
  const evaluation = practiceEvaluationWithOutcome(targetText, recognizedText, targetLanguage, asrTimestamps);
  const result = {
    target_language: targetLanguage,
    target_text: targetText,
    recognized_text: recognizedText,
    asr_model: transcription.model,
    asr_timestamps: asrTimestamps,
    ...evaluation,
    comparison_alignment: practiceComparisonAlignmentCanonical({
      targetText,
      recognizedText,
      targetLanguage,
      asrTimestamps,
    }),
    timings_ms: {
      asr: asrMs,
      compare: Math.max(0, Date.now() - totalStarted - asrMs),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: transcription.provider,
    },
  };
  return result;
}

async function createPracticeAttemptJob(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const modelAudio = requiredBlob(form, "model_audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "en-US"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const targetText = canonicalPracticeText(stringFormValue(form, "target_text", "").trim(), targetLanguage);
  validatePracticeTargetForAlignment(targetText);
  const comparisonModelRaw = stringFormValue(form, "comparison_model", "");
  const playbackPaddingRaw = stringFormValue(form, "playback_padding_seconds", "");
  const useLlm = Boolean(comparisonModelRaw.trim() || playbackPaddingRaw.trim());
  const comparisonModel = useLlm ? supportedPracticeComparisonModel(comparisonModelRaw) : "";
  const playbackPaddingSeconds = useLlm
    ? validatePlaybackPaddingSeconds(playbackPaddingRaw)
    : DEFAULT_PLAYBACK_PADDING_SECONDS;
  if (useLlm && targetLanguage !== "zh-CN" && !OPENAI_TIMESTAMP_ASR_MODELS.has(asrModel)) {
    throw httpError(
      400,
      `asr_model '${asrModel}' does not return word timestamps, which the LLM comparison requires; use whisper-1 for comparison_model requests`,
    );
  }
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0) + Number(modelAudio.size || 0),
    textChars: targetText.length,
  });
  const [audioBytes, modelAudioBytes] = await Promise.all([audio.arrayBuffer(), modelAudio.arrayBuffer()]);
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const modelAudioMimeType = normalizeMimeType(modelAudio.type || guessAudioMimeType(modelAudio.name));

  if (targetLanguage === "zh-CN") {
    const body = await submitRunpodJob(env, {
      operation_mode: "practice_asr",
      source_language: targetLanguage,
      target_text: targetText,
      audio_mime_type: audioMimeType || "audio/wav",
      audio_base64: arrayBufferToBase64(audioBytes),
      model_audio_mime_type: modelAudioMimeType || "audio/wav",
      model_audio_base64: arrayBufferToBase64(modelAudioBytes),
    });
    const jobId = String(body?.id || body?.job_id || "");
    if (useLlm) {
      await savePracticeAttemptLlmOptions(env, jobId, {
        comparison_model: comparisonModel,
        playback_padding_seconds: playbackPaddingSeconds,
      });
    }
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
    transcribeWithTiming({
      audioBytes: modelAudioBytes,
      audioMimeType: modelAudioMimeType,
      sourceLanguage: targetLanguage,
      filename: modelAudio.name || `model.${extensionForMimeType(modelAudioMimeType)}`,
      model: asrModel,
      includeTimestamps: true,
    }),
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
    if (!output.model_transcription || typeof output.model_transcription !== "object") {
      return failedPracticeAttemptJob(jobId, stages, metrics, "RunPod practice job did not return model_transcription");
    }
    const attemptTranscription = runpodPracticeTranscription(output);
    const modelTranscription = runpodPracticeTranscription(output.model_transcription);
    const llmOptions = await readPracticeAttemptLlmOptions(env, jobId);
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

  if (comparisonModel) {
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

  const evaluation = practiceEvaluationWithOutcome(targetText, recognizedText, targetLanguage, asrTimestamps);
  let modelComparisonAlignment;
  try {
    modelComparisonAlignment = practiceComparisonAlignmentCanonical({
      targetText,
      recognizedText: modelRecognizedText,
      targetLanguage,
      asrTimestamps: modelAsrTimestamps,
    });
  } catch (error) {
    if (!(error instanceof PracticeAlignmentError)) throw error;
    throw new PracticeAlignmentError(error.reason, {
      stage: "reference_asr",
      retryable: error.retryable,
    });
  }
  if (modelComparisonAlignment.outcome === "no_speech") {
    throw new PracticeAlignmentError("empty_reference_asr", { stage: "reference_asr" });
  }
  return {
    recording_kind: "attempt",
    target_language: targetLanguage,
    target_text: targetText,
    recognized_text: recognizedText,
    model_recognized_text: modelRecognizedText,
    asr_model: attemptTranscription.model,
    asr_timestamps: asrTimestamps,
    model_asr_timestamps: modelAsrTimestamps,
    ...evaluation,
    comparison_alignment: practiceComparisonAlignmentCanonical({
      targetText,
      recognizedText,
      targetLanguage,
      asrTimestamps,
    }),
    model_comparison_alignment: modelComparisonAlignment,
    timings_ms: {
      asr: Number(timings.asr || 0),
      model_asr: Number(timings.model_asr || 0),
      compare: Number(timings.compare || 0),
      total: Number(timings.total || 0),
    },
    providers: {
      asr: attemptTranscription.provider,
      model_asr: modelTranscription.provider,
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

async function practiceAttemptTranscription(env, {
  audioBytes,
  audioMimeType,
  targetLanguage,
  filename,
  model,
}) {
  if (targetLanguage === "zh-CN") {
    return runpodPracticeAsr(env, {
      audioBytes,
      audioMimeType,
      sourceLanguage: targetLanguage,
    });
  }
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: targetLanguage,
    filename,
    model,
    includeTimestamps: true,
  });
  return {
    ...transcription,
    provider: `openai-asr-${transcription.model}`,
  };
}

async function runpodPracticeAsr(env, { audioBytes, audioMimeType, sourceLanguage }) {
  const body = await submitRunpodSyncJob(env, {
    operation_mode: "practice_asr",
    source_language: sourceLanguage,
    audio_mime_type: normalizeMimeType(audioMimeType) || "audio/wav",
    audio_base64: arrayBufferToBase64(audioBytes),
  });
  const output = runpodSyncOutput(body, "RunPod practice ASR");
  const model = String(output.model || FUNASR_DEFAULT_PRACTICE_ASR_MODEL);
  const providers = output.providers && typeof output.providers === "object" ? output.providers : {};
  return {
    text: String(output.text || "").trim(),
    model,
    timestamp_granularities: Array.isArray(output.timestamp_granularities)
      ? output.timestamp_granularities.map(String)
      : [],
    words: normalizedAsrTimingRows(output.words, "text"),
    segments: normalizedAsrTimingRows(output.segments, "text"),
    raw_timestamp_word_count: Array.isArray(output.words) ? output.words.length : 0,
    raw_timestamp_segment_count: Array.isArray(output.segments) ? output.segments.length : 0,
    provider: String(providers.asr || "funasr-paraformer-zh"),
  };
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

async function submitRunpodSyncJob(env, inputPayload) {
  return runpodRequest(env, "/runsync", {
    method: "POST",
    payload: runpodRequestPayload(inputPayload),
  });
}

function runpodRequestPayload(inputPayload) {
  return { input: inputPayload };
}

function runpodSyncOutput(body, label) {
  if (body && typeof body.output === "object" && body.output !== null) {
    return body.output;
  }
  if (body && typeof body === "object" && body.audio_base64) {
    return body;
  }
  const status = String(body?.status || "").toUpperCase();
  if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    throw httpError(502, runpodErrorMessage(body));
  }
  throw httpError(502, `${label} did not return output`);
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

export function evaluatePracticeAttempt(targetText, recognizedText, targetLanguage) {
  const normalizedTarget = normalizePracticeText(targetText, targetLanguage);
  const normalizedRecognized = normalizePracticeText(recognizedText, targetLanguage);
  const globalSimilarity = practiceSimilarity(normalizedTarget, normalizedRecognized);
  const phraseMatches = practicePhraseMatches(targetText, recognizedText, targetLanguage);
  const phraseSimilarity = practicePhraseSimilarity(phraseMatches);
  const phraseMacroSimilarity = practicePhraseMacroSimilarity(phraseMatches);
  const lowestPhraseSimilarity = phraseMatches.length
    ? Math.min(...phraseMatches.map((match) => Number(match.similarity) || 0))
    : globalSimilarity;
  const similarity = Math.min(globalSimilarity, phraseMacroSimilarity);
  const grade = practiceGrade(similarity);
  return {
    normalized_target: normalizedTarget,
    normalized_recognized: normalizedRecognized,
    global_similarity: Math.round(globalSimilarity * 1000) / 1000,
    phrase_similarity: Math.round(phraseSimilarity * 1000) / 1000,
    phrase_macro_similarity: Math.round(phraseMacroSimilarity * 1000) / 1000,
    lowest_phrase_similarity: Math.round(lowestPhraseSimilarity * 1000) / 1000,
    similarity: Math.round(similarity * 1000) / 1000,
    grade,
    grade_label: PRACTICE_GRADE_LABELS[grade],
    diff: practiceDiff(normalizedTarget, normalizedRecognized),
    phrase_matches: phraseMatches,
    unconsumed_recognized: practiceUnconsumedRecognized(
      normalizedRecognized,
      phraseMatches,
      targetLanguage,
      recognizedText,
    ),
  };
}

function practiceEvaluationWithOutcome(targetText, recognizedText, targetLanguage, asrTimestamps) {
  const noSpeech =
    !String(recognizedText || "").trim() &&
    !(asrTimestamps?.words || []).length &&
    !(asrTimestamps?.segments || []).length;
  if (noSpeech) {
    return {
      outcome: "no_speech",
      message: "音声を検出できませんでした。もう一度録音してください。",
      normalized_target: normalizePracticeText(targetText, targetLanguage),
      normalized_recognized: "",
      global_similarity: null,
      phrase_similarity: null,
      phrase_macro_similarity: null,
      lowest_phrase_similarity: null,
      similarity: null,
      grade: null,
      grade_label: "",
      diff: [],
      phrase_matches: [],
      unconsumed_recognized: [],
    };
  }
  return {
    outcome: "evaluated",
    message: "",
    ...evaluatePracticeAttempt(targetText, recognizedText, targetLanguage),
  };
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

export function practiceContentMatches(targetText, matchedText, targetLanguage) {
  const language = supportedPracticeTargetLanguage(targetLanguage);
  let targetForComparison = String(targetText || "");
  let matchedForComparison = String(matchedText || "");
  if (language === "en-US") {
    targetForComparison = replaceStandaloneEnglishNumbers(targetForComparison);
    matchedForComparison = replaceStandaloneEnglishNumbers(matchedForComparison);
  }
  const matchedNormalized = normalizePracticeContentText(matchedForComparison, language);
  if (normalizePracticeContentText(targetForComparison, language) === matchedNormalized) {
    return true;
  }
  if (language !== "en-US") return false;
  return compactIdentifierVariants(targetForComparison)
    .some((candidate) => normalizePracticeContentText(candidate, language) === matchedNormalized);
}

function rawTimestampCount(value, rows) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : (Array.isArray(rows) ? rows.length : 0);
}

function normalizePracticeContentText(text, targetLanguage) {
  let normalized = String(text || "").normalize("NFKC").trim().toLowerCase();
  if (targetLanguage === "zh-CN") {
    normalized = normalizeChineseSpokenForms(normalized);
    normalized = traditionalChineseToSimplified(normalized);
  }
  return [...normalized]
    .filter((character) => !/^[\p{P}\p{Z}\p{S}]$/u.test(character))
    .join("");
}

function replaceStandaloneEnglishNumbers(text) {
  return String(text || "").normalize("NFKC").replace(
    /(?<![\w./:+-])\d{1,6}(?![\w./:+-])/gu,
    (value) => englishIntegerWords(Number(value)) ?? value,
  );
}

function compactIdentifierVariants(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(/\b([a-z]+)(\d{1,6})\b/giu)];
  if (!matches.length) return [source];
  let variants = [""];
  let cursor = 0;
  for (const match of matches) {
    const prefix = source.slice(cursor, match.index);
    const cardinal = englishIntegerWords(Number(match[2]));
    const digitWords = [...match[2]].map((digit) => ENGLISH_SMALL_NUMBERS[Number(digit)]).join(" ");
    const replacements = [`${match[1]} ${digitWords}`];
    if (cardinal !== null) replacements.push(`${match[1]} ${cardinal}`);
    variants = variants.flatMap((variant) => replacements.map((replacement) => variant + prefix + replacement));
    cursor = match.index + match[0].length;
  }
  return [source, ...variants.map((variant) => variant + source.slice(cursor))];
}

function englishIntegerWords(value) {
  if (!Number.isInteger(value) || value < 0 || value > 999999) return null;
  if (value < 20) return ENGLISH_SMALL_NUMBERS[value];
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const remainder = value % 10;
    return ENGLISH_TENS[tens] + (remainder ? ` ${ENGLISH_SMALL_NUMBERS[remainder]}` : "");
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const remainder = value % 100;
    return `${ENGLISH_SMALL_NUMBERS[hundreds]} hundred` + (remainder ? ` ${englishIntegerWords(remainder)}` : "");
  }
  const thousands = Math.floor(value / 1000);
  const remainder = value % 1000;
  return `${englishIntegerWords(thousands)} thousand` + (remainder ? ` ${englishIntegerWords(remainder)}` : "");
}

function normalizeChineseSpokenForms(text) {
  let source = String(text || "");
  source = source.replace(/(?<![a-z0-9.])[-−](?=\d)/gu, "负");
  const protectedValues = [];
  const protect = (pattern, replacement) => {
    source = source.replace(pattern, (...args) => {
      protectedValues.push(String(replacement(...args)));
      return String.fromCodePoint(0xE000 + protectedValues.length - 1);
    });
  };

  protect(
    /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(?:°\s*c|℃)/giu,
    (_match, value) => `${chineseDecimalWords(value)}度`,
  );
  protect(
    /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*%/gu,
    (_match, value) => `百分之${chineseDecimalWords(value)}`,
  );
  protect(
    /(?<![a-z0-9])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu,
    (_match, hour, minute) => `${chineseIntegerWords(String(Number(hour)))}点${Number(minute) === 0 ? "" : chineseIntegerWords(minute)}`,
  );
  protect(
    /(?<![a-z0-9])(\d{4})(?=年)/gu,
    (_match, value) => chineseDigitWords(value),
  );
  protect(
    /(?<![a-z0-9])(v)(\d+(?:\.\d+)+)(?![a-z0-9])/giu,
    (_match, prefix, value) => `${prefix.toLowerCase()}${chineseVersionWords(value)}`,
  );
  protect(
    /(?<![a-z0-9])([a-z]+)(\d+)(?![a-z0-9])/giu,
    (_match, prefix, value) => `${prefix.toLowerCase()}${chineseDigitWords(value)}`,
  );
  source = source.replace(
    /(?<![a-z0-9.])(\d+)\.(\d+)(?![a-z0-9.])/gu,
    (_match, integer, fraction) => `${chineseIntegerWords(integer)}点${chineseDigitWords(fraction)}`,
  );
  source = source.replace(
    /(?<![a-z0-9])(\d+)(?![a-z0-9])/gu,
    (_match, value) => chineseIntegerWords(value),
  );
  protectedValues.forEach((value, index) => {
    source = source.replace(String.fromCodePoint(0xE000 + index), value);
  });
  return source;
}

function chineseDecimalWords(value) {
  const [integer, fraction] = String(value).split(".", 2);
  return chineseIntegerWords(integer) + (fraction === undefined ? "" : `点${chineseDigitWords(fraction)}`);
}

function chineseVersionWords(value) {
  const [first, ...remaining] = String(value).split(".");
  return [
    chineseIntegerWords(first),
    ...remaining.map((component) => chineseDigitWords(component)),
  ].join("点");
}

function chineseDigitWords(value) {
  return [...String(value)].map((digit) => CHINESE_DIGITS[Number(digit)]).join("");
}

function chineseIntegerWords(value) {
  const digits = String(value);
  if (!digits) return "";
  if (digits.length > 1 && digits.startsWith("0")) return chineseDigitWords(digits);
  let number = BigInt(digits);
  if (number === 0n) return CHINESE_DIGITS[0];
  const groups = [];
  while (number) {
    groups.push(Number(number % 10000n));
    number /= 10000n;
  }
  if (groups.length > CHINESE_LARGE_NUMBER_UNITS.length) return chineseDigitWords(digits);

  const output = [];
  let zeroPending = false;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex];
    if (group === 0) {
      if (output.length && groups.slice(0, groupIndex).some(Boolean)) zeroPending = true;
      continue;
    }
    if (output.length && (zeroPending || group < 1000)) output.push(CHINESE_DIGITS[0]);
    output.push(`${chineseSmallIntegerWords(group)}${CHINESE_LARGE_NUMBER_UNITS[groupIndex]}`);
    zeroPending = false;
  }
  const result = output.join("");
  return result.startsWith("一十") ? result.slice(1) : result;
}

function chineseSmallIntegerWords(number) {
  const digits = String(number);
  const output = [];
  let zeroPending = false;
  for (const [position, digitText] of [...digits].entries()) {
    const digit = Number(digitText);
    const unitIndex = digits.length - position - 1;
    if (digit === 0) {
      if (output.length && [...digits.slice(position + 1)].some((item) => Number(item))) {
        zeroPending = true;
      }
      continue;
    }
    if (zeroPending) {
      output.push(CHINESE_DIGITS[0]);
      zeroPending = false;
    }
    output.push(`${CHINESE_DIGITS[digit]}${CHINESE_SMALL_NUMBER_UNITS[unitIndex]}`);
  }
  return output.join("");
}

function practicePhraseMatches(targetText, recognizedText, targetLanguage) {
  const phrases = splitPracticePhrases(targetText);
  const recognized = normalizePracticeText(recognizedText, targetLanguage);
  const normalizedTargets = phrases.map((phrase) => normalizePracticeText(phrase, targetLanguage));
  let cursor = 0;
  return phrases.map((phrase, index) => {
    const normalizedTarget = normalizedTargets[index];
    const exactStart = recognized.indexOf(normalizedTarget, cursor);
    const laterExactStarts = normalizedTargets
      .slice(index + 1)
      .filter(Boolean)
      .map((laterTarget) => recognized.indexOf(laterTarget, cursor))
      .filter((start) => start >= 0);
    const nextExactStart = laterExactStarts.length ? Math.min(...laterExactStarts) : -1;
    const match = exactStart >= 0 && (nextExactStart < 0 || exactStart <= nextExactStart)
      ? { recognized_start: exactStart, recognized_end: exactStart + normalizedTarget.length, similarity: 1 }
      : bestPracticePhraseMatch(
          normalizedTarget,
          recognized.slice(0, nextExactStart >= cursor ? nextExactStart : recognized.length),
          cursor,
        );
    const matched = Boolean(normalizedTarget) && match.similarity >= 0.45;
    if (matched) {
      cursor = match.recognized_end;
    }
    return {
      index,
      target: phrase,
      normalized_target: normalizedTarget,
      recognized_start: match.recognized_start,
      recognized_end: match.recognized_end,
      normalized_recognized: recognized.slice(match.recognized_start, match.recognized_end),
      similarity: Math.round(match.similarity * 1000) / 1000,
      matched,
    };
  });
}

function practicePhraseSimilarity(matches) {
  let weightedTotal = 0;
  let weightSum = 0;
  for (const match of matches) {
    const weight = String(match.normalized_target || "").length;
    if (weight <= 0) {
      continue;
    }
    weightedTotal += weight * (Number(match.similarity) || 0);
    weightSum += weight;
  }
  if (!weightSum) {
    return 0;
  }
  return Math.max(0, Math.min(1, weightedTotal / weightSum));
}

function practicePhraseMacroSimilarity(matches) {
  if (!matches.length) return 0;
  const total = matches.reduce((sum, match) => sum + (Number(match.similarity) || 0), 0);
  return Math.max(0, Math.min(1, total / matches.length));
}

function practiceUnconsumedRecognized(recognizedNormalized, matches, targetLanguage, recognizedText) {
  let intervals = matches
    .filter((match) => match.matched)
    .map((match) => [
      Math.max(0, Number(match.recognized_start) || 0),
      Math.min(recognizedNormalized.length, Number(match.recognized_end) || 0),
    ])
    .filter(([start, end]) => end > start);
  if (targetLanguage === "en-US") {
    const tokenRanges = englishNormalizedTokenRanges(recognizedText);
    intervals = intervals.map(([start, end]) => {
      const overlaps = tokenRanges.filter(([tokenStart, tokenEnd]) => tokenEnd > start && tokenStart < end);
      if (!overlaps.length) return [start, end];
      return [
        Math.min(...overlaps.map(([tokenStart]) => tokenStart)),
        Math.max(...overlaps.map(([, tokenEnd]) => tokenEnd)),
      ];
    });
  }
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const [start, end] of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of [...merged, [recognizedNormalized.length, recognizedNormalized.length]]) {
    if (start > cursor) {
      const text = recognizedNormalized.slice(cursor, start);
      if (!isNormalizedScoringFiller(text, targetLanguage)) {
        gaps.push({ start: cursor, end: start, normalized_text: text });
      }
    }
    cursor = Math.max(cursor, end);
  }
  return gaps;
}

function englishNormalizedTokenRanges(text) {
  const ranges = [];
  let cursor = 0;
  for (const match of String(text || "").matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/gu)) {
    const normalized = normalizePracticeText(match[0], "en-US");
    if (!normalized) continue;
    ranges.push([cursor, cursor + normalized.length]);
    cursor += normalized.length;
  }
  return ranges;
}

function isNormalizedScoringFiller(text, targetLanguage) {
  if (!text) return true;
  return (PRACTICE_EDGE_FILLERS[targetLanguage] || new Set()).has(text)
    || (PRACTICE_BOUNDARY_FILLER_SEQUENCES[targetLanguage] || new Set()).has(text);
}

export function practiceComparisonAlignment({ targetText, recognizedText, targetLanguage, asrTimestamps }) {
  const alignmentStarted = performance.now();
  const language = supportedPracticeTargetLanguage(targetLanguage);
  const phrases = comparisonTargetPhrases(targetText, language);
  const rawTimestampData = asrTimestamps && typeof asrTimestamps === "object" ? asrTimestamps : {};
  if (rawTimestampData.available === false) {
    const rawWordCount = rawTimestampCount(rawTimestampData.raw_timestamp_word_count, rawTimestampData.words);
    const rawSegmentCount = rawTimestampCount(
      rawTimestampData.raw_timestamp_segment_count,
      rawTimestampData.segments,
    );
    if ((rawWordCount || rawSegmentCount) && !normalizePracticeText(recognizedText, language)) {
      throw new PracticeAlignmentError("contradictory_timestamp_payload");
    }
    return transcriptionOnlyAlignmentResult(phrases, recognizedText, language, {
      rawWordCount,
      rawSegmentCount,
      contradictory: Boolean(rawWordCount || rawSegmentCount),
      alignmentElapsedMs: performance.now() - alignmentStarted,
    });
  }
  const timestampData = rawTimestampData;
  const wordSource = asrWordSpans(timestampData.words, language);
  wordSource.raw_count = rawTimestampCount(timestampData.raw_timestamp_word_count, timestampData.words);
  const wordSpans = wordSource.source_valid ? wordSource.spans : [];
  const recognized = wordSource.source_valid ? wordSource.recognized : "";
  const segmentSource = asrSegments(timestampData.segments);
  segmentSource.raw_count = rawTimestampCount(
    timestampData.raw_timestamp_segment_count,
    timestampData.segments,
  );
  excludeDisjointSegmentSource(wordSpans, wordSource.source_valid, segmentSource);

  if (wordSpans.length && recognized) {
    const aligned = phrases.length === 1
      ? {
          ranges: [alignSinglePhraseToWordSpans(phrases[0], recognized, wordSpans, language)],
          metrics: { candidate_count: 1, score_computation_count: 2 },
        }
      : alignPhrasesToWordSpans(phrases, recognized, wordSpans, language);
    const diagnostics = alignmentDiagnostics(aligned.ranges, phrases, wordSpans, language, {
      ...aligned.metrics,
      alignment_elapsed_ms: performance.now() - alignmentStarted,
      source: wordSource,
      segmentSource,
    });
    let complete = aligned.ranges.length > 0 && aligned.ranges.every((entry) => entry.available);
    if (diagnostics.unassigned_tokens.some((token) => token.reason === "unexplained_internal_token")) {
      complete = false;
    }
    return {
      available: aligned.ranges.some((entry) => entry.available),
      complete,
      mode: "target_phrase_word_alignment",
      reason: complete ? "" : "some target phrases could not be mapped to reliable word timestamps",
      target_language: language,
      recognized_normalized: recognized,
      target_phrase_count: phrases.length,
      ranges: aligned.ranges,
      diagnostics,
    };
  }

  if (segmentSource.raw_count) {
    if (
      (!segmentSource.segments.length || !segmentSource.source_valid)
      && !normalizePracticeText(recognizedText, language)
    ) {
      throw new PracticeAlignmentError("invalid_timestamp_payload");
    }
    if (!segmentSource.segments.length || !segmentSource.source_valid) {
      return transcriptionOnlyAlignmentResult(phrases, recognizedText, language, {
        rawWordCount: wordSource.raw_count,
        rawSegmentCount: segmentSource.raw_count,
        diagnosticFlags: [
          ...wordSource.flags,
          ...segmentSource.flags,
          "invalid_timestamp_payload",
        ],
        invalidTimestampUnits: [
          ...wordSource.invalid_units,
          ...segmentSource.invalid_units,
        ],
        unassignedTimestampUnits: phrases.length > 1
          ? primaryInvalidTimestampUnits(wordSource, segmentSource)
          : [],
        alignmentElapsedMs: performance.now() - alignmentStarted,
      });
    }
    return alignPhrasesToSegments(phrases, segmentSource, recognizedText, language, {
      alignmentElapsedMs: performance.now() - alignmentStarted,
      discardedWordSource: wordSource,
    });
  }

  const rawWordCount = wordSource.raw_count;
  if (rawWordCount && !normalizePracticeText(recognizedText, language)) {
    throw new PracticeAlignmentError("invalid_timestamp_payload");
  }
  if (normalizePracticeText(recognizedText, language)) {
    return transcriptionOnlyAlignmentResult(phrases, recognizedText, language, {
      rawWordCount,
      rawSegmentCount: 0,
      diagnosticFlags: [
        ...wordSource.flags,
        ...(rawWordCount ? ["invalid_timestamp_payload"] : []),
      ],
      invalidTimestampUnits: wordSource.invalid_units,
      unassignedTimestampUnits: phrases.length > 1 ? [...wordSource.invalid_units] : [],
      alignmentElapsedMs: performance.now() - alignmentStarted,
    });
  }

  return {
    available: false,
    complete: false,
    mode: "unavailable",
    reason: "word timestamps were unavailable and segments could not be mapped safely",
    target_language: language,
    recognized_normalized: normalizePracticeText(recognizedText, language),
    target_phrase_count: phrases.length,
    ranges: phrases.map((phrase, index) => ({
      index,
      source_index: phrase.source_index,
      target: phrase.target,
      normalized_target: phrase.normalized_target,
      available: false,
      matched: false,
      content_matched: null,
      source: "none",
      similarity: 0,
      content_similarity: 0,
      coverage: 0,
      recognized_start: null,
      recognized_end: null,
      normalized_recognized: "",
      matched_text: "",
      audio_start: null,
      audio_end: null,
      alignment_confidence: "unavailable",
      boundary_source: "none",
      token_start_index: null,
      token_end_index: null,
    })),
    diagnostics: alignmentDiagnostics([], phrases, wordSpans, language, {
      candidate_count: 0,
      score_computation_count: 0,
      alignment_elapsed_ms: performance.now() - alignmentStarted,
    }),
  };
}

export function practiceComparisonAlignmentCanonical(options) {
  let language;
  try {
    language = supportedPracticeTargetLanguage(options.targetLanguage);
  } catch (error) {
    throw new PracticeAlignmentInputError("unsupported_target_language");
  }
  const phrases = comparisonTargetPhrases(options.targetText, language);
  if (!phrases.length) throw new PracticeAlignmentInputError("empty_target");
  const timestampData = options.asrTimestamps && typeof options.asrTimestamps === "object"
    ? options.asrTimestamps
    : {};
  const rawWordCount = rawTimestampCount(timestampData.raw_timestamp_word_count, timestampData.words);
  const rawSegmentCount = rawTimestampCount(
    timestampData.raw_timestamp_segment_count,
    timestampData.segments,
  );
  const timestampUnitCount = rawWordCount + rawSegmentCount;
  if (
    phrases.length > MAX_CANONICAL_TARGET_PHRASES
    || timestampUnitCount > MAX_CANONICAL_TIMESTAMP_UNITS
    || phrases.length * timestampUnitCount > MAX_CANONICAL_ALIGNMENT_COMPLEXITY
  ) {
    throw new PracticeAlignmentInputError("alignment_input_too_large");
  }
  const legacy = practiceComparisonAlignment(options);
  return canonicalAlignmentResult(legacy, {
    rawWordCount,
    rawSegmentCount,
  });
}

export function practiceAlignmentLegacyAdapter(canonical) {
  const phrases = Array.isArray(canonical?.phrases) ? canonical.phrases : [];
  return {
    available: Boolean(canonical?.available),
    complete: Boolean(canonical?.complete),
    mode: "canonical_v1_adapter",
    reason: "",
    target_language: canonical?.target_language,
    target_phrase_count: canonical?.target_phrase_count,
    ranges: phrases.map((phrase) => ({
      index: phrase.index,
      source_index: phrase.source_index,
      target: phrase.target_text,
      available: phrase.available,
      matched: phrase.content_matched === true,
      content_matched: phrase.content_matched,
      source:
        phrase.text_source === phrase.timestamp_source || phrase.timestamp_source === "none"
          ? phrase.text_source
          : "none",
      matched_text: phrase.matched_text,
      audio_start: phrase.audio_start,
      audio_end: phrase.audio_end,
      token_start_index: phrase.word_start_index,
      token_end_index: phrase.word_end_index,
    })),
    diagnostics: canonical?.diagnostics || {},
  };
}

function canonicalAlignmentResult(legacy, options) {
  const legacyRanges = Array.isArray(legacy?.ranges) ? legacy.ranges : [];
  const legacyDiagnostics = legacy?.diagnostics && typeof legacy.diagnostics === "object"
    ? legacy.diagnostics
    : {};
  const unassignedTokens = (Array.isArray(legacyDiagnostics.unassigned_tokens)
    ? legacyDiagnostics.unassigned_tokens
    : []).map(canonicalUnassignedToken);
  let unassignedNonFillerCount = unassignedTokens.filter((token) => token.reason !== "boundary_filler").length;
  let outcome = String(legacy?.outcome || "evaluated");
  if (outcome !== "no_speech" && !legacy?.recognized_normalized && !legacyRanges.length) {
    outcome = "no_speech";
  }
  const phrases = outcome === "no_speech" ? [] : legacyRanges.map(canonicalPhraseResult);
  const playablePhraseCount = phrases.filter((phrase) => phrase.available).length;
  const targetPhraseCount = Number(legacy?.target_phrase_count || legacyRanges.length);
  const allPhrasesPlayable = targetPhraseCount > 0 && playablePhraseCount === targetPhraseCount;
  let complete = allPhrasesPlayable && unassignedNonFillerCount === 0;
  const rawZeroTokens = Array.isArray(legacyDiagnostics.zero_duration_tokens)
    ? legacyDiagnostics.zero_duration_tokens
    : [];
  const invalidTimestampUnits = Array.isArray(legacyDiagnostics.invalid_timestamp_units)
    ? legacyDiagnostics.invalid_timestamp_units
    : [];
  const zeroDurationTokens = [];
  for (const token of rawZeroTokens) {
    const sourceIndex = Number(token.source_index ?? token.index ?? 0);
    const owner = phrases.find((phrase) =>
      phrase.word_start_index !== null &&
      phrase.word_start_index <= sourceIndex &&
      sourceIndex < phrase.word_end_index
    )?.index ?? token.owner_phrase_index;
    if (owner === null || owner === undefined) continue;
    zeroDurationTokens.push({
      source: String(token.source || "words"),
      source_index: sourceIndex,
      text: String(token.text || ""),
      start: token.start ?? null,
      end: token.end ?? null,
      owner_phrase_index: Number(owner),
    });
  }
  const assignedWordCount = phrases.reduce((total, phrase) => (
    phrase.word_start_index === null
      ? total
      : total + phrase.word_end_index - phrase.word_start_index
  ), 0);
  const assignedSegmentCount = phrases.filter((phrase) => phrase.text_source === "segments").length;
  const diagnostics = {
    valid_word_count: Number(
      legacyDiagnostics.valid_word_count ?? legacyDiagnostics.total_timestamp_token_count ?? 0
    ),
    valid_segment_count: Number(legacyDiagnostics.valid_segment_count || 0),
    assigned_word_count: assignedWordCount,
    assigned_segment_count: Number(legacyDiagnostics.assigned_segment_count ?? assignedSegmentCount),
    playable_word_count: Number(
      legacyDiagnostics.playable_word_count ?? legacyDiagnostics.playable_token_count ?? 0
    ),
    unassigned_non_filler_count: unassignedNonFillerCount,
    unassigned_tokens: unassignedTokens,
    zero_duration_tokens: zeroDurationTokens,
    diagnostic_flags: [...new Set(legacyDiagnostics.diagnostic_flags || [])].map(String).sort(),
    invalid_timestamp_units: invalidTimestampUnits
      .filter((unit) => unit && typeof unit === "object")
      .map(canonicalInvalidTimestampUnit),
    raw_timestamp_word_count: Number(legacyDiagnostics.raw_timestamp_word_count ?? options.rawWordCount),
    raw_timestamp_segment_count: Number(legacyDiagnostics.raw_timestamp_segment_count ?? options.rawSegmentCount),
    candidate_count: Number(legacyDiagnostics.candidate_count || 0),
    score_computation_count: Number(legacyDiagnostics.score_computation_count || 0),
    alignment_elapsed_ms: Number(legacyDiagnostics.alignment_elapsed_ms || 0),
  };
  if (outcome === "no_speech") {
    unassignedNonFillerCount = 0;
    diagnostics.unassigned_non_filler_count = 0;
    diagnostics.unassigned_tokens = [];
    diagnostics.zero_duration_tokens = [];
    complete = false;
  }
  return {
    alignment_contract_version: 1,
    outcome,
    target_language: legacy?.target_language,
    available: playablePhraseCount > 0,
    target_phrase_count: targetPhraseCount,
    playable_phrase_count: playablePhraseCount,
    all_phrases_playable: outcome === "no_speech" ? false : allPhrasesPlayable,
    unassigned_non_filler_count: unassignedNonFillerCount,
    complete,
    phrases,
    diagnostics,
  };
}

function canonicalPhraseResult(legacy) {
  const matchedText = String(legacy?.matched_text || "");
  const available = Boolean(legacy?.available);
  const assignmentStatus = available ? "assigned" : matchedText ? "text_only" : "unassigned";
  const source = String(legacy?.source || "none");
  const wordStart = legacy?.token_start_index ?? null;
  const wordEnd = legacy?.token_end_index ?? null;
  const textSource = matchedText && ["words", "segments", "transcription"].includes(source)
    ? source
    : matchedText && wordStart !== null
      ? "words"
      : "none";
  const timestampSource = available && ["words", "segments"].includes(source) ? source : "none";
  let confidence = legacy?.alignment_confidence;
  if (!["high", "medium", "low"].includes(confidence)) {
    confidence = assignmentStatus === "text_only" ? "medium" : null;
  }
  return {
    index: Number(legacy?.index || 0),
    source_index: Number(legacy?.source_index || 0),
    target_text: String(legacy?.target || ""),
    assignment_status: assignmentStatus,
    available,
    matched_text: matchedText,
    content_matched: assignmentStatus === "unassigned" ? null : legacy?.content_matched ?? false,
    alignment_confidence: confidence,
    boundary_sources: canonicalBoundarySources(String(legacy?.boundary_source || ""), source),
    text_source: textSource,
    timestamp_source: timestampSource,
    word_start_index: wordStart === null ? null : Number(wordStart),
    word_end_index: wordEnd === null ? null : Number(wordEnd),
    audio_start: available ? legacy?.audio_start ?? null : null,
    audio_end: available ? legacy?.audio_end ?? null : null,
  };
}

function canonicalBoundarySources(boundarySource, source) {
  const values = new Set();
  if (boundarySource.includes("lexical") || source === "words") values.add("text_anchor");
  if (boundarySource.includes("neighbor")) values.add("neighbor_anchors");
  if (boundarySource.includes("pause")) values.add("pause");
  if (boundarySource.includes("segment") || source === "segments") values.add("asr_segment");
  if (boundarySource.includes("single")) values.add("single_phrase");
  if (boundarySource.includes("leading") || boundarySource.includes("trailing")) values.add("utterance_edge");
  return ["text_anchor", "neighbor_anchors", "pause", "asr_segment", "single_phrase", "utterance_edge"]
    .filter((value) => values.has(value));
}

function canonicalUnassignedToken(token) {
  const reasons = {
    edge_or_boundary_filler: "boundary_filler",
    unexplained_internal_token: "ambiguous_assignment",
    no_structural_anchor: "ambiguous_assignment",
  };
  const originalReason = String(token?.canonical_reason || token?.reason || "ambiguous_assignment");
  return {
    source: String(token?.source || "words"),
    source_index: Number(token?.source_index ?? token?.index ?? 0),
    text: String(token?.text || ""),
    start: token?.start ?? null,
    end: token?.end ?? null,
    reason: reasons[originalReason] || originalReason,
  };
}

function canonicalInvalidTimestampUnit(token) {
  return {
    source: String(token?.source || "words"),
    source_index: Number(token?.source_index ?? token?.index ?? 0),
    text: String(token?.text || ""),
    start: token?.start ?? null,
    end: token?.end ?? null,
    reason: String(token?.reason || "non_numeric"),
  };
}

function bestPracticePhraseMatch(normalizedTarget, recognized, cursor) {
  if (!normalizedTarget || !recognized) {
    return { recognized_start: 0, recognized_end: 0, similarity: 0 };
  }
  let best = { recognized_start: cursor, recognized_end: cursor, similarity: 0 };
  const minLength = Math.max(1, Math.floor(normalizedTarget.length * 0.45));
  const maxLength = Math.max(minLength, Math.floor(normalizedTarget.length * 1.8) + 3);
  let bestLengthDelta = Number.POSITIVE_INFINITY;
  for (let start = Math.max(0, cursor); start < recognized.length; start += 1) {
    const lastEnd = Math.min(recognized.length, start + maxLength);
    for (let end = start + minLength; end <= lastEnd; end += 1) {
      const similarity = practiceSimilarity(normalizedTarget, recognized.slice(start, end));
      const lengthDelta = Math.abs((end - start) - normalizedTarget.length);
      const isBetterSimilarity = similarity > best.similarity + 1e-9;
      const isEqualSimilarityBetterLength = Math.abs(similarity - best.similarity) <= 1e-9 && lengthDelta < bestLengthDelta;
      if (isBetterSimilarity || isEqualSimilarityBetterLength) {
        best = { recognized_start: start, recognized_end: end, similarity };
        bestLengthDelta = lengthDelta;
      }
      if (similarity >= 0.999) {
        return best;
      }
    }
  }
  return best;
}

function comparisonTargetPhrases(targetText, targetLanguage) {
  return splitPracticePhrases(targetText)
    .map((phrase, sourceIndex) => {
      const target = String(phrase || "")
        .replace(/^(speaker\s*\d+|[a-z]\d*|\d+)\s*[：:]\s*/iu, "")
        .trim();
      return {
        source_index: sourceIndex,
        target,
        normalized_target: normalizePracticeText(target, targetLanguage),
      };
    })
    .filter((phrase) => phrase.normalized_target && !isComparisonLabelPhrase(phrase.target, phrase.normalized_target));
}

function isComparisonLabelPhrase(phrase, normalized) {
  const label = String(phrase || "").trim().replace(/[：:]$/u, "");
  if (!label) {
    return true;
  }
  if (/^(speaker\s*\d+|[a-z]\d*|\d+)$/iu.test(label)) {
    return true;
  }
  return String(normalized || "").length <= 2 && /[：:]$/u.test(String(phrase || "").trim());
}

function asrWordSpans(words, targetLanguage) {
  if (!Array.isArray(words)) {
    return {
      spans: [],
      recognized: "",
      raw_count: 0,
      source_valid: true,
      flags: [],
      invalid_units: [],
    };
  }
  const spans = [];
  const pieces = [];
  const invalidUnits = [];
  const flags = new Set();
  let cursor = 0;
  for (const [rawIndex, item] of words.entries()) {
    if (!item || typeof item !== "object") {
      invalidUnits.push(invalidTimestampUnit("words", rawIndex, "", null, null, "non_numeric"));
      continue;
    }
    const text = String(item.text || item.word || "").trim();
    const { start, end, reason } = timestampUnitValues(item.start, item.end);
    if (reason) {
      invalidUnits.push(invalidTimestampUnit("words", rawIndex, text, start, end, reason));
      continue;
    }
    const normalized = normalizePracticeText(text, targetLanguage);
    if (!normalized) {
      continue;
    }
    pieces.push(normalized);
    const spanEnd = cursor + normalized.length;
    spans.push({
      text,
      normalized,
      normalized_start: cursor,
      normalized_end: spanEnd,
      audio_start: start,
      audio_end: end,
      token_index: rawIndex,
      zero_duration: end === start,
    });
    cursor = spanEnd;
  }
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    const zeroDurationBridge = isZeroDurationOverlapBridge(spans, index);
    if (current.audio_start < previous.audio_start) {
      flags.add(zeroDurationBridge ? "zero_duration_overlap_bridge" : "non_monotonic_timestamp_source");
    }
    if (
      current.text === previous.text
      && current.audio_start === previous.audio_start
      && current.audio_end === previous.audio_end
    ) {
      flags.add("duplicate_timestamp_unit");
    }
    if (
      previous.audio_end > previous.audio_start
      && current.audio_end > current.audio_start
      && current.audio_start < previous.audio_end
    ) {
      flags.add("overlapping_timestamp_units");
    }
  }
  if (invalidUnits.length) flags.add("invalid_timestamp_unit");
  const sourceFlags = [
    "non_monotonic_timestamp_source",
    "duplicate_timestamp_unit",
    "overlapping_timestamp_units",
  ];
  const sourceValid = !sourceFlags.some((flag) => flags.has(flag));
  if (!sourceValid) {
    const sourceReason = sourceFlags.find((flag) => flags.has(flag));
    invalidUnits.push(...spans.map((span) => invalidTimestampUnit(
      "words",
      span.token_index,
      span.text,
      span.audio_start,
      span.audio_end,
      sourceReason,
    )));
  }
  return {
    spans,
    recognized: pieces.join(""),
    raw_count: words.length,
    source_valid: sourceValid,
    flags: [...flags].sort(),
    invalid_units: invalidUnits,
  };
}

function isZeroDurationOverlapBridge(spans, currentIndex) {
  const current = spans[currentIndex];
  if (current.audio_end <= current.audio_start) return false;
  let zeroIndex = currentIndex - 1;
  const zeroPoints = [];
  while (zeroIndex >= 0 && spans[zeroIndex].zero_duration) {
    zeroPoints.push(Number(spans[zeroIndex].audio_start));
    zeroIndex -= 1;
  }
  if (!zeroPoints.length || zeroIndex < 0) return false;
  const previousPositive = spans[zeroIndex];
  const previousStart = Number(previousPositive.audio_start);
  const previousEnd = Number(previousPositive.audio_end);
  const currentStart = Number(current.audio_start);
  const currentEnd = Number(current.audio_end);
  return previousEnd > previousStart
    && zeroPoints.every((point) => Math.abs(point - previousEnd) <= 1e-9)
    && previousStart <= currentStart
    && currentStart < previousEnd
    && currentEnd > previousEnd;
}

function transcriptionOnlyAlignmentResult(phrases, recognizedText, targetLanguage, options) {
  const ranges = phrases.map((phrase, index) => unavailableAlignmentRange(index, phrase, phrase.normalized_target));
  const recognized = normalizePracticeText(recognizedText, targetLanguage);
  if (phrases.length === 1 && recognized) {
    const phrase = phrases[0];
    const similarity = practiceSimilarity(String(phrase.normalized_target || ""), recognized);
    const contentMatched = practiceContentMatches(phrase.target, recognizedText, targetLanguage);
    ranges[0] = {
      index: 0,
      source_index: phrase.source_index,
      target: phrase.target,
      normalized_target: phrase.normalized_target,
      available: false,
      matched: contentMatched,
      content_matched: contentMatched,
      source: "transcription",
      similarity: roundScore(similarity),
      content_similarity: roundScore(similarity),
      coverage: roundScore(targetCharacterCoverage(String(phrase.normalized_target || ""), recognized)),
      recognized_start: 0,
      recognized_end: recognized.length,
      normalized_recognized: recognized,
      matched_text: String(recognizedText || ""),
      audio_start: null,
      audio_end: null,
      alignment_confidence: "high",
      boundary_source: "single_phrase",
      token_start_index: null,
      token_end_index: null,
    };
  }
  const flags = [...new Set(options.diagnosticFlags || [])];
  if (options.contradictory) flags.push("contradictory_timestamp_payload");
  flags.sort();
  const unassignedTokens = (options.unassignedTimestampUnits || []).map((unit) => ({
    source: String(unit?.source || "words"),
    source_index: Number(unit?.source_index || 0),
    index: Number(unit?.source_index || 0),
    text: String(unit?.text || ""),
    start: unit?.start ?? null,
    end: unit?.end ?? null,
    reason: "ambiguous_assignment",
  }));
  return {
    outcome: recognized ? "evaluated" : "no_speech",
    available: false,
    complete: false,
    mode: recognized ? "transcription_only" : "unavailable",
    reason: "timestamp payload was unavailable; only formal transcription was retained",
    target_language: targetLanguage,
    recognized_normalized: recognized,
    target_phrase_count: phrases.length,
    ranges,
    diagnostics: {
      total_timestamp_token_count: 0,
      playable_token_count: 0,
      unassigned_tokens: unassignedTokens,
      zero_duration_tokens: [],
      candidate_count: 0,
      score_computation_count: 0,
      alignment_elapsed_ms: roundScore(Math.max(0, options.alignmentElapsedMs)),
      valid_word_count: 0,
      valid_segment_count: 0,
      assigned_word_count: 0,
      assigned_segment_count: 0,
      playable_word_count: 0,
      unassigned_non_filler_count: unassignedTokens.length,
      diagnostic_flags: flags,
      invalid_timestamp_units: [...(options.invalidTimestampUnits || [])],
      raw_timestamp_word_count: options.rawWordCount,
      raw_timestamp_segment_count: options.rawSegmentCount,
    },
  };
}

function primaryInvalidTimestampUnits(wordSource, segmentSource) {
  if (Number(wordSource?.raw_count || 0) && wordSource?.invalid_units?.length) {
    return [...wordSource.invalid_units];
  }
  return [...(segmentSource?.invalid_units || [])];
}

function alignPhrasesToSegments(phrases, source, recognizedText, targetLanguage, options) {
  const ranges = phrases.map((phrase, index) => unavailableAlignmentRange(index, phrase, phrase.normalized_target));
  const matchesBySegment = source.segments.map((segment) => phrases
    .map((phrase, phraseIndex) => (
      practiceContentMatches(phrase.target, segment.text, targetLanguage) ? phraseIndex : null
    ))
    .filter((value) => value !== null));
  const uniqueSequence = matchesBySegment.filter((matches) => matches.length === 1).map((matches) => matches[0]);
  const sequenceConflict = uniqueSequence.some((value, index) => index > 0 && value < uniqueSequence[index - 1]);
  const assignedSegmentIndexes = new Set();
  const assignedPhraseIndexes = new Set();
  if (source.source_valid && !sequenceConflict) {
    for (const [segmentPosition, segment] of source.segments.entries()) {
      const matches = matchesBySegment[segmentPosition];
      if (matches.length !== 1 || assignedPhraseIndexes.has(matches[0])) continue;
      const phraseIndex = matches[0];
      const phrase = phrases[phraseIndex];
      const available = segment.end > segment.start;
      ranges[phraseIndex] = {
        index: phraseIndex,
        source_index: phrase.source_index,
        target: phrase.target,
        normalized_target: phrase.normalized_target,
        available,
        matched: true,
        content_matched: true,
        source: "segments",
        similarity: 1,
        content_similarity: 1,
        coverage: 1,
        recognized_start: null,
        recognized_end: null,
        normalized_recognized: normalizePracticeText(segment.text, targetLanguage),
        matched_text: segment.text,
        audio_start: available ? segment.start : null,
        audio_end: available ? segment.end : null,
        alignment_confidence: "high",
        boundary_source: "segment",
        token_start_index: null,
        token_end_index: null,
      };
      assignedPhraseIndexes.add(phraseIndex);
      assignedSegmentIndexes.add(segment.segment_index);
    }
  }

  const unassignedTokens = source.raw_units
    .filter((unit) => (
      !assignedSegmentIndexes.has(unit.index)
      && !source.invalid_units.some((invalid) => (
        invalid.source === "segments" && invalid.source_index === unit.index
      ))
    ))
    .map((unit) => {
      const segmentPosition = source.segments.findIndex((segment) => segment.segment_index === unit.index);
      const matching = segmentPosition >= 0 ? matchesBySegment[segmentPosition] : [];
      const segmentText = normalizePracticeText(unit.text, targetLanguage);
      const hasPartialTargetEvidence = phrases.some((phrase) => (
        targetCharacterCoverage(String(phrase.normalized_target || ""), segmentText) >= 0.25 ||
        practiceSimilarity(String(phrase.normalized_target || ""), segmentText) >= 0.35
      ));
      return {
        source: "segments",
        source_index: unit.index,
        index: unit.index,
        text: unit.text,
        start: unit.start,
        end: unit.end,
        reason: matching.length || hasPartialTargetEvidence || !source.source_valid
          ? "ambiguous_assignment"
          : "unrelated_speech",
      };
    });
  const zeroDurationTokens = [];
  for (const [phraseIndex, range] of ranges.entries()) {
    if (range.source !== "segments") continue;
    for (const segment of source.segments) {
      if (
        assignedSegmentIndexes.has(segment.segment_index) &&
        segment.text === range.matched_text &&
        segment.start === segment.end
      ) {
        zeroDurationTokens.push({
          source: "segments",
          source_index: segment.segment_index,
          index: segment.segment_index,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          owner_phrase_index: phraseIndex,
        });
      }
    }
  }
  const playableCount = ranges.filter((range) => range.available).length;
  const complete = ranges.length > 0 && playableCount === ranges.length && unassignedTokens.length === 0;
  return {
    outcome: "evaluated",
    available: playableCount > 0,
    complete,
    mode: "target_phrase_segment_alignment",
    reason: complete ? "" : "some segments could not be mapped safely",
    target_language: targetLanguage,
    recognized_normalized: normalizePracticeText(recognizedText, targetLanguage),
    target_phrase_count: phrases.length,
    ranges,
    diagnostics: {
      total_timestamp_token_count: source.raw_count,
      playable_token_count: playableCount,
      unassigned_tokens: unassignedTokens,
      zero_duration_tokens: zeroDurationTokens,
      candidate_count: matchesBySegment.filter((matches) => matches.length > 0).length,
      score_computation_count: source.segments.length * phrases.length,
      alignment_elapsed_ms: roundScore(Math.max(0, options.alignmentElapsedMs)),
      valid_word_count: 0,
      valid_segment_count: source.segments.length,
      assigned_word_count: 0,
      assigned_segment_count: assignedSegmentIndexes.size,
      playable_word_count: 0,
      unassigned_non_filler_count: unassignedTokens.length,
      diagnostic_flags: [...new Set([
        ...source.flags,
        ...(options.discardedWordSource?.flags || []),
      ])].sort(),
      invalid_timestamp_units: [
        ...(options.discardedWordSource?.invalid_units || []),
        ...source.invalid_units,
      ],
      raw_timestamp_word_count: Number(options.discardedWordSource?.raw_count || 0),
      raw_timestamp_segment_count: source.raw_count,
    },
  };
}

function asrSegments(segments) {
  if (!Array.isArray(segments)) {
    return {
      segments: [],
      raw_count: 0,
      source_valid: true,
      flags: [],
      raw_units: [],
      invalid_units: [],
    };
  }
  const normalized = [];
  const rawUnits = [];
  const invalidUnits = [];
  const flags = new Set();
  for (const [rawIndex, item] of segments.entries()) {
    const text = String(item?.text || "");
    const { start, end, reason } = timestampUnitValues(item?.start, item?.end);
    rawUnits.push({ index: rawIndex, text, start, end });
    if (reason) {
      invalidUnits.push(invalidTimestampUnit("segments", rawIndex, text, start, end, reason));
      continue;
    }
    normalized.push({ text, start, end, segment_index: rawIndex });
  }
  let sourceValid = true;
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.start < previous.start) {
      flags.add("non_monotonic_timestamp_source");
      sourceValid = false;
    }
    if (current.text === previous.text && current.start === previous.start && current.end === previous.end) {
      flags.add("duplicate_timestamp_unit");
      sourceValid = false;
    }
    if (previous.end > previous.start && current.end > current.start && current.start < previous.end) {
      flags.add("overlapping_timestamp_units");
      sourceValid = false;
    }
  }
  if (invalidUnits.length) flags.add("invalid_timestamp_unit");
  if (!sourceValid) {
    const sourceReason = [
      "non_monotonic_timestamp_source",
      "duplicate_timestamp_unit",
      "overlapping_timestamp_units",
    ].find((flag) => flags.has(flag));
    invalidUnits.push(...normalized.map((segment) => invalidTimestampUnit(
      "segments",
      segment.segment_index,
      segment.text,
      segment.start,
      segment.end,
      sourceReason,
    )));
  }
  return {
    segments: normalized,
    raw_count: segments.length,
    source_valid: sourceValid,
    flags: [...flags].sort(),
    raw_units: rawUnits,
    invalid_units: invalidUnits,
  };
}

function excludeDisjointSegmentSource(wordSpans, wordSourceValid, segmentSource) {
  if (!wordSourceValid || !segmentSource.source_valid) return;
  const positiveWords = wordSpans.filter((span) => span.audio_end > span.audio_start);
  const positiveSegments = segmentSource.segments.filter((segment) => segment.end > segment.start);
  if (!positiveWords.length || !positiveSegments.length) return;
  const wordStart = Math.min(...positiveWords.map((span) => span.audio_start));
  const wordEnd = Math.max(...positiveWords.map((span) => span.audio_end));
  const segmentStart = Math.min(...positiveSegments.map((segment) => segment.start));
  const segmentEnd = Math.max(...positiveSegments.map((segment) => segment.end));
  if (wordStart < segmentEnd && segmentStart < wordEnd) return;
  segmentSource.source_valid = false;
  segmentSource.flags = [...new Set([
    ...segmentSource.flags,
    "word_segment_boundary_conflict",
  ])].sort();
  segmentSource.invalid_units.push(...segmentSource.segments.map((segment) => invalidTimestampUnit(
    "segments",
    segment.segment_index,
    segment.text,
    segment.start,
    segment.end,
    "word_segment_boundary_conflict",
  )));
  segmentSource.segments = [];
}

function alignPhrasesToWordSpans(phrases, recognized, wordSpans, targetLanguage) {
  const memo = new Map();
  const candidatesByPhrase = [];
  const scoreCache = new Map();
  let scoreComputationCount = 0;

  function scores(target, candidate) {
    const key = JSON.stringify([target, candidate]);
    if (!scoreCache.has(key)) {
      scoreCache.set(key, {
        similarity: practiceSimilarity(target, candidate),
        coverage: targetCharacterCoverage(target, candidate),
      });
      scoreComputationCount += 1;
    }
    return scoreCache.get(key);
  }

  for (const [phraseIndex, phrase] of phrases.entries()) {
    const normalizedTarget = String(phrase.normalized_target || "");
    const targetLength = normalizedTarget.length;
    const isLastPhrase = phraseIndex === phrases.length - 1;
    const minimumLength = Math.max(1, Math.floor(targetLength * (isLastPhrase ? 0.25 : 0.35)));
    const maximumLength = Math.max(minimumLength, Math.floor(targetLength * 2.2) + 3);
    let phraseCandidates = [];
    for (let startWord = 0; startWord < wordSpans.length; startWord += 1) {
      const start = wordSpans[startWord].normalized_start;
      for (let endWord = startWord + 1; endWord <= wordSpans.length; endWord += 1) {
        const end = wordSpans[endWord - 1].normalized_end;
        const candidate = recognized.slice(start, end);
        const candidateLength = candidate.length;
        if (candidateLength < minimumLength) {
          continue;
        }
        if (candidateLength > maximumLength) {
          break;
        }
        const { similarity, coverage } = scores(normalizedTarget, candidate);
        const isTrailingPartial = isLastPhrase && endWord === wordSpans.length;
        const prefixLength = commonPrefixLength(normalizedTarget, candidate);
        const isReliableMatch = similarity >= 0.4 && coverage >= 0.45;
        const isTolerableTrailingPartial =
          isTrailingPartial &&
          similarity >= 0.3 &&
          coverage >= 0.2 &&
          prefixLength >= 2 &&
          prefixLength / Math.min(targetLength, candidateLength) >= 0.35;
        if (!isReliableMatch && !isTolerableTrailingPartial) {
          continue;
        }

        let matchesOtherPhraseBetter = false;
        for (const [otherIndex, otherPhrase] of phrases.entries()) {
          if (otherIndex === phraseIndex) {
            continue;
          }
          const other = scores(String(otherPhrase.normalized_target || ""), candidate);
          if (other.similarity >= 0.85 && other.coverage >= 0.8 && other.similarity > similarity + 0.15) {
            matchesOtherPhraseBetter = true;
            break;
          }
        }
        if (matchesOtherPhraseBetter) {
          continue;
        }

        let hasOutOfOrderPrefix = false;
        for (let splitWord = startWord + 1; splitWord < endWord; splitWord += 1) {
          const split = wordSpans[splitWord].normalized_start;
          const suffixScores = scores(normalizedTarget, recognized.slice(split, end));
          if (suffixScores.similarity < 0.85 || suffixScores.coverage < 0.8) {
            continue;
          }
          const prefix = recognized.slice(start, split);
          for (const [otherIndex, otherPhrase] of phrases.entries()) {
            if (otherIndex === phraseIndex) {
              continue;
            }
            const prefixScores = scores(String(otherPhrase.normalized_target || ""), prefix);
            if (prefixScores.similarity >= 0.85 && prefixScores.coverage >= 0.8) {
              hasOutOfOrderPrefix = true;
              break;
            }
          }
          if (hasOutOfOrderPrefix) {
            break;
          }
        }
        if (hasOutOfOrderPrefix) {
          continue;
        }

        const lengthDeltaRatio = Math.abs(candidateLength - targetLength) / Math.max(1, targetLength);
        phraseCandidates.push({
          start_word: startWord,
          end_word: endWord,
          recognized_start: start,
          recognized_end: end,
          similarity,
          coverage,
          score: coverage + similarity - 0.3 * lengthDeltaRatio,
          boundary_source: "lexical_anchor",
          alignment_confidence: alignmentConfidence(similarity, coverage),
        });
      }
    }
    if (phraseCandidates.some((candidate) => candidate.similarity >= 0.95 && candidate.coverage >= 0.95)) {
      phraseCandidates = phraseCandidates.filter(
        (candidate) => candidate.similarity >= 0.95 && candidate.coverage >= 0.95,
      );
    }
    if (phraseCandidates.length > MAX_ALIGNMENT_CANDIDATES_PER_PHRASE) {
      phraseCandidates = phraseCandidates
        .sort((left, right) =>
          right.score - left.score || left.start_word - right.start_word || left.end_word - right.end_word
        )
        .slice(0, MAX_ALIGNMENT_CANDIDATES_PER_PHRASE);
    }
    candidatesByPhrase.push(phraseCandidates);
  }

  function solve(phraseIndex, minimumWordIndex) {
    const key = `${phraseIndex}:${minimumWordIndex}`;
    if (memo.has(key)) {
      return memo.get(key);
    }
    if (phraseIndex >= phrases.length) {
      return { score: 0, count: 0, ranges: [] };
    }

    const skipped = solve(phraseIndex + 1, minimumWordIndex);
    let best = { score: skipped.score, count: skipped.count, ranges: [null, ...skipped.ranges] };
    for (const candidate of candidatesByPhrase[phraseIndex]) {
      if (candidate.start_word < minimumWordIndex) {
        continue;
      }
      const next = solve(phraseIndex + 1, candidate.end_word);
      const { score: candidateScore, ...candidateRange } = candidate;
      const option = {
        score: candidateScore + next.score,
        count: next.count + 1,
        ranges: [candidateRange, ...next.ranges],
      };
      if (
        option.score > best.score + 1e-9 ||
        (
          Math.abs(option.score - best.score) <= 1e-9 &&
          (
            option.count > best.count ||
            (
              option.count === best.count &&
              best.ranges[0] === null &&
              candidateRange.similarity >= 0.95 &&
              candidateRange.coverage >= 0.95
            )
          )
        )
      ) {
        best = option;
      }
    }

    memo.set(key, best);
    return best;
  }

  let selected = solve(0, 0).ranges;
  const lexicalAnchors = selected.map((item) => (item ? { ...item } : null));
  selected = expandInitialRepetitionRanges(phrases, selected, wordSpans, recognized);
  selected = expandTrailingAttemptRanges(phrases, selected, wordSpans, recognized, targetLanguage);
  selected = addStructuralFallbackRanges(phrases, selected, wordSpans, recognized, targetLanguage);
  selected = applyPausePartitionRanges(phrases, selected, wordSpans, recognized, targetLanguage);
  selected = assignUnassignedWordGaps(phrases, selected, wordSpans, recognized, targetLanguage);
  selected = movePrefixBeforeExactRightAnchor(
    phrases,
    selected,
    wordSpans,
    recognized,
    targetLanguage,
  );
  selected = resolveOutOfOrderGapSuffixes(
    phrases,
    lexicalAnchors,
    selected,
    wordSpans,
    recognized,
    targetLanguage,
  );
  selected = trimDetachedSpeechExpansions(
    phrases,
    lexicalAnchors,
    selected,
    wordSpans,
    recognized,
  );
  selected = trimBoundaryFillersFromRanges(
    phrases,
    selected,
    wordSpans,
    recognized,
    targetLanguage,
  );
  selected = rejectWeakOneSidedAssignments(phrases, selected, wordSpans, targetLanguage);

  let ranges = phrases.map((phrase, index) => {
    const normalizedTarget = String(phrase.normalized_target || "");
    const selection = selected[index];
    if (!selection) {
      return unavailableAlignmentRange(index, phrase, normalizedTarget);
    }
    const selectedSpans = wordSpans.slice(selection.start_word, selection.end_word);
    const [audioStart, audioEnd] = safeAlignmentAudioBounds(selectedSpans);
    if (audioStart === null || audioEnd === null || audioEnd <= audioStart) {
      return textOnlyAlignmentRange(
        index,
        phrase,
        normalizedTarget,
        selectedSpans,
        selection.recognized_start,
        selection.recognized_end,
        recognized,
        targetLanguage,
        selection.start_word,
        selection.end_word,
        selection.similarity,
        selection.coverage,
      );
    }
    const contentMatched = practiceContentMatches(
      phrase.target,
      joinMatchedWords(selectedSpans, targetLanguage),
      targetLanguage,
    );
    return {
      index,
      source_index: phrase.source_index,
      target: phrase.target,
      normalized_target: normalizedTarget,
      available: true,
      matched: contentMatched,
      content_matched: contentMatched,
      source: "words",
      similarity: roundScore(selection.similarity),
      content_similarity: roundScore(selection.similarity),
      coverage: roundScore(selection.coverage),
      recognized_start: selection.recognized_start,
      recognized_end: selection.recognized_end,
      normalized_recognized: recognized.slice(selection.recognized_start, selection.recognized_end),
      matched_text: joinMatchedWords(selectedSpans, targetLanguage),
      audio_start: audioStart,
      audio_end: audioEnd,
      alignment_confidence: selection.alignment_confidence || alignmentConfidence(selection.similarity, selection.coverage),
      boundary_source: selection.boundary_source || "lexical_anchor",
      token_start_index: selection.start_word,
      token_end_index: selection.end_word,
    };
  });
  ranges = demoteOverlappingPhraseRanges(ranges);
  return {
    ranges,
    metrics: {
      candidate_count: candidatesByPhrase.reduce((total, candidates) => total + candidates.length, 0),
      score_computation_count: scoreComputationCount,
    },
  };
}

function targetCharacterCoverage(normalizedTarget, candidate) {
  if (!normalizedTarget || !candidate) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(1, sequenceMatcherMatchingLength(normalizedTarget, candidate) / normalizedTarget.length),
  );
}

function alignmentConfidence(similarity, coverage) {
  if (
    similarity >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD &&
    coverage >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
  ) {
    return "high";
  }
  if (similarity >= 0.45 && coverage >= 0.45) {
    return "medium";
  }
  return "low";
}

function rejectWeakOneSidedAssignments(phrases, selected, wordSpans, targetLanguage) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  const exactIndexes = resolved
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && Number(item.similarity || 0) >= 0.95 && Number(item.coverage || 0) >= 0.95)
    .map(({ index }) => index);
  const assignedIndexes = resolved
    .map((item, index) => (item ? index : null))
    .filter((index) => index !== null);
  if (exactIndexes.length !== 1 || assignedIndexes.length !== 2) return resolved;
  const exactIndex = exactIndexes[0];
  const weakIndex = assignedIndexes.find((index) => index !== exactIndex);
  if (weakIndex === undefined || Math.abs(weakIndex - exactIndex) !== 1) return resolved;
  const weak = resolved[weakIndex];
  const target = String(phrases[weakIndex].normalized_target || "");
  if (!hasOneSidedTargetEvidence(
    target,
    wordSpans.slice(weak.start_word, weak.end_word),
    targetLanguage,
  )) {
    resolved[weakIndex] = null;
  }
  return resolved;
}

function matchingTargetPieceCount(target, spans) {
  const matchingPieces = new Set();
  for (const span of spans) {
    const piece = String(span.normalized || "");
    if (!piece) continue;
    if (target.includes(piece)) {
      matchingPieces.add(piece);
      continue;
    }
    if (!/^[\x00-\x7f]*$/u.test(piece) && longestCommonSubsequenceLength(target, piece) >= 2) {
      matchingPieces.add(piece);
    }
  }
  return matchingPieces.size;
}

function isAscii(value) {
  return /^[\x00-\x7f]*$/u.test(value);
}

function hasOneSidedTargetEvidence(target, spans, targetLanguage) {
  const candidate = spans.map((span) => String(span.normalized || "")).join("");
  if (!candidate || !target) return false;
  const nonSpecific = PRACTICE_NON_SPECIFIC_ALIGNMENT_PIECES[targetLanguage] || new Set();
  const specificPieces = spans.filter((span) => {
    const piece = String(span.normalized || "");
    return !nonSpecific.has(piece) && !(isAscii(piece) && piece.length < 2);
  });
  if (matchingTargetPieceCount(target, specificPieces) >= 2) return true;
  if (
    spans.length &&
    nonSpecific.has(String(spans[0].normalized || "")) &&
    matchingTargetPieceCount(target, specificPieces) >= 1 &&
    targetCharacterCoverage(target, candidate) >= 0.35
  ) {
    return true;
  }
  const prefixLength = commonPrefixLength(target, candidate);
  return (
    prefixLength >= 2 &&
    prefixLength / Math.max(1, target.length) >= 0.35 &&
    prefixLength / Math.max(1, candidate.length) > 0.5
  );
}

function hasSpecificDiagnosticOverlap(phrases, spans, targetLanguage) {
  const stops = PRACTICE_DIAGNOSTIC_STOP_PIECES[targetLanguage] || new Set();
  for (const span of spans) {
    const piece = String(span.normalized || "");
    if (!piece || stops.has(piece) || (isAscii(piece) && piece.length < 2)) continue;
    for (const phrase of phrases) {
      const target = String(phrase.normalized_target || "");
      if (target.includes(piece)) return true;
      if (!isAscii(piece) && longestCommonSubsequenceLength(target, piece) >= 2) return true;
    }
  }
  return false;
}

function isExplicitBoundaryFiller(wordSpans, targetLanguage) {
  if (!wordSpans.length) {
    return false;
  }
  const pieces = wordSpans.map((span) => String(span.normalized || ""));
  const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
  if (pieces.every((piece) => fillers.has(piece))) {
    return true;
  }
  const sequences = PRACTICE_BOUNDARY_FILLER_SEQUENCES[targetLanguage] || new Set();
  if (sequences.has(pieces.join(""))) return true;
  let coreStart = 0;
  let coreEnd = pieces.length;
  while (coreStart < coreEnd && fillers.has(pieces[coreStart])) coreStart += 1;
  while (coreEnd > coreStart && fillers.has(pieces[coreEnd - 1])) coreEnd -= 1;
  return coreStart < coreEnd && sequences.has(pieces.slice(coreStart, coreEnd).join(""));
}

function stronglyMatchesOtherTarget(phrases, excludedIndexes, wordSpans, nearlyExact = false) {
  const candidate = wordSpans.map((span) => String(span.normalized || "")).join("");
  if (!candidate) {
    return false;
  }
  const similarityThreshold = nearlyExact ? 0.95 : 0.75;
  const coverageThreshold = nearlyExact ? 0.95 : 0.7;
  return phrases.some((phrase, index) => {
    if (excludedIndexes.has(index)) {
      return false;
    }
    const target = String(phrase.normalized_target || "");
    return (
      practiceSimilarity(target, candidate) >= similarityThreshold &&
      targetCharacterCoverage(target, candidate) >= coverageThreshold
    );
  });
}

function addStructuralFallbackRanges(phrases, selected, wordSpans, recognized, targetLanguage) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  let index = 0;
  while (index < resolved.length) {
    if (resolved[index]) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < resolved.length && !resolved[index]) {
      index += 1;
    }
    const runEnd = index;
    if (runEnd - runStart !== 1) {
      continue;
    }
    const previous = runStart > 0 ? resolved[runStart - 1] : null;
    const following = runEnd < resolved.length ? resolved[runEnd] : null;
    if (!previous && !following) {
      continue;
    }
    const oneSidedAnchor = !following ? previous : !previous ? following : null;
    let lower = previous ? previous.end_word : 0;
    let upper = following ? following.start_word : wordSpans.length;
    const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
    while (lower < upper && fillers.has(String(wordSpans[lower].normalized || ""))) {
      lower += 1;
    }
    while (upper > lower && fillers.has(String(wordSpans[upper - 1].normalized || ""))) {
      upper -= 1;
    }
    const candidateSpans = wordSpans.slice(lower, upper);
    if (!candidateSpans.length || isExplicitBoundaryFiller(candidateSpans, targetLanguage)) {
      continue;
    }
    if (stronglyMatchesOtherTarget(phrases, new Set([runStart]), candidateSpans)) {
      continue;
    }
    const phrase = phrases[runStart];
    const normalizedTarget = String(phrase.normalized_target || "");
    if (
      oneSidedAnchor &&
      Number(oneSidedAnchor.similarity || 0) >= 0.95 &&
      Number(oneSidedAnchor.coverage || 0) >= 0.95 &&
      !hasOneSidedTargetEvidence(normalizedTarget, candidateSpans, targetLanguage)
    ) {
      continue;
    }
    const candidate = candidateSpans.map((span) => String(span.normalized || "")).join("");
    const similarity = practiceSimilarity(normalizedTarget, candidate);
    const coverage = targetCharacterCoverage(normalizedTarget, candidate);
    const prefixLength = commonPrefixLength(normalizedTarget, candidate);
    const lengthRatio = candidate.length / Math.max(1, normalizedTarget.length);
    const pauseBefore = lower === 0 ||
      wordSpans[lower].audio_start - wordSpans[lower - 1].audio_end >=
        PRACTICE_PAUSE_PARTITION_GAP_SECONDS;
    const pauseAfter =
      upper === wordSpans.length ||
      wordSpans[upper].audio_start - wordSpans[upper - 1].audio_end >=
        PRACTICE_PAUSE_PARTITION_GAP_SECONDS;
    const constrainedByNeighbors = Boolean(
      previous &&
      following &&
      Number(previous.similarity || 0) >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD &&
      Number(previous.coverage || 0) >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD &&
      Number(following.similarity || 0) >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD &&
      Number(following.coverage || 0) >= PRACTICE_HIGH_CONFIDENCE_ALIGNMENT_THRESHOLD
    );
    const hasInternalPartition = constrainedByNeighbors && candidateSpans.some(
      (span, spanIndex) => spanIndex > 0 &&
        span.audio_start - candidateSpans[spanIndex - 1].audio_end >=
          PRACTICE_PAUSE_PARTITION_GAP_SECONDS,
    );
    if (hasInternalPartition) {
      continue;
    }
    const structuralBoundary = constrainedByNeighbors || pauseBefore || pauseAfter || prefixLength >= 2;
    const lexicalEvidence = constrainedByNeighbors || (coverage >= 0.3 && similarity >= 0.3);
    if (!structuralBoundary || !lexicalEvidence || lengthRatio < 0.35) {
      continue;
    }
    const fallback = {};
    updateSelectedWordRange(
      fallback,
      phrase,
      lower,
      upper,
      wordSpans,
      recognized,
      constrainedByNeighbors ? "neighbor_anchors" : "pause_fallback",
    );
    fallback.alignment_confidence = "low";
    resolved[runStart] = fallback;
  }
  return resolved;
}

function applyPausePartitionRanges(phrases, selected, wordSpans, recognized, targetLanguage) {
  if (phrases.length < 2 || wordSpans.length < phrases.length) {
    return selected;
  }
  const boundaries = [0];
  for (let index = 1; index < wordSpans.length; index += 1) {
    const gap = wordSpans[index].audio_start - wordSpans[index - 1].audio_end;
    if (gap >= PRACTICE_PAUSE_PARTITION_GAP_SECONDS) {
      boundaries.push(index);
    }
  }
  boundaries.push(wordSpans.length);
  if (boundaries.length - 1 !== phrases.length) {
    return selected;
  }

  const expectedBounds = boundaries.slice(0, -1).map((startWord, index) => [startWord, boundaries[index + 1]]);
  const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
  if (expectedBounds.some(([startWord, endWord]) =>
    fillers.has(String(wordSpans[startWord].normalized || "")) ||
    fillers.has(String(wordSpans[endWord - 1].normalized || ""))
  )) {
    return selected;
  }
  const alreadyAligned = selected.every((item, index) =>
    item && item.start_word === expectedBounds[index][0] && item.end_word === expectedBounds[index][1]
  );
  if (alreadyAligned) {
    return selected;
  }
  const hasZeroDurationOverlapBridge = wordSpans.some(
    (_span, index) => index > 0 && isZeroDurationOverlapBridge(wordSpans, index),
  );
  if (
    hasZeroDurationOverlapBridge
    && selected.some((item) => item && Number(item.similarity || 0) >= 0.95 && Number(item.coverage || 0) >= 0.95)
  ) {
    return selected;
  }

  const similarities = [];
  const coverages = [];
  for (const [phraseIndex, phrase] of phrases.entries()) {
    const [startWord, endWord] = expectedBounds[phraseIndex];
    const chunk = wordSpans.slice(startWord, endWord);
    if (!chunk.length || isExplicitBoundaryFiller(chunk, targetLanguage)) {
      return selected;
    }
    if (stronglyMatchesOtherTarget(phrases, new Set([phraseIndex]), chunk)) {
      return selected;
    }
    const candidate = chunk.map((span) => String(span.normalized || "")).join("");
    const target = String(phrase.normalized_target || "");
    similarities.push(practiceSimilarity(target, candidate));
    coverages.push(targetCharacterCoverage(target, candidate));
  }
  const averageCoverage = coverages.reduce((total, coverage) => total + coverage, 0) / coverages.length;
  if (Math.max(...coverages, 0) < 0.25 || averageCoverage < 0.2) {
    return selected;
  }
  const selectedCount = selected.filter(Boolean).length;
  if (selectedCount > 0 && phrases.length !== 2) {
    return selected;
  }
  if (selectedCount === 1) {
    const anchor = selected.find(Boolean);
    if (Number(anchor.similarity || 0) >= 0.95 && Number(anchor.coverage || 0) >= 0.95) {
      return selected;
    }
  }
  if (
    selectedCount === 1 &&
    similarities.some((similarity, index) => similarity < 0.3 || coverages[index] < 0.3)
  ) {
    return selected;
  }

  return phrases.map((phrase, phraseIndex) => {
    const [startWord, endWord] = expectedBounds[phraseIndex];
    const item = {};
    updateSelectedWordRange(
      item,
      phrase,
      startWord,
      endWord,
      wordSpans,
      recognized,
      "pause_partition",
    );
    item.alignment_confidence = "low";
    return item;
  });
}

function assignUnassignedWordGaps(phrases, selected, wordSpans, recognized, targetLanguage) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  const availableIndexes = resolved.map((item, index) => (item ? index : -1)).filter((index) => index >= 0);
  if (!availableIndexes.length) {
    return resolved;
  }
  const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
  const firstIndex = availableIndexes[0];
  const first = resolved[firstIndex];
  let leadingStart = 0;
  const leadingEnd = first.start_word;
  while (leadingStart < leadingEnd && fillers.has(String(wordSpans[leadingStart].normalized || ""))) {
    leadingStart += 1;
  }
  const leading = wordSpans.slice(leadingStart, leadingEnd);
  if (
    firstIndex === 0 &&
    leading.length &&
    !isExplicitBoundaryFiller(leading, targetLanguage) &&
    !stronglyMatchesOtherTarget(phrases, new Set([0]), leading)
  ) {
    updateSelectedWordRange(
      first,
      phrases[0],
      leadingStart,
      first.end_word,
      wordSpans,
      recognized,
      "lexical_anchor+leading_gap",
    );
  }

  for (let pairIndex = 0; pairIndex < availableIndexes.length - 1; pairIndex += 1) {
    const leftIndex = availableIndexes[pairIndex];
    const rightIndex = availableIndexes[pairIndex + 1];
    if (rightIndex !== leftIndex + 1) {
      continue;
    }
    const left = resolved[leftIndex];
    const right = resolved[rightIndex];
    const gapStart = left.end_word;
    const gapEnd = right.start_word;
    const gapSpans = wordSpans.slice(gapStart, gapEnd);
    if (!gapSpans.length || isExplicitBoundaryFiller(gapSpans, targetLanguage)) {
      continue;
    }
    if (stronglyMatchesOtherTarget(phrases, new Set([leftIndex, rightIndex]), gapSpans)) {
      continue;
    }
    const gapText = gapSpans.map((span) => String(span.normalized || "")).join("");
    const leftTarget = String(phrases[leftIndex].normalized_target || "");
    const rightTarget = String(phrases[rightIndex].normalized_target || "");
    const leftText = recognized.slice(left.recognized_start, left.recognized_end);
    const rightText = recognized.slice(right.recognized_start, right.recognized_end);
    const leftGapSimilarity = practiceSimilarity(leftTarget, gapText);
    const rightGapSimilarity = practiceSimilarity(rightTarget, gapText);
    const leftGain = practiceSimilarity(leftTarget, leftText + gapText) - practiceSimilarity(leftTarget, leftText);
    const rightGain = practiceSimilarity(rightTarget, gapText + rightText) - practiceSimilarity(rightTarget, rightText);
    let assignToRight;
    if (leftGapSimilarity >= 0.75 && leftGapSimilarity > rightGapSimilarity + 1e-9) {
      assignToRight = false;
    } else if (rightGapSimilarity >= 0.75 && rightGapSimilarity > leftGapSimilarity + 1e-9) {
      assignToRight = true;
    } else if (gapSpans.length === 1 && gapText.length <= 3 && leftGain <= 0 && rightGain <= 0) {
      assignToRight = true;
    } else {
      assignToRight =
        rightGain > leftGain + 1e-9 ||
        (Math.abs(rightGain - leftGain) <= 1e-9 && rightText.length < leftText.length);
    }
    if (assignToRight) {
      updateSelectedWordRange(
        right,
        phrases[rightIndex],
        gapStart,
        right.end_word,
        wordSpans,
        recognized,
        `${right.boundary_source || "lexical_anchor"}+gap_assignment`,
      );
    } else {
      updateSelectedWordRange(
        left,
        phrases[leftIndex],
        left.start_word,
        gapEnd,
        wordSpans,
        recognized,
        `${left.boundary_source || "lexical_anchor"}+gap_assignment`,
      );
    }
  }
  return resolved;
}

function movePrefixBeforeExactRightAnchor(phrases, selected, wordSpans, recognized, targetLanguage) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  for (let leftIndex = 0; leftIndex < resolved.length - 1; leftIndex += 1) {
    const left = resolved[leftIndex];
    const right = resolved[leftIndex + 1];
    if (!left || !right) continue;
    const rightStart = right.start_word;
    const rightEnd = right.end_word;
    if (rightEnd - rightStart < 2) continue;
    const rightTarget = String(phrases[leftIndex + 1].normalized_target || "");
    let split = null;
    for (let candidateSplit = rightStart + 1; candidateSplit < rightEnd; candidateSplit += 1) {
      const suffix = wordSpans
        .slice(candidateSplit, rightEnd)
        .map((span) => String(span.normalized || ""))
        .join("");
      if (
        practiceSimilarity(rightTarget, suffix) >= 0.95 &&
        targetCharacterCoverage(rightTarget, suffix) >= 0.95
      ) {
        split = candidateSplit;
        break;
      }
    }
    if (split === null) continue;
    const leftTarget = String(phrases[leftIndex].normalized_target || "");
    const leftStart = left.start_word;
    const leftEnd = left.end_word;
    const leftText = wordSpans.slice(leftStart, leftEnd).map((span) => String(span.normalized || "")).join("");
    const expandedLeftText = wordSpans.slice(leftStart, split).map((span) => String(span.normalized || "")).join("");
    const similarityGain = practiceSimilarity(leftTarget, expandedLeftText) - practiceSimilarity(leftTarget, leftText);
    const coverageGain = targetCharacterCoverage(leftTarget, expandedLeftText) - targetCharacterCoverage(leftTarget, leftText);
    const prefixStart = right.start_word;
    const temporallyAttachedLeft = (
      prefixStart === leftEnd &&
      wordSpans[prefixStart].audio_start <= wordSpans[leftEnd - 1].audio_end + 1e-9 &&
      wordSpans[split].audio_start > wordSpans[split - 1].audio_end
    );
    const expandedContentMatches = practiceContentMatches(
      String(phrases[leftIndex].target || ""),
      joinMatchedWords(wordSpans.slice(leftStart, split), targetLanguage),
      targetLanguage,
    );
    if (
      similarityGain <= 0.01 &&
      coverageGain <= 0.01 &&
      !temporallyAttachedLeft &&
      !expandedContentMatches
    ) {
      continue;
    }
    updateSelectedWordRange(
      left,
      phrases[leftIndex],
      leftStart,
      split,
      wordSpans,
      recognized,
      "exact_right_anchor",
    );
    updateSelectedWordRange(
      right,
      phrases[leftIndex + 1],
      split,
      rightEnd,
      wordSpans,
      recognized,
      "exact_right_anchor",
    );
  }
  return resolved;
}

function resolveOutOfOrderGapSuffixes(
  phrases,
  lexicalAnchors,
  selected,
  wordSpans,
  recognized,
  targetLanguage,
) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  for (let rightIndex = 0; rightIndex < resolved.length; rightIndex += 1) {
    const anchor = lexicalAnchors[rightIndex];
    const right = resolved[rightIndex];
    if (!anchor || !right || rightIndex === 0) continue;
    const anchorStart = anchor.start_word;
    const previousAnchor = lexicalAnchors.slice(0, rightIndex).reverse().find(Boolean);
    const gapStart = previousAnchor ? previousAnchor.end_word : 0;
    if (gapStart >= anchorStart) continue;
    let outOfOrderEnd = null;
    for (let split = gapStart + 1; split <= anchorStart; split += 1) {
      if (stronglyMatchesOtherTarget(phrases, new Set([rightIndex]), wordSpans.slice(gapStart, split), true)) {
        outOfOrderEnd = split;
        break;
      }
    }
    if (outOfOrderEnd === null) continue;
    const suffix = wordSpans.slice(outOfOrderEnd, anchorStart);
    let newStart;
    if (!suffix.length || isExplicitBoundaryFiller(suffix, targetLanguage)) {
      newStart = anchorStart;
    } else {
      const separatedFromConflict = suffix[0].audio_start > wordSpans[outOfOrderEnd - 1].audio_end;
      const adjacentToAnchor = wordSpans[anchorStart].audio_start <= suffix[suffix.length - 1].audio_end + 1e-9;
      newStart = separatedFromConflict && adjacentToAnchor ? outOfOrderEnd : anchorStart;
    }
    if (newStart === right.start_word) continue;
    updateSelectedWordRange(
      right,
      phrases[rightIndex],
      newStart,
      right.end_word,
      wordSpans,
      recognized,
      "out_of_order_gap_guard",
    );
  }
  return resolved;
}

function trimDetachedSpeechExpansions(phrases, lexicalAnchors, selected, wordSpans, recognized) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  for (let index = 0; index < resolved.length; index += 1) {
    const anchor = lexicalAnchors[index];
    const item = resolved[index];
    if (!anchor || !item) continue;
    let startWord = item.start_word;
    let endWord = item.end_word;
    const anchorStart = anchor.start_word;
    const anchorEnd = anchor.end_word;
    if (startWord < anchorStart) {
      const leadingGap = wordSpans[anchorStart].audio_start - wordSpans[anchorStart - 1].audio_end;
      if (leadingGap >= PRACTICE_DETACHED_SPEECH_GAP_SECONDS) startWord = anchorStart;
    }
    if (endWord > anchorEnd && anchorEnd < wordSpans.length) {
      const trailingGap = wordSpans[anchorEnd].audio_start - wordSpans[anchorEnd - 1].audio_end;
      if (trailingGap >= PRACTICE_DETACHED_SPEECH_GAP_SECONDS) endWord = anchorEnd;
    }
    if (startWord !== item.start_word || endWord !== item.end_word) {
      updateSelectedWordRange(
        item,
        phrases[index],
        startWord,
        endWord,
        wordSpans,
        recognized,
        "detached_speech_guard",
      );
    }
  }
  return resolved;
}

function trimBoundaryFillersFromRanges(phrases, selected, wordSpans, recognized, targetLanguage) {
  const resolved = selected.map((item) => (item ? { ...item } : null));
  for (let index = 0; index < resolved.length; index += 1) {
    const item = resolved[index];
    if (!item) continue;
    const startWord = item.start_word;
    const endWord = item.end_word;
    const target = String(phrases[index].normalized_target || "");
    let trimmedStart = startWord;
    for (let cut = startWord + 1; cut < endWord; cut += 1) {
      const prefix = wordSpans.slice(startWord, cut);
      const prefixText = prefix.map((span) => String(span.normalized || "")).join("");
      if (isExplicitBoundaryFiller(prefix, targetLanguage) && !target.startsWith(prefixText)) {
        trimmedStart = cut;
      }
    }
    let trimmedEnd = endWord;
    for (let cut = trimmedStart + 1; cut < endWord; cut += 1) {
      const suffix = wordSpans.slice(cut, endWord);
      const suffixText = suffix.map((span) => String(span.normalized || "")).join("");
      if (isExplicitBoundaryFiller(suffix, targetLanguage) && !target.endsWith(suffixText)) {
        trimmedEnd = cut;
        break;
      }
    }
    if (trimmedStart !== startWord || trimmedEnd !== endWord) {
      updateSelectedWordRange(
        item,
        phrases[index],
        trimmedStart,
        trimmedEnd,
        wordSpans,
        recognized,
        "boundary_filler_guard",
      );
    }
  }
  return resolved;
}

function safeAlignmentAudioBounds(selectedSpans) {
  const timed = selectedSpans.filter((span) => span.audio_end > span.audio_start);
  if (!timed.length) {
    return [null, null];
  }
  return [
    Math.min(...timed.map((span) => Number(span.audio_start))),
    Math.max(...timed.map((span) => Number(span.audio_end))),
  ];
}

function demoteOverlappingPhraseRanges(ranges) {
  const conflictIndexes = new Set();
  let previousIndex = null;
  for (const [index, entry] of ranges.entries()) {
    if (!entry.available) continue;
    if (previousIndex !== null && Number(entry.audio_start) < Number(ranges[previousIndex].audio_end)) {
      conflictIndexes.add(previousIndex);
      conflictIndexes.add(index);
    }
    previousIndex = index;
  }
  for (const index of conflictIndexes) {
    const entry = ranges[index];
    entry.available = false;
    entry.source = "none";
    entry.audio_start = null;
    entry.audio_end = null;
    entry.boundary_source = `${entry.boundary_source || "lexical_anchor"}+overlapping_phrase_range_guard`;
    entry.diagnostic_flags = ["overlapping_phrase_ranges"];
  }
  return ranges;
}

function textOnlyAlignmentRange(
  index,
  phrase,
  normalizedTarget,
  selectedSpans,
  start,
  end,
  recognized,
  targetLanguage,
  startWord,
  endWord,
  similarity,
  coverage,
) {
  const contentMatched = practiceContentMatches(
    phrase.target,
    joinMatchedWords(selectedSpans, targetLanguage),
    targetLanguage,
  );
  return {
    index,
    source_index: phrase.source_index,
    target: phrase.target,
    normalized_target: normalizedTarget,
    available: false,
    matched: contentMatched,
    content_matched: contentMatched,
    source: "none",
    similarity: roundScore(similarity),
    content_similarity: roundScore(similarity),
    coverage: roundScore(coverage),
    recognized_start: start,
    recognized_end: end,
    normalized_recognized: recognized.slice(start, end),
    matched_text: joinMatchedWords(selectedSpans, targetLanguage),
    audio_start: null,
    audio_end: null,
    alignment_confidence: "text_only",
    boundary_source: "zero_duration_text_only",
    token_start_index: startWord,
    token_end_index: endWord,
  };
}

function alignmentDiagnostics(ranges, phrases, wordSpans, targetLanguage, metrics) {
  const source = metrics.source || {
    raw_count: wordSpans.length,
    flags: [],
    invalid_units: [],
  };
  const segmentSource = metrics.segmentSource || {
    raw_count: 0,
    segments: [],
    flags: [],
    invalid_units: [],
  };
  const owned = new Set();
  const playable = new Set();
  for (const entry of ranges) {
    if (entry.token_start_index === null || entry.token_start_index === undefined) {
      continue;
    }
    for (let index = entry.token_start_index; index < entry.token_end_index; index += 1) {
      owned.add(index);
      if (entry.available) {
        playable.add(index);
      }
    }
  }
  const ownedIndexes = [...owned];
  const ownedMin = ownedIndexes.length ? Math.min(...ownedIndexes) : null;
  const ownedMax = ownedIndexes.length ? Math.max(...ownedIndexes) : null;
  const unassignedIndexes = wordSpans.map((_, index) => index).filter((index) => !owned.has(index));
  const fillerIndexes = new Set();
  const canonicalReasons = new Map();
  let runStart = 0;
  while (runStart < unassignedIndexes.length) {
    let runEnd = runStart + 1;
    while (
      runEnd < unassignedIndexes.length &&
      unassignedIndexes[runEnd] === unassignedIndexes[runEnd - 1] + 1
    ) {
      runEnd += 1;
    }
    const runIndexes = unassignedIndexes.slice(runStart, runEnd);
    const runSpans = runIndexes.map((index) => wordSpans[index]);
    if (isExplicitBoundaryFiller(runSpans, targetLanguage)) {
      runIndexes.forEach((index) => fillerIndexes.add(index));
    }
    for (const [position, span] of runSpans.entries()) {
      if (span.zero_duration) canonicalReasons.set(runIndexes[position], "no_positive_duration");
    }

    let coreStart = 0;
    let coreEnd = runSpans.length;
    for (let cut = 1; cut <= runSpans.length; cut += 1) {
      if (isExplicitBoundaryFiller(runSpans.slice(0, cut), targetLanguage)) coreStart = cut;
    }
    for (let cut = coreStart; cut < runSpans.length; cut += 1) {
      if (isExplicitBoundaryFiller(runSpans.slice(cut), targetLanguage)) {
        coreEnd = cut;
        break;
      }
    }
    for (const position of [
      ...Array.from({ length: coreStart }, (_, index) => index),
      ...Array.from({ length: runSpans.length - coreEnd }, (_, index) => coreEnd + index),
    ]) {
      const index = runIndexes[position];
      if (!canonicalReasons.has(index)) canonicalReasons.set(index, "boundary_filler");
    }

    let corePairs = runIndexes
      .slice(coreStart, coreEnd)
      .map((index, position) => [index, runSpans[coreStart + position]])
      .filter(([index]) => !canonicalReasons.has(index));
    if (corePairs.length) {
      const [markerIndex, markerSpan] = corePairs[0];
      const marker = String(markerSpan.normalized || "");
      if (
        (PRACTICE_NON_SPECIFIC_ALIGNMENT_PIECES[targetLanguage] || new Set()).has(marker) &&
        phrases.some((phrase) => String(phrase.normalized_target || "").startsWith(marker)) &&
        !stronglyMatchesOtherTarget(phrases, new Set(), corePairs.map(([, span]) => span))
      ) {
        canonicalReasons.set(markerIndex, "ambiguous_assignment");
        corePairs = corePairs.slice(1);
      }
    }
    if (corePairs.length) {
      const coreIndexes = corePairs.map(([index]) => index);
      const coreSpans = corePairs.map(([, span]) => span);
      let coreReason;
      if (stronglyMatchesOtherTarget(phrases, new Set(), coreSpans)) {
        coreReason = "out_of_order_speech";
      } else {
        const candidate = coreSpans.map((span) => String(span.normalized || "")).join("");
        const isTargetPrefix = phrases.some((phrase) => {
          const target = String(phrase.normalized_target || "");
          return target.startsWith(candidate) && candidate.length < target.length;
        });
        const strongestSimilarity = Math.max(
          0,
          ...phrases.map((phrase) => practiceSimilarity(String(phrase.normalized_target || ""), candidate)),
        );
        const strongestCoverage = Math.max(
          0,
          ...phrases.map((phrase) => targetCharacterCoverage(String(phrase.normalized_target || ""), candidate)),
        );
        const firstIndex = coreIndexes[0];
        const lastIndex = coreIndexes[coreIndexes.length - 1];
        const detachedBefore = (
          firstIndex > 0 &&
          wordSpans[firstIndex].audio_start - wordSpans[firstIndex - 1].audio_end >=
            PRACTICE_DETACHED_SPEECH_GAP_SECONDS
        );
        const detachedAfter = (
          lastIndex + 1 < wordSpans.length &&
          wordSpans[lastIndex + 1].audio_start - wordSpans[lastIndex].audio_end >=
            PRACTICE_DETACHED_SPEECH_GAP_SECONDS
        );
        if (isTargetPrefix) {
          coreReason = "ambiguous_assignment";
        } else if (!hasSpecificDiagnosticOverlap(phrases, coreSpans, targetLanguage)) {
          coreReason = "unrelated_speech";
        } else {
          coreReason = (
            detachedBefore ||
            detachedAfter ||
            (strongestSimilarity < 0.35 && strongestCoverage < 0.25)
          ) ? "unrelated_speech" : "ambiguous_assignment";
        }
      }
      coreIndexes.forEach((index) => canonicalReasons.set(index, coreReason));
    }
    runStart = runEnd;
  }
  const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
  const unassignedTokens = unassignedIndexes.map((index) => {
    const span = wordSpans[index];
    let reason = "no_structural_anchor";
    if (fillerIndexes.has(index) || fillers.has(String(span.normalized || ""))) {
      reason = "edge_or_boundary_filler";
    } else if (ownedMin !== null && ownedMin < index && index < ownedMax) {
      reason = "unexplained_internal_token";
    }
    return {
      source: "words",
      source_index: span.token_index,
      index,
      text: span.text,
      start: span.audio_start,
      end: span.audio_end,
      reason,
      canonical_reason: canonicalReasons.get(index) || "ambiguous_assignment",
    };
  });
  return {
    total_timestamp_token_count: wordSpans.length,
    playable_token_count: playable.size,
    unassigned_tokens: unassignedTokens,
    zero_duration_tokens: wordSpans
      .map((span, index) => ({ span, index }))
      .filter(({ span }) => span.zero_duration)
      .map(({ span, index }) => ({
        source: "words",
        source_index: span.token_index,
        index,
        text: span.text,
        start: span.audio_start,
        end: span.audio_end,
      })),
    candidate_count: metrics.candidate_count,
    score_computation_count: metrics.score_computation_count,
    alignment_elapsed_ms: roundScore(Math.max(0, metrics.alignment_elapsed_ms)),
    valid_word_count: wordSpans.length,
    valid_segment_count: segmentSource.segments.length,
    assigned_word_count: owned.size,
    assigned_segment_count: 0,
    playable_word_count: playable.size,
    unassigned_non_filler_count: unassignedTokens.filter(
      (token) => token.reason !== "edge_or_boundary_filler"
    ).length,
    diagnostic_flags: [...new Set([
      ...source.flags,
      ...segmentSource.flags,
      ...ranges.flatMap((entry) => entry.diagnostic_flags || []),
    ])].sort(),
    invalid_timestamp_units: [...source.invalid_units, ...segmentSource.invalid_units],
    raw_timestamp_word_count: source.raw_count,
    raw_timestamp_segment_count: segmentSource.raw_count,
  };
}

function expandInitialRepetitionRanges(phrases, selected, wordSpans, recognized) {
  const expanded = [];
  let previousEndWord = 0;
  for (const [index, phrase] of phrases.entries()) {
    const selection = selected[index];
    if (!selection) {
      expanded.push(null);
      continue;
    }
    const item = { ...selection };
    let startWord = item.start_word;
    const endWord = item.end_word;
    const originalStartWord = startWord;
    for (let candidateStart = startWord - 1; candidateStart >= previousEndWord; candidateStart -= 1) {
      if (
        isTargetPrefixAttemptSequence(
          wordSpans.slice(candidateStart, originalStartWord),
          String(phrase.normalized_target || ""),
        )
      ) {
        startWord = candidateStart;
      }
    }
    const substantialPrefixStart = earliestSubstantialPrefixAttemptStart(
      wordSpans,
      previousEndWord,
      originalStartWord,
      String(phrase.normalized_target || ""),
    );
    if (
      substantialPrefixStart !== null &&
      !stronglyMatchesOtherTarget(
        phrases,
        new Set([index]),
        wordSpans.slice(substantialPrefixStart, originalStartWord),
        true,
      )
    ) {
      startWord = Math.min(startWord, substantialPrefixStart);
    }

    if (startWord !== originalStartWord) {
      updateSelectedWordRange(item, phrase, startWord, endWord, wordSpans, recognized);
    }
    expanded.push(item);
    previousEndWord = endWord;
  }
  return expanded;
}

function isTargetPrefixAttemptSequence(wordSpans, normalizedTarget) {
  if (!wordSpans.length || !normalizedTarget) {
    return false;
  }
  const pieces = wordSpans.map((span) => String(span.normalized || ""));
  const memo = new Map();
  function canPartition(start) {
    if (start === pieces.length) {
      return true;
    }
    if (memo.has(start)) {
      return memo.get(start);
    }
    let attempt = "";
    for (let end = start; end < pieces.length; end += 1) {
      attempt += pieces[end];
      if (!normalizedTarget.startsWith(attempt)) {
        break;
      }
      if (canPartition(end + 1)) {
        memo.set(start, true);
        return true;
      }
    }
    memo.set(start, false);
    return false;
  }
  return canPartition(0);
}

function earliestSubstantialPrefixAttemptStart(wordSpans, minimumWord, selectedStartWord, normalizedTarget) {
  if (minimumWord >= selectedStartWord || !normalizedTarget) {
    return null;
  }
  const minimumAttemptLength = Math.min(
    normalizedTarget.length,
    Math.max(2, Math.floor(normalizedTarget.length * 0.25)),
  );
  for (let candidateStart = minimumWord; candidateStart < selectedStartWord; candidateStart += 1) {
    let attempt = "";
    for (let candidateEnd = candidateStart; candidateEnd < selectedStartWord; candidateEnd += 1) {
      attempt += String(wordSpans[candidateEnd].normalized || "");
      if (!normalizedTarget.startsWith(attempt)) {
        break;
      }
      if (attempt.length >= minimumAttemptLength) {
        return candidateStart;
      }
    }
  }
  return null;
}

function expandTrailingAttemptRanges(phrases, selected, wordSpans, recognized, targetLanguage) {
  return phrases.map((phrase, index) => {
    const selection = selected[index];
    if (!selection) {
      return null;
    }
    const item = { ...selection };
    const startWord = item.start_word;
    const endWord = item.end_word;
    const nextSelection = selected.slice(index + 1).find(Boolean);
    const nextStartWord = nextSelection ? nextSelection.start_word : wordSpans.length;
    let expandedEndWord = endWord;
    const normalizedTarget = String(phrase.normalized_target || "");

    if (index === phrases.length - 1) {
      expandedEndWord = nextStartWord;
      const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
      while (expandedEndWord > endWord) {
        const token = String(wordSpans[expandedEndWord - 1].normalized || "");
        if (!fillers.has(token) || normalizedTarget.endsWith(token)) {
          break;
        }
        expandedEndWord -= 1;
      }
      const outOfOrderStart = findOutOfOrderTargetStart(
        phrases,
        index,
        wordSpans,
        endWord,
        expandedEndWord,
      );
      if (outOfOrderStart !== null) {
        expandedEndWord = outOfOrderStart;
      }
    } else {
      for (let candidateEnd = endWord + 1; candidateEnd <= nextStartWord; candidateEnd += 1) {
        if (isTargetSuffixAttemptSequence(wordSpans.slice(endWord, candidateEnd), normalizedTarget)) {
          expandedEndWord = candidateEnd;
        }
      }
    }

    if (expandedEndWord !== endWord) {
      updateSelectedWordRange(item, phrase, startWord, expandedEndWord, wordSpans, recognized);
    }
    return item;
  });
}

function findOutOfOrderTargetStart(phrases, currentPhraseIndex, wordSpans, trailingStartWord, trailingEndWord) {
  const otherTargets = phrases
    .filter((_, index) => index !== currentPhraseIndex)
    .map((phrase) => String(phrase.normalized_target || ""));
  for (let candidateStart = trailingStartWord; candidateStart < trailingEndWord; candidateStart += 1) {
    let candidate = "";
    for (let candidateEnd = candidateStart; candidateEnd < trailingEndWord; candidateEnd += 1) {
      candidate += String(wordSpans[candidateEnd].normalized || "");
      for (const target of otherTargets) {
        if (
          practiceSimilarity(target, candidate) >= 0.75 &&
          targetCharacterCoverage(target, candidate) >= 0.7
        ) {
          return candidateStart;
        }
      }
    }
  }
  return null;
}

function isTargetSuffixAttemptSequence(wordSpans, normalizedTarget) {
  if (!wordSpans.length || !normalizedTarget) {
    return false;
  }
  const pieces = wordSpans.map((span) => String(span.normalized || ""));
  const memo = new Map();
  function canPartition(start) {
    if (start === pieces.length) {
      return true;
    }
    if (memo.has(start)) {
      return memo.get(start);
    }
    let attempt = "";
    for (let end = start; end < pieces.length; end += 1) {
      attempt += pieces[end];
      if (
        (attempt.length >= Math.min(2, normalizedTarget.length) || !/^[\x00-\x7F]*$/.test(attempt)) &&
        attempt.length < normalizedTarget.length &&
        normalizedTarget.endsWith(attempt) &&
        canPartition(end + 1)
      ) {
        memo.set(start, true);
        return true;
      }
    }
    memo.set(start, false);
    return false;
  }
  return canPartition(0);
}

function updateSelectedWordRange(item, phrase, startWord, endWord, wordSpans, recognized, boundarySource = null) {
  const start = wordSpans[startWord].normalized_start;
  const end = wordSpans[endWord - 1].normalized_end;
  const candidate = recognized.slice(start, end);
  const normalizedTarget = String(phrase.normalized_target || "");
  const updates = {
    start_word: startWord,
    end_word: endWord,
    recognized_start: start,
    recognized_end: end,
    similarity: practiceSimilarity(normalizedTarget, candidate),
    coverage: targetCharacterCoverage(normalizedTarget, candidate),
  };
  if (boundarySource) {
    updates.boundary_source = boundarySource;
    updates.alignment_confidence = alignmentConfidence(updates.similarity, updates.coverage);
  }
  Object.assign(item, updates);
}

function commonPrefixLength(left, right) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function unavailableAlignmentRange(index, phrase, normalizedTarget) {
  return {
    index,
    source_index: phrase.source_index,
    target: phrase.target,
    normalized_target: normalizedTarget,
    available: false,
    matched: false,
    content_matched: null,
    source: "none",
    similarity: 0,
    content_similarity: 0,
    coverage: 0,
    recognized_start: null,
    recognized_end: null,
    normalized_recognized: "",
    matched_text: "",
    audio_start: null,
    audio_end: null,
    alignment_confidence: "unavailable",
    boundary_source: "none",
    token_start_index: null,
    token_end_index: null,
  };
}

function alignSinglePhraseToWordSpans(phrase, recognized, wordSpans, targetLanguage) {
  const normalizedTarget = String(phrase.normalized_target || "");
  const selectedSpans = trimEdgeFillerSpans(wordSpans, normalizedTarget, targetLanguage);
  if (!selectedSpans.length) {
    return unavailableAlignmentRange(0, phrase, normalizedTarget);
  }
  const start = selectedSpans[0].normalized_start;
  const end = selectedSpans[selectedSpans.length - 1].normalized_end;
  const startWord = wordSpans.indexOf(selectedSpans[0]);
  const endWord = wordSpans.indexOf(selectedSpans[selectedSpans.length - 1]) + 1;
  const selectedNormalized = recognized.slice(start, end);
  const similarity = practiceSimilarity(normalizedTarget, selectedNormalized);
  const coverage = targetCharacterCoverage(normalizedTarget, selectedNormalized);
  const [audioStart, audioEnd] = safeAlignmentAudioBounds(selectedSpans);
  if (audioStart === null || audioEnd === null || audioEnd <= audioStart) {
    return textOnlyAlignmentRange(
      0,
      phrase,
      normalizedTarget,
      selectedSpans,
      start,
      end,
      recognized,
      targetLanguage,
      startWord,
      endWord,
      similarity,
      coverage,
    );
  }
  const contentMatched = practiceContentMatches(
    phrase.target,
    joinMatchedWords(selectedSpans, targetLanguage),
    targetLanguage,
  );
  return {
    index: 0,
    source_index: phrase.source_index,
    target: phrase.target,
    normalized_target: normalizedTarget,
    available: true,
    matched: contentMatched,
    content_matched: contentMatched,
    source: "words",
    similarity: roundScore(similarity),
    content_similarity: roundScore(similarity),
    coverage: roundScore(coverage),
    recognized_start: start,
    recognized_end: end,
    normalized_recognized: selectedNormalized,
    matched_text: joinMatchedWords(selectedSpans, targetLanguage),
    audio_start: audioStart,
    audio_end: audioEnd,
    alignment_confidence: alignmentConfidence(similarity, coverage),
    boundary_source: "single_phrase",
    token_start_index: startWord,
    token_end_index: endWord,
  };
}

function trimEdgeFillerSpans(wordSpans, normalizedTarget, targetLanguage) {
  const selected = [...wordSpans];
  const fillers = PRACTICE_EDGE_FILLERS[targetLanguage] || new Set();
  while (selected.length) {
    const token = String(selected[0].normalized || "");
    if (!fillers.has(token) || normalizedTarget.startsWith(token)) {
      break;
    }
    selected.shift();
  }
  while (selected.length) {
    const token = String(selected[selected.length - 1].normalized || "");
    if (!fillers.has(token) || normalizedTarget.endsWith(token)) {
      break;
    }
    selected.pop();
  }
  return selected;
}

function joinMatchedWords(wordSpans, targetLanguage) {
  const words = wordSpans.map((span) => String(span.text || "")).filter(Boolean);
  if (targetLanguage === "ja-JP" || targetLanguage === "zh-CN") {
    return words.join("");
  }
  return words.join(" ");
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampValue(value) {
  if (value === null || value === undefined || value === "") {
    return { value: null, reason: "non_numeric" };
  }
  const number = Number(value);
  if (Number.isNaN(number)) return { value: null, reason: "non_numeric" };
  if (!Number.isFinite(number)) return { value: null, reason: "non_finite" };
  return { value: number, reason: null };
}

function timestampUnitValues(startValue, endValue) {
  const startResult = timestampValue(startValue);
  const endResult = timestampValue(endValue);
  if (startResult.reason || endResult.reason) {
    return {
      start: startResult.value,
      end: endResult.value,
      reason: [startResult.reason, endResult.reason].includes("non_numeric")
        ? "non_numeric"
        : "non_finite",
    };
  }
  if (startResult.value < 0) {
    return { start: startResult.value, end: endResult.value, reason: "negative_start" };
  }
  if (endResult.value < startResult.value) {
    return { start: startResult.value, end: endResult.value, reason: "end_before_start" };
  }
  return { start: startResult.value, end: endResult.value, reason: null };
}

function invalidTimestampUnit(source, sourceIndex, text, start, end, reason) {
  return {
    source,
    source_index: sourceIndex,
    text,
    start,
    end,
    reason,
  };
}

function roundScore(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function isHanCharacter(char) {
  const codePoint = String(char || "").codePointAt(0);
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
    (codePoint >= 0x20000 && codePoint <= 0x2A6DF) ||
    (codePoint >= 0x2A700 && codePoint <= 0x2B73F) ||
    (codePoint >= 0x2B740 && codePoint <= 0x2B81F) ||
    (codePoint >= 0x2B820 && codePoint <= 0x2CEAF)
  );
}

function normalizePracticeText(text, targetLanguage) {
  let normalized = String(text || "").normalize("NFKC").trim().toLowerCase();
  if (targetLanguage === "ja-JP") {
    normalized = normalized.replace(/[\u30a1-\u30f6]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    );
  }
  if (targetLanguage === "zh-CN") {
    normalized = normalizeChineseSpokenForms(normalized);
    normalized = normalizeChineseVariants(normalized);
  }
  return Array.from(normalized)
    .filter((char) => !/[\p{P}\p{Z}\p{S}]/u.test(char))
    .join("");
}

function normalizeChineseVariants(text) {
  return traditionalChineseToSimplified(String(text || ""));
}

function canonicalPracticeText(text, targetLanguage) {
  return targetLanguage === "zh-CN"
    ? normalizeChineseVariants(text)
    : String(text || "");
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
  const commonLength = sequenceMatcherMatchingLength(normalizedTarget, normalizedRecognized);
  const sequenceScore = (2 * commonLength) / (normalizedTarget.length + normalizedRecognized.length);
  const containmentScore =
    normalizedTarget.includes(normalizedRecognized) || normalizedRecognized.includes(normalizedTarget)
      ? Math.min(normalizedTarget.length, normalizedRecognized.length) /
        Math.max(normalizedTarget.length, normalizedRecognized.length)
      : 0;
  return Math.max(0, Math.min(1, Math.max(sequenceScore, containmentScore)));
}

function sequenceMatcherMatchingLength(left, right) {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const rightIndexes = new Map();
  for (const [index, character] of rightChars.entries()) {
    const indexes = rightIndexes.get(character) || [];
    indexes.push(index);
    rightIndexes.set(character, indexes);
  }

  function findLongestMatch(leftStart, leftEnd, rightStart, rightEnd) {
    let bestLeft = leftStart;
    let bestRight = rightStart;
    let bestSize = 0;
    let previousLengths = new Map();
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const currentLengths = new Map();
      for (const rightIndex of rightIndexes.get(leftChars[leftIndex]) || []) {
        if (rightIndex < rightStart) {
          continue;
        }
        if (rightIndex >= rightEnd) {
          break;
        }
        const size = (previousLengths.get(rightIndex - 1) || 0) + 1;
        currentLengths.set(rightIndex, size);
        if (size > bestSize) {
          bestLeft = leftIndex - size + 1;
          bestRight = rightIndex - size + 1;
          bestSize = size;
        }
      }
      previousLengths = currentLengths;
    }
    return { left: bestLeft, right: bestRight, size: bestSize };
  }

  const queue = [[0, leftChars.length, 0, rightChars.length]];
  const matches = [];
  while (queue.length) {
    const [leftStart, leftEnd, rightStart, rightEnd] = queue.pop();
    const match = findLongestMatch(leftStart, leftEnd, rightStart, rightEnd);
    if (!match.size) {
      continue;
    }
    matches.push(match);
    if (leftStart < match.left && rightStart < match.right) {
      queue.push([leftStart, match.left, rightStart, match.right]);
    }
    const matchLeftEnd = match.left + match.size;
    const matchRightEnd = match.right + match.size;
    if (matchLeftEnd < leftEnd && matchRightEnd < rightEnd) {
      queue.push([matchLeftEnd, leftEnd, matchRightEnd, rightEnd]);
    }
  }
  return matches.reduce((total, match) => total + match.size, 0);
}

function practiceGrade(similarity) {
  if (similarity >= 0.995) {
    return "perfect";
  }
  if (similarity >= 0.95) {
    return "ok";
  }
  if (similarity >= 0.9) {
    return "almost";
  }
  return "retry";
}

function longestCommonSubsequenceLength(left, right) {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  if (!leftChars.length || !rightChars.length) {
    return 0;
  }
  let previous = new Array(rightChars.length + 1).fill(0);
  let current = new Array(rightChars.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      current[rightIndex] =
        leftChars[leftIndex - 1] === rightChars[rightIndex - 1]
          ? previous[rightIndex - 1] + 1
          : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[rightChars.length];
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
