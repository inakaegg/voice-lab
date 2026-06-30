const targetLanguageButtons = Array.from(document.querySelectorAll(".practice-language-button"));
const nativePanel = document.querySelector(".practice-card-primary");
const nativeRecordButton = document.querySelector("#practice-native-record-button");
const repeatRecordButton = document.querySelector("#practice-repeat-record-button");
const nativeLevel = document.querySelector("#practice-native-level");
const repeatLevel = document.querySelector("#practice-repeat-level");
const nativeActionLabel = document.querySelector("#practice-native-action-label");
const repeatActionLabel = document.querySelector("#practice-repeat-action-label");
const promptPanel = document.querySelector("#practice-prompt-panel");
const repeatPanel = document.querySelector("#practice-repeat-panel");
const resultPanel = document.querySelector("#practice-result-panel");
const targetLabel = document.querySelector("#practice-target-label");
const targetText = document.querySelector("#practice-target-text");
const targetSubtext = document.querySelector("#practice-target-subtext");
const modelAudio = document.querySelector("#practice-model-audio");
const playModelButton = document.querySelector("#practice-play-model-button");
const speedSlider = document.querySelector("#practice-speed-slider");
const speedValue = document.querySelector("#practice-speed-value");
const segmentModeSelect = document.querySelector("#practice-segment-mode");
const gradeBadge = document.querySelector("#practice-grade-badge");
const scoreText = document.querySelector("#practice-score");
const scoreFill = document.querySelector("#practice-score-fill");
const recognizedText = document.querySelector("#practice-recognized-text");
const retryButton = document.querySelector("#practice-retry-button");
const nextButton = document.querySelector("#practice-next-button");
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
const compareButton = document.querySelector("#practice-compare-button");
const repeatAudioButton = document.querySelector("#practice-repeat-audio-button");
const repeatAudio = document.querySelector("#practice-repeat-audio");

