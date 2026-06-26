const userRecordButton = document.querySelector("#user-record-button");
const userLanguageLabel = document.querySelector("#user-language-label");
const displayModeButton = document.querySelector("#display-mode-button");
const speakHeading = document.querySelector("#speak-heading");
const userStatus = document.querySelector("#user-status");
const userMinimumHint = document.querySelector("#user-minimum-hint");
const recordTimer = document.querySelector("#record-timer");
const userOutputAudio = document.querySelector("#user-output-audio");
const userReplayButton = document.querySelector("#user-replay-button");
const userReplayLabel = document.querySelector("#user-replay-label");
const userProcessingPanel = document.querySelector("#user-processing-panel");
const userProcessingFill = document.querySelector("#user-processing-fill");
const userOutputTexts = document.querySelector("#user-output-texts");
const userOutputTextCard = document.querySelector("#user-output-text-card");
const userOutputTextMode = document.querySelector("#user-output-text-mode");
const userOutputText = document.querySelector("#user-output-text");
const userError = document.querySelector("#user-error");
const userTargetLanguage = document.querySelector("#target_language");
const similarVoiceToggle = document.querySelector("#similar_voice");
const similarVoiceLabel = document.querySelector("#similar-voice-label");
const jokeModeToggle = document.querySelector("#joke_mode");
const jokeModeLabel = document.querySelector("#joke-mode-label");
const osakaDialectToggle = document.querySelector("#osaka_dialect");
const osakaDialectLabel = document.querySelector("#osaka-dialect-label");
const variationModeToggle = document.querySelector("#variation_mode");
const variationModeLabel = document.querySelector("#variation-mode-label");

const minimumRecordingMs = 5000;
let userMediaRecorder = null;
let userRecordingStream = null;
let userRecordingChunks = [];
let userRecordingStartedAt = 0;
let recordTimerId = null;
let processingTimerId = null;
let currentUserOutputUrl = "";
let lastUserInputBlob = null;
let lastUserInputFileName = "";
let lastTranslationSignature = "";
let lastTranslationResult = null;
let lastBaseTextSignature = "";
let lastBaseResult = null;
let lastBaseAudioBlob = null;
let lastVoiceSignature = "";
let lastVoiceResult = null;
const translationResultCache = new Map();
const baseResultCache = new Map();
const voiceResultCache = new Map();
const displayTextCache = new Map();
const jokeAudioCache = new Map();
let lastAppliedUserRequestSignature = "";
let hasUserOutput = false;
let isUserProcessing = false;
let userDisplayText = {
  kanji_text: "",
  hiragana_text: "",
};
let userTextMode = "hiragana";
let currentStatusKey = "tap_to_speak";
let currentPlaybackQueue = [];
let currentPlaybackIndex = -1;
let userSeedVcAvailable = true;
let userSeedVcUnavailableReason = "";
let userInputCacheVersion = 0;
let processingDotCount = 0;
let userTextEffectsAvailable = false;
let userSettings = {
  target_language: "ja-JP",
  joke_text: "",
  joke_position: "after",
  theme: "blue",
};
const userAutoTargetLanguage = "user-auto";
const userJokeTargetLanguage = "id-ID";
const userJokeTtsBackend = "openai";
const userJokeAudioStoragePrefix = "mo:user-joke-audio:";

const userUiTexts = {
  app_title: {
    hiragana: "へんな へんかん アプリ",
    kanji: "変な変換アプリ",
    ruby: "<ruby>変<rt>へん</rt></ruby>な<ruby>変換<rt>へんかん</rt></ruby>アプリ",
  },
  speak_heading: {
    hiragana: "はなしてください",
    kanji: "話してください",
    ruby: "<ruby>話<rt>はな</rt></ruby>してください",
  },
  display_mode: {
    hiragana: "ひらがな",
    kanji: "漢字",
    ruby: "ルビ",
  },
  similar_voice: {
    hiragana: "にてるこえ",
    kanji: "似てる声",
    ruby: "<ruby>似<rt>に</rt></ruby>てる<ruby>声<rt>こえ</rt></ruby>",
  },
  joke: {
    hiragana: "ジョーク",
    kanji: "ジョーク",
    ruby: "ジョーク",
  },
  osaka: {
    hiragana: "おおさかべん",
    kanji: "大阪弁",
    ruby: "<ruby>大阪弁<rt>おおさかべん</rt></ruby>",
  },
  variation: {
    hiragana: "バリエーション",
    kanji: "バリエーション",
    ruby: "バリエーション",
  },
  tap_to_speak: {
    hiragana: "おして はなす",
    kanji: "押して話す",
    ruby: "<ruby>押<rt>お</rt></ruby>して<ruby>話<rt>はな</rt></ruby>す",
  },
  speak_five_seconds: {
    hiragana: "5びょう いじょう はなしてください",
    kanji: "5秒以上話してください",
    ruby: "5<ruby>秒<rt>びょう</rt></ruby><ruby>以上<rt>いじょう</rt></ruby><ruby>話<rt>はな</rt></ruby>してください",
  },
  keep_speaking: {
    hiragana: "もうすこし はなしてください",
    kanji: "もう少し話してください",
    ruby: "もう<ruby>少<rt>すこ</rt></ruby>し<ruby>話<rt>はな</rt></ruby>してください",
  },
  recording: {
    hiragana: "ろくおんちゅう",
    kanji: "録音中",
    ruby: "<ruby>録音中<rt>ろくおんちゅう</rt></ruby>",
  },
  tap_to_stop: {
    hiragana: "おすと とまる",
    kanji: "押すと止まる",
    ruby: "<ruby>押<rt>お</rt></ruby>すと<ruby>止<rt>と</rt></ruby>まる",
  },
  processing: {
    hiragana: "しょりちゅう",
    kanji: "処理中",
    ruby: "<ruby>処理中<rt>しょりちゅう</rt></ruby>",
  },
  done: {
    hiragana: "できました",
    kanji: "できました",
    ruby: "できました",
  },
  retry: {
    hiragana: "もういちど",
    kanji: "もう一度",
    ruby: "もう<ruby>一度<rt>いちど</rt></ruby>",
  },
  stop: {
    hiragana: "とめる",
    kanji: "止める",
    ruby: "<ruby>止<rt>と</rt></ruby>める",
  },
  rebuild: {
    hiragana: "つくりなおす",
    kanji: "作り直す",
    ruby: "<ruby>作<rt>つく</rt></ruby>り<ruby>直<rt>なお</rt></ruby>す",
  },
};

