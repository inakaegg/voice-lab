const targetLanguageButtons = Array.from(document.querySelectorAll(".practice-language-button"));
const nativePanel = document.querySelector(".practice-card-primary");
const nativeRecordButton = document.querySelector("#practice-native-record-button");
const recordTitle = document.querySelector("#practice-record-title");
const recordDescription = document.querySelector("#practice-record-description");
const nativeLevel = document.querySelector("#practice-native-level");
const nativeActionLabel = document.querySelector("#practice-native-action-label");
const promptPanel = document.querySelector("#practice-prompt-panel");
const resultPanel = document.querySelector("#practice-result-panel");
const targetLabel = document.querySelector("#practice-target-label");
const targetText = document.querySelector("#practice-target-text");
const targetSubtext = document.querySelector("#practice-target-subtext");
const modelAudio = document.querySelector("#practice-model-audio");
const playModelButton = document.querySelector("#practice-play-model-button");
const speedSlider = document.querySelector("#practice-speed-slider");
const speedValue = document.querySelector("#practice-speed-value");
const asrModelSelect = document.querySelector("#practice-asr-model");
const gradeBadge = document.querySelector("#practice-grade-badge");
const scoreText = document.querySelector("#practice-score");
const scoreFill = document.querySelector("#practice-score-fill");
const recognizedText = document.querySelector("#practice-recognized-text");
const progress = document.querySelector("#practice-progress");
const progressFill = document.querySelector("#practice-progress-fill");
const statusText = document.querySelector("#practice-status");
const errorText = document.querySelector("#practice-error");
const pinyinSetting = document.querySelector("#practice-pinyin-setting");
const pinyinToggle = document.querySelector("#practice-pinyin-toggle");
const nativeTranscriptPanel = document.querySelector("#practice-native-transcript-panel");
const nativeTranscriptLabel = document.querySelector("#practice-native-transcript-label");
const nativeTranscript = document.querySelector("#practice-native-transcript");
const recognizedLabel = document.querySelector("#practice-recognized-label");
const repeatAudio = document.querySelector("#practice-repeat-audio");

const languageLabels = {
  "ja-JP": "日本語",
  "zh-CN": "中文",
  "en-US": "English",
};
const practiceAsrModels = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
const hanCodePointRanges = [
  [0x3400, 0x4DBF],
  [0x4E00, 0x9FFF],
  [0x20000, 0x2A6DF],
  [0x2A700, 0x2B73F],
  [0x2B740, 0x2B81F],
  [0x2B820, 0x2CEAF],
];
const pinyinTrimCharacters = "，。！？；：、,.!?;:\"'“”‘’（）()[]【】《》<>";
const zhTraditionalToSimplified = {
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
const nativeUiLabels = {
  "ja-JP": {
    transcript: "言ったこと",
    recognized: "聞こえた言葉",
  },
  "zh-CN": {
    transcript: "你说的话",
    recognized: "识别结果",
  },
  "en-US": {
    transcript: "What you said",
    recognized: "Recognized",
  },
};
const practiceSettingsStorageKey = "mo:practice-settings";

let selectedTargetLanguage = "ja-JP";
let detectedNativeLanguage = "";
let mediaRecorder = null;
let recordingStream = null;
let recordingKind = "";
let recordingChunks = [];
let isBusy = false;
let modelAudioUrl = "";
let repeatAudioUrl = "";
let currentTargetText = "";
let currentTargetDisplayText = "";
let currentTargetSecondaryText = "";
let currentTargetPinyinText = "";
let currentTargetPinyinStatus = "disabled";
let currentRecognizedText = "";
let currentAttemptComparisonAlignment = null;
let currentAudioContext = null;
let currentAnalyser = null;
let currentLevelFrame = null;
let recordTimerId = null;
let recordingStartedAt = 0;
let processingKind = "";
let progressTimer = null;
let progressDisplayed = 0;
let progressTarget = 0;
let isComparisonPlaying = false;
let comparisonPlaybackToken = 0;

targetLanguageButtons.forEach((button) => {
  button.addEventListener("click", () => selectTargetLanguage(button.dataset.language || "ja-JP"));
});
nativeRecordButton.addEventListener("click", toggleActiveRecording);
playModelButton.addEventListener("click", toggleModelAudio);
speedSlider.addEventListener("input", handleSpeedChange);
asrModelSelect.addEventListener("change", savePracticeSettings);
pinyinToggle.addEventListener("change", handlePinyinSettingChange);
modelAudio.addEventListener("ended", syncPlayButton);
modelAudio.addEventListener("loadedmetadata", syncModelAudioSpeed);
modelAudio.addEventListener("pause", syncPlayButton);
modelAudio.addEventListener("play", handleModelAudioPlay);
repeatAudio.addEventListener("loadedmetadata", syncModelAudioSpeed);

function selectTargetLanguage(language) {
  if (isBusy || mediaRecorder) {
    return;
  }
  selectedTargetLanguage = languageLabels[language] ? language : "ja-JP";
  targetLanguageButtons.forEach((button) => {
    const selected = button.dataset.language === selectedTargetLanguage;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  });
  if (selectedTargetLanguage === "zh-CN") {
    pinyinToggle.checked = true;
  }
  syncPinyinSettingVisibility();
  savePracticeSettings();
  resetPractice();
}

async function toggleRecording(kind) {
  clearError();
  if (isBusy) {
    return;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") {
    if (recordingKind === kind) {
      mediaRecorder.stop();
    }
    return;
  }
  await startRecording(kind);
}

function toggleActiveRecording() {
  return toggleRecording("practice");
}

async function startRecording(kind) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showError("このブラウザでは録音を使えません。");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    showError(error instanceof Error ? error.message : "マイクを使えません。");
    return;
  }
  const mimeType = preferredRecordingMimeType();
  recordingStream = stream;
  recordingKind = kind;
  recordingChunks = [];
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      recordingChunks.push(event.data);
    }
  });
  mediaRecorder.addEventListener("stop", handleRecordingStopped, { once: true });
  mediaRecorder.start();
  startLevelMeter(stream, nativeLevel);
  setRecordingVisual(kind, true);
  setStatus(
    currentTargetText
      ? "まねして話すか、新しい内容を話してください。"
      : "言いたいことを話してください / Speak / 说",
  );
}

