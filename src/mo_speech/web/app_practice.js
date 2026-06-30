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
const speedSelect = document.querySelector("#practice-speed-select");
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

const languageLabels = {
  "ja-JP": "日本語",
  "zh-CN": "中文",
  "en-US": "English",
};

let selectedTargetLanguage = "ja-JP";
let mediaRecorder = null;
let recordingStream = null;
let recordingKind = "";
let recordingChunks = [];
let isBusy = false;
let modelAudioUrl = "";
let currentTargetText = "";
let currentTargetDisplayText = "";
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
speedSelect.addEventListener("change", syncModelAudioSpeed);
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
  form.append("target_language", selectedTargetLanguage);
  form.append("audio", blob, `native.${extensionForMimeType(blob.type)}`);
  const payload = await postPracticeForm("/api/practice/prompts", form);
  currentTargetText = payload.target_text || "";
  currentTargetDisplayText = payload.display_text?.primary_text || currentTargetText;
  targetLabel.textContent = `${languageLabels[payload.target_language] || ""} のお手本`;
  targetText.textContent = currentTargetDisplayText;
  const secondaryText = payload.display_text?.secondary_text || "";
  targetSubtext.hidden = !secondaryText;
  targetSubtext.textContent = secondaryText;
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
  recognizedText.textContent = payload.recognized_text || "（聞き取れませんでした）";
  resultPanel.hidden = false;
}

function resetPractice() {
  stopModelAudio();
  currentTargetText = "";
  currentTargetDisplayText = "";
  nativePanel.hidden = false;
  promptPanel.hidden = true;
  repeatPanel.hidden = true;
  resultPanel.hidden = true;
  targetText.textContent = "";
  targetSubtext.textContent = "";
  targetSubtext.hidden = true;
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

function syncPlayButton() {
  playModelButton.classList.toggle("is-playing", !modelAudio.paused);
  playModelButton.querySelector("span:last-child").textContent = modelAudio.paused ? "再生" : "停止";
}

function syncModelAudioSpeed() {
  modelAudio.playbackRate = Number.parseFloat(speedSelect.value || "1") || 1;
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

resetPractice();