userRecordButton.addEventListener("click", handleUserRecordButton);
userReplayButton.addEventListener("click", toggleUserReplay);
displayModeButton.addEventListener("click", cycleUserTextMode);
userOutputAudio.addEventListener("ended", handleUserAudioEnded);
userOutputAudio.addEventListener("pause", syncReplayButton);
userOutputAudio.addEventListener("play", syncReplayButton);
[similarVoiceToggle, jokeModeToggle, osakaDialectToggle, variationModeToggle].forEach((toggle) => {
  toggle.addEventListener("change", markUserOutputStale);
});
refreshUserSettings();
loadUserRuntime();
renderStaticUserTexts();
syncJapaneseTextEffectAvailability("");

async function handleUserRecordButton() {
  clearUserError();
  if (userMediaRecorder && userMediaRecorder.state === "recording") {
    const elapsedMs = performance.now() - userRecordingStartedAt;
    if (elapsedMs < minimumRecordingMs) {
      setUserStatus("keep_speaking");
      userMinimumHint.hidden = false;
      nudgeRecordButton();
      return;
    }
    setUserStatus("processing");
    userRecordButton.classList.remove("is-recording", "is-ready-to-stop");
    userRecordButton.classList.add("is-processing");
    userMediaRecorder.stop();
    return;
  }
  await startUserRecording();
}

async function startUserRecording() {
  await refreshUserSettings();
  await loadUserRuntime();
  userOutputAudio.hidden = true;
  userReplayButton.hidden = true;
  userOutputTexts.hidden = true;
  hideUserProcessing();
  resetUserOutputCache();
  userOutputAudio.removeAttribute("src");
  if (currentUserOutputUrl) {
    URL.revokeObjectURL(currentUserOutputUrl);
    currentUserOutputUrl = "";
  }
  userRecordingChunks = [];
  try {
    userRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    userMediaRecorder = new MediaRecorder(userRecordingStream, chooseUserRecorderOptions());
    userMediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        userRecordingChunks.push(event.data);
      }
    });
    userMediaRecorder.addEventListener("stop", submitUserTranslation);
    userRecordingStartedAt = performance.now();
    userMediaRecorder.start();
    userRecordButton.classList.add("is-recording", "is-locked");
    userRecordButton.style.setProperty("--record-progress", "0deg");
    userRecordButton.setAttribute("aria-label", "ろくおんちゅう");
    renderUserText(userMinimumHint, "speak_five_seconds");
    userMinimumHint.hidden = false;
    setUserStatus("speak_five_seconds");
    startRecordTimer();
  } catch (error) {
    renderUserError(error.message || "マイクが つかえません");
  }
}

async function submitUserTranslation() {
  stopUserRecordingStream();
  stopRecordTimer();
  userRecordButton.classList.remove("is-recording", "is-locked", "is-ready-to-stop");
  userRecordButton.classList.add("is-processing");
  userRecordButton.disabled = true;
  userMinimumHint.hidden = true;
  setUserStatus("processing");

  try {
    await refreshUserSettings();
    const audioBlob = new Blob(userRecordingChunks, { type: userMediaRecorder?.mimeType || "audio/webm" });
    if (audioBlob.size < 1) {
      throw new Error("ろくおんが ありません");
    }
    lastUserInputBlob = audioBlob;
    lastUserInputFileName = "user-recording.webm";
    userInputCacheVersion += 1;
    await runUserTranslation(audioBlob, lastUserInputFileName);
    setUserStatus("done");
  } catch (error) {
    renderUserError(error.message || "エラー");
  } finally {
    userRecordingChunks = [];
    userRecordButton.disabled = false;
    userRecordButton.classList.remove("is-processing");
    userRecordButton.setAttribute("aria-label", "ろくおん");
  }
}