async function handleRecordingStopped() {
  const kind = recordingKind;
  const type = mediaRecorder?.mimeType || preferredRecordingMimeType() || "audio/webm";
  const blob = new Blob(recordingChunks, { type });
  cleanupRecording();
  setRecordingVisual(kind, false);
  processingKind = kind;
  if (!blob.size) {
    showError("録音できませんでした。");
    return;
  }
  await submitPracticeRecording(blob);
}

async function submitPracticeRecording(blob) {
  const hasTarget = Boolean(currentTargetText);
  setBusy(true, hasTarget ? "聞き取っています。" : "お手本を作っています。", hasTarget ? 88 : 72, "practice");
  if (!hasTarget) {
    promptPanel.hidden = true;
  }
  resultPanel.hidden = true;
  const form = new FormData();
  if (selectedTargetLanguage === "zh-CN") {
    pinyinToggle.checked = true;
  }
  form.append("target_language", selectedTargetLanguage);
  form.append("current_target_text", currentTargetText);
  form.append("include_pinyin", selectedTargetLanguage === "zh-CN" ? "true" : "false");
  form.append("asr_model", practiceAsrModel());
  form.append("audio", blob, `practice.${extensionForMimeType(blob.type)}`);
  const payload = await postPracticeForm("/api/practice/recordings", form);
  if (payload.recording_kind === "attempt") {
    setRepeatAudio(blob);
    renderAttemptResult(payload);
    setBusy(false, "何度でも練習できます。");
    return;
  }
  renderPromptResult(payload);
  setBusy(false, "お手本を聞いて、まねして話してください。");
}

function renderPromptResult(payload) {
  detectedNativeLanguage = normalizePracticeLanguage(payload.detected_source_language || "");
  renderNativeLabels();
  currentTargetText = payload.target_text || "";
  currentTargetDisplayText = payload.display_text?.primary_text || currentTargetText;
  targetLabel.textContent = `${languageLabels[payload.target_language] || ""} のお手本`;
  currentTargetSecondaryText = payload.display_text?.secondary_text || "";
  currentTargetPinyinText = payload.display_text?.pinyin_text || "";
  currentTargetPinyinStatus = payload.display_text?.pinyin_status || (currentTargetPinyinText ? "ready" : "unavailable");
  renderTargetDisplay();
  nativeTranscript.textContent = payload.transcript || "";
  nativeTranscriptPanel.hidden = !payload.transcript;
  setModelAudio(payload.audio_base64, payload.audio_mime_type || "audio/wav");
  nativePanel.hidden = false;
  promptPanel.hidden = false;
  stopRepeatAudio();
  currentRecognizedText = "";
  currentAttemptComparisonAlignment = null;
  recognizedText.textContent = "";
  syncPracticeRecordMode();
  syncModelAudioSpeed();
  syncPlayButton();
  ensureAudioMetadata(modelAudio)
    .then(() => {
      syncModelAudioSpeed();
      return modelAudio.play();
    })
    .catch(() => {});
}