const languageLabels = {
  "ja-JP": "日本語",
  "zh-CN": "中文",
  "en-US": "English",
};
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
    compare: "比較再生",
    repeatAudio: "自分の録音",
  },
  "zh-CN": {
    transcript: "你说的话",
    recognized: "识别结果",
    compare: "对比播放",
    repeatAudio: "我的录音",
  },
  "en-US": {
    transcript: "What you said",
    recognized: "Recognized",
    compare: "Compare",
    repeatAudio: "My recording",
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
let currentAudioContext = null;
let currentAnalyser = null;
let currentLevelFrame = null;
let recordTimerId = null;
let recordingStartedAt = 0;
let processingKind = "";
let progressTimer = null;
let progressDisplayed = 0;
let progressTarget = 0;

targetLanguageButtons.forEach((button) => {
  button.addEventListener("click", () => selectTargetLanguage(button.dataset.language || "ja-JP"));
});
nativeRecordButton.addEventListener("click", () => toggleRecording("native"));
repeatRecordButton.addEventListener("click", () => toggleRecording("repeat"));
playModelButton.addEventListener("click", toggleModelAudio);
speedSlider.addEventListener("input", handleSpeedChange);
segmentModeSelect.addEventListener("change", savePracticeSettings);
pinyinToggle.addEventListener("change", handlePinyinSettingChange);
compareButton.addEventListener("click", playComparisonAudios);
repeatAudioButton.addEventListener("click", playRepeatAudio);
retryButton.addEventListener("click", () => toggleRecording("repeat"));
nextButton.addEventListener("click", resetPractice);
modelAudio.addEventListener("ended", syncPlayButton);
modelAudio.addEventListener("pause", syncPlayButton);
modelAudio.addEventListener("play", syncPlayButton);

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
  if (kind === "repeat" && !currentTargetText) {
    showError("先に おてほんを つくってください。");
    return;
  }
  await startRecording(kind);
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
  startLevelMeter(stream, kind === "native" ? nativeLevel : repeatLevel);
  setRecordingVisual(kind, true);
  setStatus(
    kind === "native"
      ? "言いたいことを話してください / Speak / 说"
      : "お手本をまねして話してください / Repeat / 跟读",
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
  if (kind === "native") {
    await submitPrompt(blob);
  } else {
    await submitAttempt(blob);
  }
}

async function submitPrompt(blob) {
  setBusy(true, "お手本を作っています。", 72, "native");
  promptPanel.hidden = true;
  repeatPanel.hidden = true;
  resultPanel.hidden = true;
  const form = new FormData();
  if (selectedTargetLanguage === "zh-CN") {
    pinyinToggle.checked = true;
  }
  form.append("target_language", selectedTargetLanguage);
  form.append("include_pinyin", selectedTargetLanguage === "zh-CN" ? "true" : "false");
  form.append("audio", blob, `native.${extensionForMimeType(blob.type)}`);
  const payload = await postPracticeForm("/api/practice/prompts", form);
  detectedNativeLanguage = normalizePracticeLanguage(payload.detected_source_language || "");
  renderNativeLabels();
  currentTargetText = payload.target_text || "";
  currentTargetDisplayText = payload.display_text?.primary_text || currentTargetText;
  targetLabel.textContent = `${languageLabels[payload.target_language] || ""} のお手本`;
  targetText.textContent = currentTargetDisplayText;
  currentTargetSecondaryText = payload.display_text?.secondary_text || "";
  currentTargetPinyinText = payload.display_text?.pinyin_text || "";
  renderTargetSubtext();
  nativeTranscript.textContent = payload.transcript || "";
  nativeTranscriptPanel.hidden = !payload.transcript;
  setModelAudio(payload.audio_base64, payload.audio_mime_type || "audio/wav");
  nativePanel.hidden = true;
  promptPanel.hidden = false;
  repeatPanel.hidden = false;
  setBusy(false, "お手本を聞いて、まねして話してください。");
  await modelAudio.play().catch(() => {});
  syncPlayButton();
}

async function submitAttempt(blob) {
  setBusy(true, "聞き取っています。", 88, "repeat");
  resultPanel.hidden = true;
  setRepeatAudio(blob);
  const form = new FormData();
  form.append("target_language", selectedTargetLanguage);
  form.append("target_text", currentTargetText);
  form.append("audio", blob, `repeat.${extensionForMimeType(blob.type)}`);
  const payload = await postPracticeForm("/api/practice/attempts", form);
  renderAttemptResult(payload);
  setBusy(false, "何度でも練習できます。");
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
  const grade = payload.grade || "retry";
  gradeBadge.textContent = payload.grade_label || grade;
  gradeBadge.dataset.grade = grade;
  const percent = Math.round(Number(payload.similarity || 0) * 100);
  scoreText.textContent = `${percent}%`;
  scoreFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  renderRecognizedDiff(payload);
  resultPanel.hidden = false;
}

function resetPractice() {
  stopModelAudio();
  currentTargetText = "";
  currentTargetDisplayText = "";
  currentTargetSecondaryText = "";
  currentTargetPinyinText = "";
  detectedNativeLanguage = "";
  nativePanel.hidden = false;
  promptPanel.hidden = true;
  repeatPanel.hidden = true;
  resultPanel.hidden = true;
  nativeTranscriptPanel.hidden = true;
  nativeTranscript.textContent = "";
  recognizedText.textContent = "";
  stopRepeatAudio();
  renderNativeLabels();
  targetText.textContent = "";
  renderTargetSubtext();
  setStatus("言いたいことを話す / 说出想说的话 / Say what you want");
  clearError();
}

function setModelAudio(audioBase64, mimeType) {
  stopModelAudio();
  const blob = base64ToBlob(audioBase64, mimeType);
  modelAudioUrl = URL.createObjectURL(blob);
  modelAudio.src = modelAudioUrl;
  syncModelAudioSpeed();
}

function setRepeatAudio(blob) {
  stopRepeatAudio();
  repeatAudioUrl = URL.createObjectURL(blob);
  repeatAudio.src = repeatAudioUrl;
}

function toggleModelAudio() {
  if (!modelAudio.src) {
    return;
  }
  if (modelAudio.paused) {
    modelAudio.play().catch((error) => showError(error.message));
  } else {
    modelAudio.pause();
  }
}

function stopModelAudio() {
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
  playModelButton.classList.toggle("is-playing", !modelAudio.paused);
  playModelButton.querySelector("span:last-child").textContent = modelAudio.paused ? "再生" : "停止";
}

function syncModelAudioSpeed() {
  const speed = normalizedPlaybackSpeed(speedSlider.value);
  speedSlider.value = String(speed);
  speedValue.textContent = formatPlaybackSpeed(speed);
  modelAudio.playbackRate = speed;
}

function handleSpeedChange() {
  syncModelAudioSpeed();
  savePracticeSettings();
}

function handlePinyinSettingChange() {
  savePracticeSettings();
  renderTargetSubtext();
}

function renderTargetSubtext() {
  const secondaryText = selectedTargetLanguage === "zh-CN" && pinyinToggle.checked
    ? currentTargetPinyinText
    : currentTargetSecondaryText;
  targetSubtext.hidden = !secondaryText;
  targetSubtext.textContent = secondaryText || "";
}

async function playRepeatAudio() {
  if (!repeatAudio.src) {
    return;
  }
  repeatAudio.currentTime = 0;
  await repeatAudio.play().catch((error) => showError(error.message));
}

async function playComparisonAudios() {
  if (!modelAudio.src || !repeatAudio.src) {
    if (modelAudio.src) {
      await playAudioElementToEnd(modelAudio);
    }
    if (repeatAudio.src) {
      await playAudioElementToEnd(repeatAudio);
    }
    return;
  }
  await Promise.all([ensureAudioMetadata(modelAudio), ensureAudioMetadata(repeatAudio)]);
  const sentences = splitPracticeSentences(currentTargetText, practiceSegmentMode());
  if (sentences.length <= 1 || !Number.isFinite(modelAudio.duration) || !Number.isFinite(repeatAudio.duration)) {
    await playAudioElementToEnd(modelAudio);
    await playAudioElementToEnd(repeatAudio);
    return;
  }
  const modelRanges = sentenceAudioRanges(sentences, modelAudio.duration);
  const repeatRanges = sentenceAudioRanges(sentences, repeatAudio.duration);
  for (let index = 0; index < sentences.length; index += 1) {
    await playAudioSegmentToEnd(modelAudio, modelRanges[index].start, modelRanges[index].end);
    await sleep(180);
    await playAudioSegmentToEnd(repeatAudio, repeatRanges[index].start, repeatRanges[index].end);
    await sleep(240);
  }
}

function playAudioElementToEnd(audio) {
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.pause();
    audio.currentTime = 0;
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().catch(done);
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

function playAudioSegmentToEnd(audio, start, end) {
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
      if (audio.currentTime >= segmentEnd - 0.03 || audio.ended) {
        done();
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    audio.pause();
    audio.currentTime = segmentStart;
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().then(watch).catch(done);
  });
}

function splitPracticeSentences(text, mode = "punctuation") {
  const normalized = String(text || "").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const separatorPattern = mode === "sentence"
    ? /[^。！？!?.\n]+[。！？!?.]?/g
    : /[^。！？!?.,，、；;：:\n]+[。！？!?.,，、；;：:]?/g;
  const matches = normalized.match(separatorPattern) || [];
  const sentences = matches.map((value) => value.trim()).filter(Boolean);
  return sentences.length ? sentences : [normalized];
}

function practiceSegmentMode() {
  return segmentModeSelect.value === "sentence" ? "sentence" : "punctuation";
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

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setBusy(busy, message, target = 100, kind = processingKind) {
  isBusy = busy;
  nativeRecordButton.disabled = busy;
  repeatRecordButton.disabled = busy || !currentTargetText;
  const processingButton = kind === "repeat" ? repeatRecordButton : nativeRecordButton;
  progress.hidden = !busy;
  if (busy) {
    processingButton.classList.add("is-processing");
    progressDisplayed = Math.min(progressDisplayed, 20);
    progressTarget = target;
    startProgressTimer();
  } else {
    nativeRecordButton.classList.remove("is-processing");
    repeatRecordButton.classList.remove("is-processing");
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

function setRecordingVisual(kind, recording) {
  const button = kind === "native" ? nativeRecordButton : repeatRecordButton;
  const label = kind === "native" ? nativeActionLabel : repeatActionLabel;
  button.classList.toggle("is-recording", recording);
  button.classList.remove("is-processing");
  if (recording) {
    recordingStartedAt = performance.now();
    button.setAttribute("aria-label", kind === "native" ? "録音中" : "まねして録音中");
    label.textContent = "停止 / Stop / 停止";
    startRecordTimer(button);
  } else {
    stopRecordTimer(button);
    button.setAttribute("aria-label", kind === "native" ? "言いたいことを録音" : "まねして録音");
    label.textContent = kind === "native" ? "話す / Speak / 说" : "まねする / Repeat / 模仿";
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
  [nativeLevel, repeatLevel].forEach((container) => {
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
  return Math.max(0.25, Math.min(2, Math.round(parsed / 0.25) * 0.25));
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
  speedSlider.value = String(normalizedPlaybackSpeed(settings.speed));
  segmentModeSelect.value = settings.segment_mode === "sentence" ? "sentence" : "punctuation";
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
        speed: normalizedPlaybackSpeed(speedSlider.value),
        segment_mode: practiceSegmentMode(),
      }),
    );
  } catch (_error) {
    // localStorageが使えないブラウザでは、現在の画面内状態だけで動かす。
  }
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
  compareButton.textContent = labels.compare;
  repeatAudioButton.textContent = labels.repeatAudio;
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