async function runUserTranslation(audioBlob, fileName) {
  isUserProcessing = true;
  hasUserOutput = false;
  userReplayButton.hidden = true;
  setUserProcessingProgress(4);
  const translationSignature = currentUserTranslationSignature();
  const baseTextSignature = currentUserBaseTextSignature();
  const formData = buildUserTranslationFormData(audioBlob, fileName);

  const response = await fetch("/api/translate-speech-jobs", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "へんかんできませんでした");
  }

  const job = await response.json();
  renderUserJob(job);
  const completedJob = await pollUserTranslationJob(job.job_id);
  if (!completedJob.result) {
    throw new Error("できたこえが ありません");
  }
  setCachedTranslationResult(translationSignature, completedJob.result);
  setCachedBaseResult(baseTextSignature, completedJob.result);
  await applyUserVoiceModeToBase();
  setUserProcessingProgress(100);
  hideUserProcessing();
}

function buildUserTranslationFormData(audioBlob, fileName) {
  const formData = new FormData();
  formData.append("translation_backend", "openai");
  formData.append("source_language", "auto");
  formData.append("target_language", userTargetLanguage.value || "ja-JP");
  formData.append("voice_mode", "default");

  const textTransformOptions = userTextTransformOptions();
  if (Object.keys(textTransformOptions).length > 0) {
    formData.append("text_transform", "user_effects");
    formData.append("text_transform_options", JSON.stringify(textTransformOptions));
  }
  formData.append("audio", audioBlob, fileName);
  return formData;
}

async function runUserTextOutput() {
  if (!lastTranslationResult) {
    throw new Error("もとの ほんやくが ありません");
  }
  isUserProcessing = true;
  hasUserOutput = false;
  userReplayButton.hidden = true;
  setUserProcessingProgress(54);
  const baseTextSignature = currentUserBaseTextSignature();
  const response = await fetch("/api/user-text-output", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: lastTranslationResult.transcript || "",
      translated_text: lastTranslationResult.translated_text || "",
      target_language: resolvedUserTargetLanguage(),
      text_transform_options: userTextTransformOptions(),
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "こえを つくれませんでした");
  }
  const result = await response.json();
  setCachedBaseResult(baseTextSignature, result);
  await applyUserVoiceModeToBase();
  setUserProcessingProgress(100);
  hideUserProcessing();
}

async function applyUserVoiceModeToBase() {
  if (!lastBaseResult || !lastBaseAudioBlob) {
    throw new Error("もとの こえが ありません");
  }
  const requestSignature = currentUserRequestSignature();
  const voiceSignature = currentUserVoiceSignature();
  if (!similarVoiceToggle.checked || !userSeedVcAvailable) {
    await renderUserResult(lastBaseResult);
    lastAppliedUserRequestSignature = requestSignature;
    hasUserOutput = true;
    return;
  }
  const cachedVoiceResult = voiceResultCache.get(voiceSignature);
  if (cachedVoiceResult) {
    setCachedVoiceResult(voiceSignature, cachedVoiceResult);
    await renderUserResult(cachedVoiceResult);
    lastAppliedUserRequestSignature = requestSignature;
    hasUserOutput = true;
    return;
  }
  let voiceResult;
  try {
    voiceResult = await runUserVoiceConversion(lastBaseAudioBlob);
  } catch (error) {
    if (!isVoiceBackendUnavailableError(error)) {
      throw error;
    }
    syncSimilarVoiceAvailability({ available: false, reason: error.message || "" });
    await renderUserResult(lastBaseResult);
    lastAppliedUserRequestSignature = currentUserRequestSignature();
    hasUserOutput = true;
    return;
  }
  const mergedVoiceResult = {
    ...lastBaseResult,
    audio_mime_type: voiceResult.audio_mime_type,
    audio_base64: voiceResult.audio_base64,
    timings_ms: {
      ...(lastBaseResult.timings_ms || {}),
      ...(voiceResult.timings_ms || {}),
    },
    providers: {
      ...(lastBaseResult.providers || {}),
      ...(voiceResult.providers || {}),
    },
    warnings: [...(lastBaseResult.warnings || []), ...(voiceResult.warnings || [])],
  };
  setCachedVoiceResult(voiceSignature, mergedVoiceResult);
  await renderUserResult(lastVoiceResult);
  lastAppliedUserRequestSignature = requestSignature;
  hasUserOutput = true;
}