async function postPracticeForm(url, form) {
  try {
    const response = await fetch(url, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `${url} failed: ${response.status}`);
    }
    return payload;
  } catch (error) {
    setBusy(false, "");
    showError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function renderAttemptResult(payload) {
  stopComparisonPlayback();
  const grade = payload.grade || "retry";
  gradeBadge.textContent = payload.grade_label || grade;
  gradeBadge.dataset.grade = grade;
  const percent = Math.round(Number(payload.similarity || 0) * 100);
  scoreText.textContent = `${percent}%`;
  scoreFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  currentRecognizedText = payload.recognized_text || "";
  currentAttemptComparisonAlignment = payload.comparison_alignment || null;
  renderRecognizedDiff(payload);
  nativePanel.hidden = false;
  resultPanel.hidden = false;
  syncPracticeRecordMode();
  syncPlayButton();
}

function resetPractice() {
  stopComparisonPlayback();
  stopModelAudio();
  currentTargetText = "";
  currentTargetDisplayText = "";
  currentTargetSecondaryText = "";
  currentTargetPinyinText = "";
  currentTargetPinyinStatus = "disabled";
  currentRecognizedText = "";
  currentAttemptComparisonAlignment = null;
  detectedNativeLanguage = "";
  nativePanel.hidden = false;
  promptPanel.hidden = true;
  resultPanel.hidden = true;
  nativeTranscriptPanel.hidden = true;
  nativeTranscript.textContent = "";
  recognizedText.textContent = "";
  stopRepeatAudio();
  renderNativeLabels();
  renderTargetDisplay();
  syncPracticeRecordMode();
  setStatus("言いたいことを話す / 说出想说的话 / Say what you want");
  clearError();
}

function setModelAudio(audioBase64, mimeType) {
  stopModelAudio();
  const blob = base64ToBlob(audioBase64, mimeType);
  modelAudioUrl = URL.createObjectURL(blob);
  modelAudio.src = modelAudioUrl;
  modelAudio.load();
  syncModelAudioSpeed();
}

function setRepeatAudio(blob) {
  stopComparisonPlayback();
  stopRepeatAudio();
  repeatAudioUrl = URL.createObjectURL(blob);
  repeatAudio.src = repeatAudioUrl;
  repeatAudio.load();
  syncModelAudioSpeed();
}

function toggleModelAudio() {
  if (isComparisonPlaying) {
    stopComparisonPlayback();
    return;
  }
  if (shouldUseComparisonPlayback()) {
    playComparisonAudios().catch((error) => showError(error.message));
    return;
  }
  if (!modelAudio.src) {
    return;
  }
  if (modelAudio.paused) {
    syncModelAudioSpeed();
    modelAudio.play().catch((error) => showError(error.message));
  } else {
    modelAudio.pause();
  }
}

function stopModelAudio() {
  stopComparisonPlayback();
  if (modelAudioUrl) {
    URL.revokeObjectURL(modelAudioUrl);
    modelAudioUrl = "";
  }
  modelAudio.pause();
  modelAudio.removeAttribute("src");
  modelAudio.load();
  syncPlayButton();
}

function stopRepeatAudio() {
  if (repeatAudioUrl) {
    URL.revokeObjectURL(repeatAudioUrl);
    repeatAudioUrl = "";
  }
  repeatAudio.pause();
  repeatAudio.removeAttribute("src");
  repeatAudio.load();
}

function syncPlayButton() {
  const isModelOnlyPlaying = !modelAudio.paused && !isComparisonPlaying;
  const isPlaying = isComparisonPlaying || isModelOnlyPlaying;
  playModelButton.classList.toggle("is-playing", isPlaying);
  playModelButton.querySelector("span:last-child").textContent = isPlaying
    ? "停止"
    : playbackButtonLabel();
}

function playbackButtonLabel() {
  if (!shouldUseComparisonPlayback()) {
    return "再生";
  }
  return canUsePhraseComparisonPlayback() ? "フレーズごと比較再生" : "全体比較再生";
}

function canUsePhraseComparisonPlayback() {
  return (
    shouldUseComparisonPlayback() &&
    recognizedTextMatchesLearningLanguage(currentRecognizedText, selectedTargetLanguage) &&
    hasCompleteComparisonAlignment(currentAttemptComparisonAlignment)
  );
}

function syncModelAudioSpeed() {
  const speed = normalizedPlaybackSpeed(speedSlider.value);
  speedSlider.value = String(speed);
  speedValue.textContent = formatPlaybackSpeed(speed);
  [modelAudio, repeatAudio].forEach((audio) => {
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  });
}

function handleModelAudioPlay() {
  syncModelAudioSpeed();
  syncPlayButton();
}

function handleSpeedChange() {
  syncModelAudioSpeed();
  savePracticeSettings();
}

function handlePinyinSettingChange() {
  savePracticeSettings();
  renderTargetDisplay();
}

function renderTargetDisplay() {
  const displayText = currentTargetDisplayText || currentTargetText || "";
  const pinyinRuby = selectedTargetLanguage === "zh-CN" && pinyinToggle.checked
    ? createPinyinRubyFragment(displayText, currentTargetPinyinText)
    : null;
  targetText.replaceChildren();
  targetText.classList.toggle("has-ruby", Boolean(pinyinRuby));
  if (pinyinRuby) {
    targetText.append(pinyinRuby);
  } else {
    targetText.textContent = displayText;
  }
  renderTargetSubtext(Boolean(pinyinRuby));
}

function renderTargetSubtext(hasPinyinRuby = false) {
  let secondaryText = currentTargetSecondaryText;
  if (selectedTargetLanguage === "zh-CN" && pinyinToggle.checked) {
    secondaryText = hasPinyinRuby ? "" : currentTargetPinyinText || (
      currentTargetPinyinStatus === "unavailable" ? "ピンインを生成できませんでした" : ""
    );
  }
  targetSubtext.hidden = !secondaryText;
  targetSubtext.textContent = secondaryText || "";
}

function createPinyinRubyFragment(text, pinyinText) {
  const chars = Array.from(text || "");
  const pinyinTokens = String(pinyinText || "")
    .split(/\s+/u)
    .map((token) => trimPinyinToken(token))
    .filter(Boolean);
  const hanCount = chars.filter((char) => isHanCharacter(char)).length;
  if (!hanCount || pinyinTokens.length < hanCount) {
    return null;
  }

  const fragment = document.createDocumentFragment();
  let pinyinIndex = 0;
  chars.forEach((char) => {
    if (!isHanCharacter(char)) {
      fragment.append(document.createTextNode(char));
      return;
    }
    const ruby = document.createElement("ruby");
    const rt = document.createElement("rt");
    ruby.append(document.createTextNode(char));
    rt.textContent = pinyinTokens[pinyinIndex] || "";
    ruby.append(rt);
    fragment.append(ruby);
    pinyinIndex += 1;
  });
  return fragment;
}

function trimPinyinToken(token) {
  const chars = Array.from(String(token || "").trim());
  while (chars.length && pinyinTrimCharacters.includes(chars[0])) {
    chars.shift();
  }
  while (chars.length && pinyinTrimCharacters.includes(chars[chars.length - 1])) {
    chars.pop();
  }
  return chars.join("");
}

function isHanCharacter(char) {
  const codePoint = char.codePointAt(0);
  return hanCodePointRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function shouldUseComparisonPlayback() {
  return Boolean(modelAudio.src && repeatAudio.src && !resultPanel.hidden);
}

function stopComparisonPlayback() {
  if (!isComparisonPlaying) {
    return;
  }
  comparisonPlaybackToken += 1;
  isComparisonPlaying = false;
  modelAudio.pause();
  repeatAudio.pause();
  syncPlayButton();
}

function isActiveComparisonPlayback(token) {
  return isComparisonPlaying && comparisonPlaybackToken === token;
}

async function playComparisonAudios() {
  if (isComparisonPlaying) {
    stopComparisonPlayback();
    return;
  }
  if (!modelAudio.src || !repeatAudio.src) {
    if (modelAudio.src) {
      await playModelAudioOnce();
    }
    return;
  }

  const token = comparisonPlaybackToken + 1;
  comparisonPlaybackToken = token;
  isComparisonPlaying = true;
  syncPlayButton();
  try {
    await Promise.all([ensureAudioMetadata(modelAudio), ensureAudioMetadata(repeatAudio)]);
    if (!isActiveComparisonPlayback(token)) {
      return;
    }
    if (!Number.isFinite(modelAudio.duration) || !Number.isFinite(repeatAudio.duration)) {
      await playAudioElementToEnd(modelAudio, token);
      if (!isActiveComparisonPlayback(token)) {
        return;
      }
      await playAudioElementToEnd(repeatAudio, token);
      return;
    }
    const comparisonRanges = comparisonAlignmentPlaybackRanges(
      currentAttemptComparisonAlignment,
      modelAudio.duration,
      repeatAudio.duration,
    );
    if (!comparisonRanges) {
      await playAudioElementToEnd(modelAudio, token);
      if (!isActiveComparisonPlayback(token)) {
        return;
      }
      await playAudioElementToEnd(repeatAudio, token);
      return;
    }
    for (const range of comparisonRanges) {
      if (!isActiveComparisonPlayback(token)) {
        return;
      }
      await playAudioSegmentToEnd(modelAudio, range.model.start, range.model.end, token);
      await sleep(180);
      if (!isActiveComparisonPlayback(token)) {
        return;
      }
      await playAudioSegmentToEnd(repeatAudio, range.repeat.start, range.repeat.end, token);
      await sleep(240);
    }
  } finally {
    if (comparisonPlaybackToken === token) {
      isComparisonPlaying = false;
      modelAudio.pause();
      repeatAudio.pause();
      syncPlayButton();
    }
  }
}

async function playModelAudioOnce() {
  syncModelAudioSpeed();
  await ensureAudioMetadata(modelAudio);
  syncModelAudioSpeed();
  await modelAudio.play();
}

function playAudioElementToEnd(audio, token) {
  return new Promise((resolve) => {
    let frame = 0;
    const done = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    const watch = () => {
      if (!isActiveComparisonPlayback(token) || audio.ended) {
        done();
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    audio.pause();
    audio.currentTime = 0;
    syncModelAudioSpeed();
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().then(watch).catch(done);
  });
}

function ensureAudioMetadata(audio) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener("loadedmetadata", done);
      audio.removeEventListener("durationchange", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.addEventListener("loadedmetadata", done, { once: true });
    audio.addEventListener("durationchange", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.load();
    window.setTimeout(done, 800);
  });
}

function playAudioSegmentToEnd(audio, start, end, token) {
  return new Promise((resolve) => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : end;
    const segmentStart = Math.max(0, Math.min(start, duration));
    const segmentEnd = Math.max(segmentStart, Math.min(end, duration));
    let frame = 0;
    const done = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      audio.pause();
      resolve();
    };
    const watch = () => {
      if (!isActiveComparisonPlayback(token) || audio.currentTime >= segmentEnd - 0.03 || audio.ended) {
        done();
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    audio.pause();
    audio.currentTime = segmentStart;
    syncModelAudioSpeed();
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().then(watch).catch(done);
  });
}

function sentenceAudioRanges(sentences, duration) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const weights = sentences.map((sentence) => Math.max(1, Array.from(sentence).filter((char) => !/\s/u.test(char)).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return weights.map((weight, index) => {
    const start = cursor;
    cursor = index === weights.length - 1 ? safeDuration : cursor + (safeDuration * weight) / totalWeight;
    return { start, end: cursor };
  });
}

function comparisonAlignmentPlaybackRanges(alignment, modelDuration, repeatDuration) {
  if (!hasCompleteComparisonAlignment(alignment)) {
    return null;
  }
  const phraseRanges = alignment.ranges.filter((range) => range?.available === true);
  const safeModelDuration = Number(modelDuration);
  const safeRepeatDuration = Number(repeatDuration);
  if (!Number.isFinite(safeModelDuration) || safeModelDuration <= 0 || !Number.isFinite(safeRepeatDuration) || safeRepeatDuration <= 0) {
    return null;
  }

  const modelRanges = sentenceAudioRanges(
    phraseRanges.map((range) => String(range.target || range.normalized_target || "")),
    safeModelDuration,
  );
  const paired = phraseRanges.map((range, index) => {
    const repeatStart = Number(range.audio_start);
    const repeatEnd = Number(range.audio_end);
    if (!Number.isFinite(repeatStart) || !Number.isFinite(repeatEnd) || repeatEnd <= repeatStart) {
      return null;
    }
    return {
      model: modelRanges[index],
      repeat: {
        start: Math.max(0, Math.min(repeatStart, safeRepeatDuration)),
        end: Math.max(0, Math.min(repeatEnd, safeRepeatDuration)),
      },
    };
  });
  return paired.every((range) => range && range.repeat.end > range.repeat.start) ? paired : null;
}

function hasCompleteComparisonAlignment(alignment) {
  if (!alignment?.complete || !Array.isArray(alignment.ranges)) {
    return false;
  }
  const ranges = alignment.ranges;
  return ranges.length > 1 && ranges.every((range) => {
    const start = Number(range?.audio_start);
    const end = Number(range?.audio_end);
    return range?.available === true && Number.isFinite(start) && Number.isFinite(end) && end > start;
  });
}

function recognizedTextMatchesLearningLanguage(text, language) {
  const contentChars = Array.from(String(text || "")).filter((char) => !/[\s\p{P}\p{S}]/u.test(char));
  if (!contentChars.length) {
    return false;
  }
  if (language === "zh-CN") {
    const hanCount = contentChars.filter((char) => isHanCharacter(char)).length;
    return hanCount >= 2 && hanCount / contentChars.length >= 0.3;
  }
  if (language === "ja-JP") {
    const japaneseCount = contentChars.filter((char) => isHanCharacter(char) || /[\u3040-\u30ff]/u.test(char)).length;
    return japaneseCount >= 2 && japaneseCount / contentChars.length >= 0.3;
  }
  if (language === "en-US") {
    return contentChars.some((char) => /[A-Za-z]/u.test(char));
  }
  return true;
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setBusy(busy, message, target = 100, kind = processingKind) {
  isBusy = busy;
  nativeRecordButton.disabled = busy;
  const processingButton = nativeRecordButton;
  progress.hidden = !busy;
  if (busy) {
    processingButton.classList.add("is-processing");
    progressDisplayed = Math.min(progressDisplayed, 20);
    progressTarget = target;
    startProgressTimer();
  } else {
    nativeRecordButton.classList.remove("is-processing");
    processingKind = "";
    progressTarget = 100;
    progressDisplayed = 100;
    updateProgress();
    stopProgressTimer();
    setTimeout(() => {
      if (!isBusy) {
        progress.hidden = true;
        progressDisplayed = 0;
        updateProgress();
      }
    }, 240);
  }
  if (message) {
    setStatus(message);
  }
}

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    const ceiling = Math.max(progressTarget, 10);
    const delta = Math.max(0.6, (ceiling - progressDisplayed) * 0.045);
    progressDisplayed = Math.min(ceiling, progressDisplayed + delta);
    updateProgress();
  }, 140);
}

function stopProgressTimer() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function updateProgress() {
  progressFill.style.width = `${Math.max(0, Math.min(100, progressDisplayed))}%`;
}

function setRecordingVisual(_kind, recording) {
  const button = nativeRecordButton;
  const label = nativeActionLabel;
  button.classList.toggle("is-recording", recording);
  button.classList.remove("is-processing");
  if (recording) {
    recordingStartedAt = performance.now();
    button.setAttribute("aria-label", "録音中");
    label.textContent = "停止 / Stop / 停止";
    startRecordTimer(button);
  } else {
    stopRecordTimer(button);
    syncPracticeRecordMode();
  }
}

function startLevelMeter(stream, container) {
  stopLevelMeter();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  currentAudioContext = new AudioContextClass();
  const source = currentAudioContext.createMediaStreamSource(stream);
  currentAnalyser = currentAudioContext.createAnalyser();
  currentAnalyser.fftSize = 256;
  source.connect(currentAnalyser);
  const data = new Uint8Array(currentAnalyser.frequencyBinCount);
  const bars = Array.from(container.querySelectorAll(".record-level-bar"));
  const draw = () => {
    currentAnalyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length / 255;
    const now = performance.now();
    bars.forEach((bar, index) => {
      const center = 1 - Math.abs(index - (bars.length - 1) / 2) / ((bars.length + 1) / 2);
      const movement = average > 0.03 ? Math.sin(now / 95 + index * 0.88) * 0.08 : 0;
      const level = Math.max(0.14, Math.min(1, average * (0.72 + center) + movement));
      bar.style.opacity = String(Math.max(0.46, Math.min(1, 0.52 + average * 0.58)));
      bar.style.transform = `scaleY(${level.toFixed(3)})`;
    });
    currentLevelFrame = requestAnimationFrame(draw);
  };
  container.classList.add("is-active");
  draw();
}

function stopLevelMeter() {
  if (currentLevelFrame) {
    cancelAnimationFrame(currentLevelFrame);
    currentLevelFrame = null;
  }
  if (currentAudioContext) {
    currentAudioContext.close().catch(() => {});
    currentAudioContext = null;
  }
  currentAnalyser = null;
  [nativeLevel].filter(Boolean).forEach((container) => {
    container.classList.remove("is-active");
    container.querySelectorAll(".record-level-bar").forEach((bar) => {
      bar.style.transform = "scaleY(0.18)";
      bar.style.opacity = "";
    });
  });
}

function startRecordTimer(button) {
  stopRecordTimer(button);
  updateRecordTimer(button);
  recordTimerId = window.setInterval(() => updateRecordTimer(button), 100);
}

function stopRecordTimer(button) {
  if (recordTimerId !== null) {
    window.clearInterval(recordTimerId);
  }
  recordTimerId = null;
  const targetButton = button || nativeRecordButton;
  targetButton.style.setProperty("--record-progress", "0deg");
  const timer = targetButton.querySelector(".record-timer");
  if (timer) {
    timer.textContent = "REC";
  }
}

function updateRecordTimer(button) {
  const elapsedMs = performance.now() - recordingStartedAt;
  const progress = (elapsedMs % 3000) / 3000;
  button.style.setProperty("--record-progress", `${Math.round(progress * 360)}deg`);
  const timer = button.querySelector(".record-timer");
  if (timer) {
    timer.textContent = `${Math.max(1, Math.floor(elapsedMs / 1000))}s`;
  }
}

function cleanupRecording() {
  stopLevelMeter();
  recordingStream?.getTracks().forEach((track) => track.stop());
  recordingStream = null;
  mediaRecorder = null;
  recordingKind = "";
  recordingChunks = [];
}

function preferredRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || "").split(";")[0].toLowerCase();
  if (normalized.includes("mp4")) return "m4a";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("ogg")) return "ogg";
  return "webm";
}