async function runUserVoiceConversion(baseAudioBlob, sourceStem = "user-base-output") {
  if (!lastUserInputBlob) {
    throw new Error("もとの ろくおんが ありません");
  }
  setUserProcessingProgress(84);
  const formData = new FormData();
  formData.append("voice_backend", "seed-vc");
  formData.append("seed_vc_diffusion_steps", "30");
  formData.append("seed_vc_reference_max_seconds", "10");
  formData.append("seed_vc_reference_auto_select", "true");
  formData.append("seed_vc_length_adjust", "1.0");
  formData.append("seed_vc_inference_cfg_rate", "0.7");
  formData.append("source_audio", baseAudioBlob, userAudioFileNameForMime(baseAudioBlob.type, sourceStem));
  formData.append("reference_audio", lastUserInputBlob, lastUserInputFileName || "user-recording.webm");

  const response = await fetch("/api/voice-conversion-jobs", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "にてるこえを つくれませんでした");
  }
  const job = await response.json();
  renderUserVoiceJob(job);
  const completedJob = await pollUserVoiceConversionJob(job.job_id);
  if (!completedJob.result) {
    throw new Error("にてるこえが ありません");
  }
  return completedJob.result;
}

function userTextTransformOptions() {
  const options = {};
  if (!userTextEffectsAvailable) {
    return options;
  }
  if (osakaDialectToggle.checked) {
    options.osaka_dialect = true;
  }
  if (variationModeToggle.checked) {
    options.variation = true;
  }
  return options;
}

function currentUserRequestSignature() {
  const hasJoke = jokeModeToggle.checked && Boolean(userSettings.joke_text);
  return JSON.stringify({
    voice: currentUserVoiceSignature(),
    joke_mode: hasJoke,
    joke_text: hasJoke ? userSettings.joke_text || "" : "",
    joke_position: hasJoke ? userSettings.joke_position || "after" : "",
  });
}

function currentUserVoiceSignature() {
  return JSON.stringify({
    base_text: currentUserBaseTextSignature(),
    similar_voice: similarVoiceToggle.checked,
  });
}

function currentUserTranslationSignature() {
  return JSON.stringify({
    target_language: userTargetLanguage.value || userAutoTargetLanguage,
  });
}

function currentUserBaseTextSignature() {
  return JSON.stringify({
    translation: currentUserTranslationSignature(),
    text_transform_options: userTextTransformOptions(),
  });
}

function currentUserDisplayTextSignature(text, targetLanguage) {
  return JSON.stringify({
    target_language: targetLanguage,
    text,
  });
}

async function pollUserTranslationJob(jobId) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const response = await fetch(`/api/translate-speech-jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new Error("じょうたいを よめませんでした");
    }
    const job = await response.json();
    renderUserJob(job);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "へんかんできませんでした");
    }
  }
}

async function pollUserVoiceConversionJob(jobId) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const response = await fetch(`/api/voice-conversion-jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new Error("じょうたいを よめませんでした");
    }
    const job = await response.json();
    renderUserVoiceJob(job);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "にてるこえを つくれませんでした");
    }
  }
}

function renderUserJob(job) {
  const stage = job.current_stage?.stage || "";
  setUserStatus("processing");
  if (job.status === "queued") {
    setUserProcessingProgress(8);
  } else if (stage === "asr") {
    setUserProcessingProgress(25);
  } else if (stage === "translation" || stage === "text_transform") {
    setUserProcessingProgress(stage === "translation" ? 48 : 62);
  } else if (stage === "tts") {
    setUserProcessingProgress(78);
  } else if (stage === "voice_conversion") {
    setUserProcessingProgress(92);
  } else if (stage === "complete") {
    setUserProcessingProgress(100);
  } else if (job.status === "running") {
    setUserProcessingProgress(16);
  }
}

function renderUserVoiceJob(job) {
  setUserStatus("processing");
  if (job.status === "queued") {
    setUserProcessingProgress(84);
  } else if (job.current_stage?.stage === "voice_conversion" || job.status === "running") {
    setUserProcessingProgress(92);
  } else if (job.current_stage?.stage === "complete") {
    setUserProcessingProgress(100);
  }
}

async function renderUserResult(result) {
  await renderUserTexts(result);
  await renderUserOutput(result);
}

async function renderUserTexts(result) {
  const text = (result.transformed_text || result.translated_text || "").trim();
  if (!text) {
    userOutputTexts.hidden = true;
    return;
  }
  userOutputTexts.hidden = false;
  userDisplayText = {
    kanji_text: text,
    hiragana_text: "よみこみちゅう",
  };
  renderUserTextMode();
  const targetLanguage = result.target_language || resolvedUserTargetLanguage();
  const displayTextSignature = currentUserDisplayTextSignature(text, targetLanguage);
  const cachedDisplayText = displayTextCache.get(displayTextSignature);
  if (cachedDisplayText) {
    userDisplayText = cachedDisplayText;
    renderUserTextMode();
    return;
  }
  try {
    const displayText = await loadUserDisplayText(text, targetLanguage);
    userDisplayText = {
      kanji_text: displayText.kanji_text || text,
      hiragana_text: displayText.hiragana_text || text,
    };
    displayTextCache.set(displayTextSignature, userDisplayText);
    renderUserTextMode();
  } catch (_error) {
    userDisplayText = {
      kanji_text: text,
      hiragana_text: text,
    };
    displayTextCache.set(displayTextSignature, userDisplayText);
    renderUserTextMode();
  }
}