function normalizedPlaybackSpeed(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  const rounded = Math.round(parsed / 0.25) * 0.25;
  return Math.max(0.25, Math.min(2, Number(rounded.toFixed(2))));
}

function formatPlaybackSpeed(speed) {
  if (Number.isInteger(speed)) {
    return `${speed.toFixed(1)}x`;
  }
  return `${speed.toFixed(2).replace(/0$/, "")}x`;
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || "audio/wav" });
}

function setStatus(message) {
  statusText.textContent = message;
}

function showError(message) {
  errorText.hidden = false;
  errorText.textContent = message;
}

function clearError() {
  errorText.hidden = true;
  errorText.textContent = "";
}

function loadPracticeSettings() {
  const settings = readPracticeSettings();
  selectedTargetLanguage = languageLabels[settings.target_language] ? settings.target_language : "ja-JP";
  pinyinToggle.checked = selectedTargetLanguage === "zh-CN" ? true : settings.show_pinyin !== false;
  asrModelSelect.value = practiceAsrModels.has(settings.asr_model) ? settings.asr_model : "gpt-4o-transcribe";
  speedSlider.value = String(normalizedPlaybackSpeed(settings.speed));
  targetLanguageButtons.forEach((button) => {
    const selected = button.dataset.language === selectedTargetLanguage;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  });
  syncPinyinSettingVisibility();
  syncModelAudioSpeed();
}