async function renderUserOutput(result) {
  const audioBlob = audioBlobFromResult(result);
  if (currentUserOutputUrl) {
    URL.revokeObjectURL(currentUserOutputUrl);
  }
  currentUserOutputUrl = URL.createObjectURL(audioBlob);
  currentPlaybackQueue = await buildUserPlaybackQueue(currentUserOutputUrl);
  userOutputAudio.src = currentPlaybackQueue[0] || currentUserOutputUrl;
  userOutputAudio.hidden = true;
  userReplayButton.hidden = false;
  playUserOutputQueue().catch(() => {});
  syncReplayButton();
}

async function buildUserPlaybackQueue(mainOutputUrl) {
  if (!jokeModeToggle.checked || !userSettings.joke_text) {
    return [mainOutputUrl];
  }
  const jokeUrl = await getUserJokeAudioUrl(userSettings.joke_text);
  if ((userSettings.joke_position || "after") === "before") {
    return [jokeUrl, mainOutputUrl];
  }
  return [mainOutputUrl, jokeUrl];
}

async function getUserJokeAudioUrl(jokeText) {
  const baseJokeAudio = await getUserJokeBaseAudio(jokeText);
  if (!similarVoiceToggle.checked || !userSeedVcAvailable || !lastUserInputBlob) {
    return baseJokeAudio.url;
  }
  try {
    return await getVoiceConvertedUserJokeAudioUrl(jokeText, baseJokeAudio.blob);
  } catch (error) {
    if (!isVoiceBackendUnavailableError(error)) {
      throw error;
    }
    syncSimilarVoiceAvailability({ available: false, reason: error.message || "" });
    return baseJokeAudio.url;
  }
}

async function getUserJokeBaseAudio(jokeText) {
  const cacheKey = JSON.stringify({
    kind: "base",
    text: jokeText,
    target_language: userJokeTargetLanguage,
    tts_backend: userJokeTtsBackend,
  });
  const cached = jokeAudioCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const stored = loadStoredUserJokeAudio(cacheKey);
  if (stored) {
    const storedBlob = audioBlobFromResult(stored);
    const storedUrl = URL.createObjectURL(storedBlob);
    const cachedJoke = { url: storedUrl, blob: storedBlob };
    jokeAudioCache.set(cacheKey, cachedJoke);
    return cachedJoke;
  }
  const response = await fetch("/api/user-joke-output", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: jokeText,
      target_language: userJokeTargetLanguage,
      tts_backend: userJokeTtsBackend,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "ジョークを つくれませんでした");
  }
  const result = await response.json();
  const jokeBlob = audioBlobFromResult(result);
  const url = URL.createObjectURL(jokeBlob);
  const cachedJoke = { url, blob: jokeBlob };
  jokeAudioCache.set(cacheKey, cachedJoke);
  saveStoredUserJokeAudio(cacheKey, result);
  return cachedJoke;
}

async function getVoiceConvertedUserJokeAudioUrl(jokeText, jokeBlob) {
  const cacheKey = JSON.stringify({
    kind: "voice",
    text: jokeText,
    target_language: userJokeTargetLanguage,
    tts_backend: userJokeTtsBackend,
    reference_recording: userInputCacheVersion,
  });
  const cached = jokeAudioCache.get(cacheKey);
  if (cached) {
    return cached.url;
  }
  const voiceResult = await convertUserJokeAudioBlob(jokeBlob);
  const convertedBlob = audioBlobFromResult(voiceResult);
  const url = URL.createObjectURL(convertedBlob);
  jokeAudioCache.set(cacheKey, { url, blob: convertedBlob, result: voiceResult });
  return url;
}

async function convertUserJokeAudioBlob(jokeBlob) {
  return runUserVoiceConversion(jokeBlob, "user-joke-output");
}

function audioBlobFromResult(result) {
  const mimeType = result.audio_mime_type || "audio/wav";
  const binary = atob(result.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function resolvedUserTargetLanguage() {
  return lastTranslationResult?.target_language || userTargetLanguage.value || "ja-JP";
}

function loadStoredUserJokeAudio(cacheKey) {
  try {
    const stored = window.localStorage.getItem(`${userJokeAudioStoragePrefix}${cacheKey}`);
    if (!stored) {
      return null;
    }
    const payload = JSON.parse(stored);
    if (!payload.audio_base64 || !payload.audio_mime_type) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function saveStoredUserJokeAudio(cacheKey, result) {
  try {
    window.localStorage.setItem(
      `${userJokeAudioStoragePrefix}${cacheKey}`,
      JSON.stringify({
        audio_base64: result.audio_base64,
        audio_mime_type: result.audio_mime_type || "audio/wav",
      }),
    );
  } catch (_error) {
    return;
  }
}

async function refreshUserSettings() {
  try {
    const response = await fetch("/api/user-settings", { cache: "no-store" });
    if (!response.ok) {
      return userSettings;
    }
    userSettings = await response.json();
    userTargetLanguage.value = userAutoTargetLanguage;
    applyUserTheme(userSettings.theme || "blue");
    renderUserLanguageLabel();
    syncReplayButton();
  } catch (_error) {
    userTargetLanguage.value = userAutoTargetLanguage;
    applyUserTheme("blue");
  }
  return userSettings;
}

async function loadUserDisplayText(text, targetLanguage) {
  const response = await fetch("/api/user-display-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target_language: targetLanguage }),
  });
  if (!response.ok) {
    throw new Error("ひらがなを つくれませんでした");
  }
  return response.json();
}

async function loadUserRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) {
      return;
    }
    const runtime = await response.json();
    const openai = (runtime.translation_backends || []).find((backend) => backend.id === "openai");
    if (openai && openai.available === false) {
      setUserStatus("APIキーが ひつようです");
    }
    const seedVc = (runtime.voice_conversion_backends || []).find((backend) => backend.id === "seed-vc");
    syncSimilarVoiceAvailability(seedVc);
  } catch (_error) {
    return;
  }
}