function readPracticeSettings() {
  try {
    return JSON.parse(localStorage.getItem(practiceSettingsStorageKey) || "{}");
  } catch (_error) {
    return {};
  }
}

function savePracticeSettings() {
  try {
    localStorage.setItem(
      practiceSettingsStorageKey,
      JSON.stringify({
        target_language: selectedTargetLanguage,
        show_pinyin: Boolean(pinyinToggle.checked),
        asr_model: practiceAsrModel(),
        speed: normalizedPlaybackSpeed(speedSlider.value),
      }),
    );
  } catch (_error) {
    // localStorageが使えないブラウザでは、現在の画面内状態だけで動かす。
  }
}

function practiceAsrModel() {
  return practiceAsrModels.has(asrModelSelect.value) ? asrModelSelect.value : "gpt-4o-transcribe";
}

function syncPinyinSettingVisibility() {
  pinyinSetting.hidden = selectedTargetLanguage !== "zh-CN";
}

function normalizePracticeLanguage(language) {
  if (languageLabels[language]) {
    return language;
  }
  const lower = String(language || "").toLowerCase();
  if (lower.startsWith("ja")) return "ja-JP";
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return "";
}

function renderNativeLabels() {
  const labels = nativeUiLabels[detectedNativeLanguage] || nativeUiLabels["ja-JP"];
  nativeTranscriptLabel.textContent = labels.transcript;
  recognizedLabel.textContent = labels.recognized;
}