function syncSimilarVoiceAvailability(seedVcBackend) {
  userSeedVcAvailable = Boolean(seedVcBackend?.available);
  userSeedVcUnavailableReason = userSeedVcAvailable ? "" : seedVcBackend?.reason || "Seed-VCが使えません";
  const similarVoiceTile = similarVoiceToggle.closest(".toggle-tile");
  similarVoiceToggle.disabled = !userSeedVcAvailable;
  similarVoiceTile?.classList.toggle("is-disabled", !userSeedVcAvailable);
  if (userSeedVcAvailable) {
    similarVoiceTile?.removeAttribute("title");
  } else if (userSeedVcUnavailableReason) {
    similarVoiceTile?.setAttribute("title", userSeedVcUnavailableReason);
  }
  if (!userSeedVcAvailable) {
    similarVoiceToggle.checked = false;
  }
  syncReplayButton();
}

function syncJapaneseTextEffectAvailability(targetLanguage) {
  userTextEffectsAvailable = targetLanguage === "ja-JP";
  [osakaDialectToggle, variationModeToggle].forEach((toggle) => {
    const tile = toggle.closest(".toggle-tile");
    toggle.disabled = !userTextEffectsAvailable;
    tile?.classList.toggle("is-disabled", !userTextEffectsAvailable);
    if (userTextEffectsAvailable) {
      tile?.removeAttribute("title");
    } else {
      tile?.setAttribute("title", "日本語出力のときだけ使えます");
      toggle.checked = false;
    }
  });
  if (hasUserOutput) {
    syncReplayButton();
  }
}

function applyUserTheme(theme) {
  const supportedThemes = new Set(["blue", "pop", "mint"]);
  document.body.dataset.theme = supportedThemes.has(theme) ? theme : "blue";
}

function isVoiceBackendUnavailableError(error) {
  const message = String(error?.message || error || "");
  return message.includes("voice backend is not available") || message.includes("seed_vc をimportできません");
}

function chooseUserRecorderOptions() {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return { mimeType: "audio/webm;codecs=opus" };
  }
  if (MediaRecorder.isTypeSupported("audio/webm")) {
    return { mimeType: "audio/webm" };
  }
  return {};
}

function stopUserRecordingStream() {
  if (userRecordingStream) {
    userRecordingStream.getTracks().forEach((track) => track.stop());
  }
  userRecordingStream = null;
}

function startRecordTimer() {
  stopRecordTimer();
  updateRecordTimer();
  recordTimerId = window.setInterval(updateRecordTimer, 100);
}

function stopRecordTimer() {
  if (recordTimerId !== null) {
    window.clearInterval(recordTimerId);
  }
  recordTimerId = null;
  userRecordButton.style.setProperty("--record-progress", "0deg");
  recordTimer.textContent = "5";
}

function updateRecordTimer() {
  const elapsedMs = performance.now() - userRecordingStartedAt;
  const progress = Math.min(elapsedMs / minimumRecordingMs, 1);
  const remainingSeconds = Math.max(Math.ceil((minimumRecordingMs - elapsedMs) / 1000), 0);
  userRecordButton.style.setProperty("--record-progress", `${Math.round(progress * 360)}deg`);
  if (progress < 1) {
    userRecordButton.classList.add("is-locked");
    userRecordButton.classList.remove("is-ready-to-stop");
    recordTimer.textContent = String(remainingSeconds);
    return;
  }
  userRecordButton.classList.remove("is-locked");
  userRecordButton.classList.add("is-ready-to-stop");
  recordTimer.textContent = "OK";
  renderUserText(userMinimumHint, "tap_to_stop");
  setUserStatus("recording");
}

function nudgeRecordButton() {
  userRecordButton.classList.remove("is-nudged");
  window.requestAnimationFrame(() => {
    userRecordButton.classList.add("is-nudged");
  });
}

async function toggleUserReplay() {
  if (currentPlaybackQueue.length === 0) {
    return;
  }
  await refreshUserSettings();
  if (lastUserInputBlob && hasUserOutput && currentUserRequestSignature() !== lastAppliedUserRequestSignature) {
    await reprocessLatestUserOutput();
    return;
  }
  if (isUserPlaybackActive()) {
    stopUserOutputQueue();
  } else {
    await playUserOutputQueue().catch(() => {});
  }
  syncReplayButton();
}

async function playUserOutputQueue() {
  if (currentPlaybackQueue.length === 0) {
    return;
  }
  currentPlaybackIndex = 0;
  userOutputAudio.src = currentPlaybackQueue[currentPlaybackIndex];
  await userOutputAudio.play();
  syncReplayButton();
}

function stopUserOutputQueue() {
  userOutputAudio.pause();
  currentPlaybackIndex = -1;
  if (currentPlaybackQueue.length > 0) {
    userOutputAudio.src = currentPlaybackQueue[0];
  }
  syncReplayButton();
}

function handleUserAudioEnded() {
  if (currentPlaybackIndex >= 0 && currentPlaybackIndex < currentPlaybackQueue.length - 1) {
    currentPlaybackIndex += 1;
    userOutputAudio.src = currentPlaybackQueue[currentPlaybackIndex];
    userOutputAudio.play().catch(() => {});
    syncReplayButton();
    return;
  }
  currentPlaybackIndex = -1;
  syncReplayButton();
}

async function reprocessLatestUserOutput() {
  clearUserError();
  userOutputAudio.pause();
  userReplayButton.disabled = true;
  userRecordButton.disabled = true;
  userRecordButton.classList.add("is-processing");
  setUserStatus("processing");
  isUserProcessing = true;
  setUserProcessingProgress(72);
  try {
    const translationSignature = currentUserTranslationSignature();
    const baseTextSignature = currentUserBaseTextSignature();
    const cachedTranslationResult = translationResultCache.get(translationSignature);
    const cachedBaseResult = baseResultCache.get(baseTextSignature);
    if (cachedTranslationResult && (!lastTranslationResult || translationSignature !== lastTranslationSignature)) {
      setCachedTranslationResult(translationSignature, cachedTranslationResult);
    }
    if (cachedBaseResult) {
      setCachedBaseResult(baseTextSignature, cachedBaseResult.result);
      await applyUserVoiceModeToBase();
      setUserProcessingProgress(100);
      hideUserProcessing();
    } else if (!lastTranslationResult || translationSignature !== lastTranslationSignature) {
      await runUserTranslation(lastUserInputBlob, lastUserInputFileName || "user-recording.webm");
    } else if (!lastBaseResult || baseTextSignature !== lastBaseTextSignature) {
      await runUserTextOutput();
    } else {
      isUserProcessing = true;
      setUserProcessingProgress(similarVoiceToggle.checked ? 84 : 100);
      await applyUserVoiceModeToBase();
      setUserProcessingProgress(100);
      hideUserProcessing();
    }
    setUserStatus("done");
  } catch (error) {
    renderUserError(error.message || "エラー");
  } finally {
    userReplayButton.disabled = false;
    userRecordButton.disabled = false;
    userRecordButton.classList.remove("is-processing");
    userRecordButton.setAttribute("aria-label", "ろくおん");
    syncReplayButton();
  }
}

function syncReplayButton() {
  if (hasUserOutput && lastAppliedUserRequestSignature !== "" && currentUserRequestSignature() !== lastAppliedUserRequestSignature) {
    userReplayButton.dataset.state = "stale";
    renderUserText(userReplayLabel, "rebuild");
    return;
  }
  const isPlaying = isUserPlaybackActive();
  userReplayButton.dataset.state = isPlaying ? "playing" : "paused";
  renderUserText(userReplayLabel, isPlaying ? "stop" : "retry");
}

function isUserPlaybackActive() {
  return currentPlaybackIndex >= 0 && !userOutputAudio.paused && !userOutputAudio.ended;
}

function markUserOutputStale() {
  if (hasUserOutput) {
    syncReplayButton();
  }
}

function setCachedTranslationResult(signature, result) {
  lastTranslationSignature = signature;
  lastTranslationResult = result;
  translationResultCache.set(signature, result);
}

function setCachedBaseResult(signature, result) {
  lastBaseTextSignature = signature;
  lastBaseResult = result;
  lastBaseAudioBlob = audioBlobFromResult(result);
  syncJapaneseTextEffectAvailability(result.target_language || resolvedUserTargetLanguage());
  baseResultCache.set(signature, {
    result,
    audioBlob: lastBaseAudioBlob,
  });
}

function setCachedVoiceResult(signature, result) {
  lastVoiceSignature = signature;
  lastVoiceResult = result;
  voiceResultCache.set(signature, result);
}

function resetUserOutputCache() {
  lastTranslationSignature = "";
  lastTranslationResult = null;
  lastBaseTextSignature = "";
  lastBaseResult = null;
  lastBaseAudioBlob = null;
  clearUserVoiceCache();
  translationResultCache.clear();
  baseResultCache.clear();
  voiceResultCache.clear();
  displayTextCache.clear();
  clearUserJokeMemoryCache();
  syncJapaneseTextEffectAvailability("");
  lastAppliedUserRequestSignature = "";
  hasUserOutput = false;
}

function clearUserJokeMemoryCache() {
  jokeAudioCache.forEach((cached) => {
    if (cached?.url) {
      URL.revokeObjectURL(cached.url);
    }
  });
  jokeAudioCache.clear();
}