function syncPracticeRecordMode() {
  const repeatMode = Boolean(currentTargetText);
  recordTitle.textContent = repeatMode ? "まねして話す" : "言いたいことを話す";
  recordDescription.textContent = repeatMode ? "Repeat / 跟着说" : "说出想说的话 / Say what you want";
  nativeRecordButton.setAttribute("aria-label", repeatMode ? "まねして録音" : "言いたいことを録音");
  nativeActionLabel.textContent = repeatMode ? "まねする / Repeat / 模仿" : "話す / Speak / 说";
}

function renderRecognizedDiff(payload) {
  const recognized = payload.recognized_text || "";
  const diff = Array.isArray(payload.diff) ? payload.diff : [];
  const language = payload.target_language || selectedTargetLanguage;
  const map = normalizedOriginalMap(recognized, language);
  const targetMap = normalizedOriginalMap(currentTargetText, language);
  let mismatchRanges = diff
    .filter((entry) => entry.type !== "equal" && Number.isInteger(entry.recognized_start))
    .map((entry) => originalRangeForNormalizedRange(map, entry.recognized_start, entry.recognized_end))
    .filter((range) => range.end > range.start);
  const missingMarkers = diff
    .filter((entry) => entry.type === "delete" && Number.isInteger(entry.target_start))
    .map((entry) => ({
      start: insertionIndexForNormalizedIndex(map, entry.recognized_start),
      text: originalTextForNormalizedRange(targetMap, entry.target_start, entry.target_end),
    }))
    .filter((marker) => marker.text);
  recognizedText.innerHTML = "";
  if (!recognized) {
    if (missingMarkers.length) {
      missingMarkers.forEach((marker) => recognizedText.append(renderMissingTargetDiff(marker.text)));
    } else {
      recognizedText.textContent = "（聞き取れませんでした）";
    }
    return;
  }
  if (!mismatchRanges.length && !missingMarkers.length && (payload.grade || "retry") !== "ok") {
    mismatchRanges = [{ start: 0, end: recognized.length }];
  }
  let cursor = 0;
  const decorations = [
    ...mergeRanges(mismatchRanges).map((range) => ({ kind: "mismatch", ...range })),
    ...missingMarkers.map((marker) => ({ kind: "missing", start: marker.start, end: marker.start, text: marker.text })),
  ].sort((left, right) => left.start - right.start || (left.kind === "missing" ? -1 : 1));
  for (const decoration of decorations) {
    if (cursor < decoration.start) {
      recognizedText.append(document.createTextNode(recognized.slice(cursor, decoration.start)));
    }
    if (decoration.kind === "missing") {
      recognizedText.append(renderMissingTargetDiff(decoration.text));
      continue;
    }
    recognizedText.append(renderRecognizedMismatchDiff(recognized.slice(decoration.start, decoration.end)));
    cursor = decoration.end;
  }
  if (cursor < recognized.length) {
    recognizedText.append(document.createTextNode(recognized.slice(cursor)));
  }
}