function clearUserVoiceCache() {
  lastVoiceSignature = "";
  lastVoiceResult = null;
}

function renderUserTextMode() {
  userOutputTextMode.textContent = uiText("display_mode");
  userOutputText.classList.toggle("ruby-line", userTextMode === "ruby");
  if (userTextMode === "kanji") {
    userOutputText.textContent = userDisplayText.kanji_text;
  } else if (userTextMode === "ruby") {
    const kanji = escapeHtml(userDisplayText.kanji_text);
    const hiragana = escapeHtml(userDisplayText.hiragana_text || userDisplayText.kanji_text);
    userOutputText.innerHTML = `<ruby>${kanji}<rt>${hiragana}</rt></ruby>`;
  } else {
    userOutputText.textContent = userDisplayText.hiragana_text || userDisplayText.kanji_text;
  }
}

function setUserProcessingProgress(percent) {
  userProcessingPanel.hidden = false;
  startProcessingLabelAnimation();
  syncUserStatusVisibility();
  userProcessingFill.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
}

function hideUserProcessing() {
  userProcessingPanel.hidden = true;
  userProcessingFill.style.width = "0%";
  stopProcessingLabelAnimation();
  isUserProcessing = false;
}

function startProcessingLabelAnimation() {
  if (processingTimerId !== null) {
    return;
  }
  const updateLabel = () => {
    processingDotCount = (processingDotCount % 4) + 1;
    userStatus.innerHTML = buildProcessingLabelHtml(processingDotCount);
  };
  updateLabel();
  processingTimerId = window.setInterval(updateLabel, 450);
}

function stopProcessingLabelAnimation() {
  if (processingTimerId !== null) {
    window.clearInterval(processingTimerId);
  }
  processingTimerId = null;
  processingDotCount = 0;
}

function buildProcessingLabelHtml(dotCount) {
  const label = userTextMode === "ruby" ? uiText("processing", "ruby") : escapeHtml(uiText("processing", userTextMode));
  const dots = [1, 2, 3, 4]
    .map((index) => `<span class="processing-dot${index <= dotCount ? " is-visible" : ""}">.</span>`)
    .join("");
  return `${label}<span class="processing-dots" aria-hidden="true">${dots}</span>`;
}

function renderUserLanguageLabel() {
  renderUserText(userLanguageLabel, "app_title");
}

function setUserStatus(key) {
  currentStatusKey = key;
  if (key === "processing" && !userProcessingPanel.hidden) {
    userStatus.innerHTML = buildProcessingLabelHtml(processingDotCount || 1);
  } else {
    renderUserText(userStatus, key);
  }
  syncUserStatusVisibility();
}

function syncUserStatusVisibility() {
  userStatus.hidden = false;
}

function clearUserError() {
  userError.hidden = true;
  userError.textContent = "";
}

function renderUserError(message) {
  stopUserRecordingStream();
  stopRecordTimer();
  hideUserProcessing();
  userRecordButton.classList.remove("is-recording", "is-locked", "is-ready-to-stop", "is-processing");
  userRecordButton.disabled = false;
  userMinimumHint.hidden = true;
  renderUserText(userMinimumHint, "speak_five_seconds");
  userError.hidden = false;
  userError.textContent = message;
  setUserStatus("retry");
}

function cycleUserTextMode() {
  const modes = ["hiragana", "ruby", "kanji"];
  const nextIndex = (modes.indexOf(userTextMode) + 1) % modes.length;
  userTextMode = modes[nextIndex];
  renderStaticUserTexts();
  renderUserTextMode();
  syncReplayButton();
}

function renderStaticUserTexts() {
  displayModeButton.textContent = uiText("display_mode", userTextMode);
  renderUserText(userLanguageLabel, "app_title");
  renderUserText(speakHeading, "speak_heading");
  renderUserText(similarVoiceLabel, "similar_voice");
  renderUserText(jokeModeLabel, "joke");
  renderUserText(osakaDialectLabel, "osaka");
  renderUserText(variationModeLabel, "variation");
  renderUserText(
    userMinimumHint,
    userRecordButton.classList.contains("is-ready-to-stop") ? "tap_to_stop" : "speak_five_seconds",
  );
  if (currentStatusKey === "processing" && !userProcessingPanel.hidden) {
    userStatus.innerHTML = buildProcessingLabelHtml(processingDotCount || 1);
  } else {
    renderUserText(userStatus, currentStatusKey);
  }
}

function renderUserText(element, key) {
  if (userTextMode === "ruby") {
    element.innerHTML = uiText(key, "ruby");
  } else {
    element.textContent = uiText(key, userTextMode);
  }
}

function uiText(key, mode = userTextMode) {
  const variants = userUiTexts[key] || {};
  return variants[mode] || variants.hiragana || key;
}

function plainUserText(key) {
  return uiText(key, userTextMode).replace(/<[^>]*>/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function userAudioFileNameForMime(mimeType, stem) {
  const suffixes = {
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
  };
  return `${stem}${suffixes[mimeType] || ".wav"}`;
}