function renderRecognizedMismatchDiff(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "practice-diff-mismatch";
  button.textContent = text;
  button.title = "比較再生";
  button.addEventListener("click", playComparisonAudios);
  return button;
}

function renderMissingTargetDiff(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "practice-diff-missing";
  button.textContent = `抜け: ${text}`;
  button.title = "抜けた部分を比較再生";
  button.addEventListener("click", playComparisonAudios);
  return button;
}

function normalizedOriginalMap(text, language) {
  const chars = Array.from(text || "");
  const normalizedChars = [];
  const originalIndexes = [];
  chars.forEach((char, originalIndex) => {
    const normalized = normalizePracticeChar(char, language);
    for (const normalizedChar of Array.from(normalized)) {
      if (!/[\p{P}\p{Z}\p{S}]/u.test(normalizedChar)) {
        normalizedChars.push(normalizedChar);
        originalIndexes.push(originalIndex);
      }
    }
  });
  return { chars, normalizedChars, originalIndexes };
}

function normalizePracticeChar(char, language) {
  let normalized = String(char || "").normalize("NFKC").toLowerCase();
  if (language === "ja-JP") {
    normalized = normalized.replace(/[\u30a1-\u30f6]/g, (value) =>
      String.fromCharCode(value.charCodeAt(0) - 0x60)
    );
  }
  if (language === "zh-CN") {
    normalized = Array.from(normalized).map((value) => zhTraditionalToSimplified[value] || value).join("");
  }
  return normalized;
}

function originalRangeForNormalizedRange(map, start, end) {
  if (end <= start || map.originalIndexes.length === 0) {
    return { start: 0, end: 0 };
  }
  const first = map.originalIndexes[Math.min(start, map.originalIndexes.length - 1)];
  const last = map.originalIndexes[Math.min(Math.max(end - 1, start), map.originalIndexes.length - 1)];
  if (!Number.isInteger(first) || !Number.isInteger(last)) {
    return { start: 0, end: 0 };
  }
  return { start: first, end: last + 1 };
}

function originalTextForNormalizedRange(map, start, end) {
  const range = originalRangeForNormalizedRange(map, start, end);
  if (range.end <= range.start) {
    return "";
  }
  return map.chars.slice(range.start, range.end).join("");
}

function insertionIndexForNormalizedIndex(map, index) {
  if (!Number.isInteger(index) || map.originalIndexes.length === 0) {
    return map.chars.length;
  }
  if (index <= 0) {
    return 0;
  }
  if (index >= map.originalIndexes.length) {
    return map.chars.length;
  }
  return map.originalIndexes[index];
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

loadPracticeSettings();
resetPractice();
