const targetLanguageSelect = document.querySelector("#practice-target-language-select");
const nativePanel = document.querySelector("#practice-native-panel");
const nativeRecordButton = document.querySelector("#practice-native-record-button");
const nativeCancelButton = document.querySelector("#practice-native-cancel-button");
const recordTitle = document.querySelector("#practice-record-title");
const nativeLevel = document.querySelector("#practice-native-level");
const promptPanel = document.querySelector("#practice-prompt-panel");
const repeatRecordButton = document.querySelector("#practice-repeat-record-button");
const repeatCancelButton = document.querySelector("#practice-repeat-cancel-button");
const repeatLevel = document.querySelector("#practice-repeat-level");
const resultPanel = document.querySelector("#practice-result-panel");
const targetLabel = document.querySelector("#practice-target-label");
const targetText = document.querySelector("#practice-target-text");
const targetSubtext = document.querySelector("#practice-target-subtext");
const modelAudio = document.querySelector("#practice-model-audio");
const playModelButton = document.querySelector("#practice-play-model-button");
const speedSlider = document.querySelector("#practice-speed-slider");
const speedValue = document.querySelector("#practice-speed-value");
const gradeBadge = document.querySelector("#practice-grade-badge");
const scoreText = document.querySelector("#practice-score");
const scoreFill = document.querySelector("#practice-score-fill");
const recognizedText = document.querySelector("#practice-recognized-text");
const progress = document.querySelector("#practice-progress");
const progressFill = document.querySelector("#practice-progress-fill");
const statusText = document.querySelector("#practice-status");
const errorText = document.querySelector("#practice-error");
const jobStatus = document.querySelector("#practice-job-status");
const jobStatusLabel = document.querySelector("#practice-job-status-label");
const jobStatusModel = document.querySelector("#practice-job-status-model");
const jobStatusDetail = document.querySelector("#practice-job-status-detail");
const pinyinSetting = document.querySelector("#practice-pinyin-setting");
const pinyinToggle = document.querySelector("#practice-pinyin-toggle");
const chineseScriptSetting = document.querySelector("#practice-chinese-script-setting");
const chineseScriptToggle = document.querySelector(".practice-script-toggle");
const simplifiedScriptButton = document.querySelector("#practice-script-simplified");
const traditionalScriptButton = document.querySelector("#practice-script-traditional");
const ownVoiceToggle = document.querySelector("#practice-own-voice-toggle");
const nativeTranscriptPanel = document.querySelector("#practice-native-transcript-panel");
const nativeTranscriptLabel = document.querySelector("#practice-native-transcript-label");
const nativeTranscript = document.querySelector("#practice-native-transcript");
const recognizedLabel = document.querySelector("#practice-recognized-label");
const repeatAudio = document.querySelector("#practice-repeat-audio");
const resultSummary = document.querySelector("#practice-result-panel .practice-result-summary");
const scoreBar = document.querySelector("#practice-result-panel .practice-score-bar");
const comparisonNote = document.querySelector("#practice-comparison-note");
const gradeGuide = document.querySelector("#practice-prompt-panel .practice-grade-guide");
const playbackContract = window.voiceLabPracticePlayback;

const languageLabels = {
  "ja-JP": "日本語",
  "zh-CN": "中文",
  "en-US": "English",
};
const hanCodePointRanges = [
  [0x3400, 0x4DBF],
  [0x4E00, 0x9FFF],
  [0x20000, 0x2A6DF],
  [0x2A700, 0x2B73F],
  [0x2B740, 0x2B81F],
  [0x2B820, 0x2CEAF],
];
const pinyinTrimCharacters = "，。！？；：、,.!?;:\"'“”‘’（）()[]【】《》<>";
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
const defaultPracticeTargetLanguage = "en-US";
const selectablePracticeTargetLanguages = new Set(["zh-CN", "en-US"]);

let selectedTargetLanguage = defaultPracticeTargetLanguage;
let selectedChineseScript = "simplified";
let detectedNativeLanguage = "";
let mediaRecorder = null;
let recordingStream = null;
let recordingKind = "";
let recordingChunks = [];
let recordingCancelled = false;
let isBusy = false;
let modelAudioUrl = "";
let currentModelAudioBlob = null;
let repeatAudioUrl = "";
let currentTargetText = "";
let currentTargetDisplayText = "";
let currentTargetSecondaryText = "";
let currentTargetPinyinText = "";
let currentTargetPinyinStatus = "disabled";
let currentRecognizedText = "";
let currentAttemptPayload = null;
let currentAttemptComparisonAlignment = null;
let currentModelComparisonAlignment = null;
let currentAudioContext = null;
let currentAnalyser = null;
let currentLevelFrame = null;
let recordTimerId = null;
let recordingStartedAt = 0;
let activeRecordSlot = "native";
let processingKind = "";
let progressTimer = null;
let progressDisplayed = 0;
let progressTarget = 0;
let isComparisonPlaying = false;
let comparisonPlaybackToken = 0;

targetLanguageSelect.addEventListener("change", () => selectTargetLanguage(targetLanguageSelect.value || defaultPracticeTargetLanguage));
nativeRecordButton.addEventListener("click", () => {
  setActiveRecordSlot("native");
  toggleRecording("native");
});
nativeCancelButton.addEventListener("click", () => cancelRecording("native"));
repeatRecordButton.addEventListener("click", () => {
  setActiveRecordSlot("repeat");
  toggleRecording("repeat");
});
repeatCancelButton.addEventListener("click", () => cancelRecording("repeat"));
nativePanel.addEventListener("pointerenter", () => setActiveRecordSlot("native"));
nativePanel.addEventListener("pointerleave", () => {
  if (currentTargetText && !mediaRecorder && !isBusy) {
    setActiveRecordSlot("repeat");
  }
});
nativePanel.addEventListener("focusin", () => setActiveRecordSlot("native"));
promptPanel.addEventListener("pointerenter", () => setActiveRecordSlot("repeat"));
promptPanel.addEventListener("focusin", () => setActiveRecordSlot("repeat"));
playModelButton.addEventListener("click", toggleModelAudio);
speedSlider.addEventListener("input", handleSpeedChange);
pinyinToggle.addEventListener("change", handlePinyinSettingChange);
ownVoiceToggle.addEventListener("change", savePracticeSettings);
simplifiedScriptButton.addEventListener("click", () => selectChineseScript("simplified"));
traditionalScriptButton.addEventListener("click", () => selectChineseScript("traditional"));
chineseScriptToggle.addEventListener("keydown", handleChineseScriptKeydown);
modelAudio.addEventListener("ended", syncPlayButton);
modelAudio.addEventListener("loadedmetadata", syncModelAudioSpeed);
modelAudio.addEventListener("pause", syncPlayButton);
modelAudio.addEventListener("play", handleModelAudioPlay);
modelAudio.addEventListener("playing", handleModelAudioPlay);
repeatAudio.addEventListener("loadedmetadata", syncModelAudioSpeed);
repeatAudio.addEventListener("play", syncModelAudioSpeed);
repeatAudio.addEventListener("playing", syncModelAudioSpeed);

function selectTargetLanguage(language) {
  if (isBusy || mediaRecorder) {
    return;
  }
  selectedTargetLanguage = selectablePracticeTargetLanguages.has(language) ? language : defaultPracticeTargetLanguage;
  targetLanguageSelect.value = selectedTargetLanguage;
  if (selectedTargetLanguage === "zh-CN") {
    pinyinToggle.checked = true;
  }
  syncPinyinSettingVisibility();
  syncCurrentLanguageLabel();
  savePracticeSettings();
  resetPractice();
}

async function toggleRecording(slot) {
  clearError();
  if (isBusy) {
    return;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") {
    if (recordingKind === slot) {
      recordingCancelled = false;
      mediaRecorder.stop();
    }
    return;
  }
  await startRecording(slot);
}

async function startRecording(slot) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showError("このブラウザでは録音を使えません。");
    return;
  }
  pausePlaybackForRecording();
  if (slot === "repeat") {
    currentRecognizedText = "";
    currentAttemptPayload = null;
    currentAttemptComparisonAlignment = null;
    currentModelComparisonAlignment = null;
    resultPanel.hidden = true;
    syncPlayButton();
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
  recordingKind = slot;
  recordingChunks = [];
  recordingCancelled = false;
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      recordingChunks.push(event.data);
    }
  });
  mediaRecorder.addEventListener("stop", handleRecordingStopped, { once: true });
  mediaRecorder.start();
  startLevelMeter(stream, levelForRecordSlot(slot));
  setRecordingVisual(slot, true);
  setStatus(
    currentTargetText
      ? "録音中です。"
      : "録音中です / Recording / 录音中",
  );
}

async function handleRecordingStopped() {
  const kind = recordingKind;
  const cancelled = recordingCancelled;
  const type = mediaRecorder?.mimeType || preferredRecordingMimeType() || "audio/webm";
  const blob = new Blob(recordingChunks, { type });
  cleanupRecording();
  setRecordingVisual(kind, false);
  recordingCancelled = false;
  if (cancelled) {
    processingKind = "";
    setStatus("録音をキャンセルしました。");
    clearError();
    return;
  }
  processingKind = kind;
  if (!blob.size) {
    showError("録音できませんでした。");
    return;
  }
  try {
    await submitPracticeRecording(blob, kind);
  } catch (error) {
    setBusy(false, "");
    showError(publicPracticeErrorMessage(error));
  }
}

function cancelRecording(slot) {
  if (!mediaRecorder || mediaRecorder.state !== "recording" || recordingKind !== slot) {
    return;
  }
  recordingCancelled = true;
  mediaRecorder.stop();
}

async function submitPracticeRecording(blob, kind) {
  const recordingIntent = kind === "repeat" ? "attempt" : "prompt";
  setBusy(
    true,
    recordingIntent === "attempt"
      ? "発音を確認しています。"
      : "お手本を作っています。",
    recordingIntent === "attempt" ? 88 : 72,
    kind,
  );
  if (recordingIntent === "prompt" && !currentTargetText) {
    promptPanel.hidden = true;
  }
  resultPanel.hidden = true;
  if (recordingIntent === "prompt") {
    clearPracticeJobStatus();
  }
  const form = new FormData();
  if (selectedTargetLanguage === "zh-CN") {
    pinyinToggle.checked = true;
  }
  form.append("recording_intent", recordingIntent);
  form.append("target_language", selectedTargetLanguage);
  form.append("current_target_text", currentTargetText);
  form.append("target_text", currentTargetText);
  form.append("include_pinyin", selectedTargetLanguage === "zh-CN" ? "true" : "false");
  form.append("use_own_voice", ownVoiceToggle.checked ? "true" : "false");
  form.append("asr_model", practiceAsrModel());
  form.append("audio", blob, `practice.${extensionForMimeType(blob.type)}`);
  if (recordingIntent === "attempt") {
    if (!currentModelAudioBlob) {
      setBusy(false, "");
      throw new Error("お手本音声が見つかりません。もう一度お手本を作ってください。");
    }
    form.append(
      "model_audio",
      currentModelAudioBlob,
      `model.${extensionForMimeType(currentModelAudioBlob.type)}`,
    );
    const submitted = await postPracticeForm("/api/practice/attempt-jobs", form);
    renderPracticeJobStatus(submitted);
    progress.hidden = true;
    setStatus("");
    const completed = await waitForPracticeAttemptJob(submitted);
    if (completed.status !== "succeeded" || !completed.result) {
      console.error("[SpeakLoop job] attempt failed", completed);
      throw new Error("音声処理を完了できませんでした。しばらくしてからもう一度お試しください。");
    }
    setRepeatAudio(blob);
    renderAttemptResult(completed.result);
    setBusy(false, "");
    if (completed.result.outcome !== "no_speech") {
      playComparisonAudios().catch((error) => showError(error.message));
    }
    return;
  }
  const payload = await postPracticeForm("/api/practice/recordings", form);
  const voiceJob = payload.voice_conversion_job || null;
  renderPromptResult(payload, { deferModelAudio: Boolean(voiceJob) });
  if (voiceJob) {
    renderPracticeJobStatus(voiceJob);
    progressTarget = 92;
    setStatus("");
    const completed = await waitForPracticeVoiceJob(voiceJob);
    if (completed.status !== "succeeded" || !completed.result?.audio_base64) {
      console.error("[SpeakLoop job] voice conversion failed", completed);
      throw new Error("お手本の音声処理を完了できませんでした。しばらくしてからもう一度お試しください。");
    }
    setModelAudio(completed.result.audio_base64, completed.result.audio_mime_type || "audio/wav");
  }
  setBusy(false, "");
  if (voiceJob) {
    ensureAudioMetadata(modelAudio)
      .then(() => playAudioWithCurrentSpeed(modelAudio))
      .catch(() => {});
  }
}

async function waitForPracticeVoiceJob(initialSnapshot) {
  let snapshot = initialSnapshot;
  const deadline = Date.now() + 30 * 60 * 1000;
  let consecutiveErrors = 0;
  while (snapshot?.status === "queued" || snapshot?.status === "running") {
    if (!snapshot.job_id) {
      throw new Error("お手本の音声処理を開始できませんでした。");
    }
    if (Date.now() >= deadline) {
      throw new Error("自分の声への変換が30分以内に完了しませんでした。");
    }
    await sleep(snapshot.status === "queued" ? 1200 : 850);
    try {
      const response = await fetch(`/api/practice/voice-jobs/${encodeURIComponent(snapshot.job_id)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, `job status failed: ${response.status}`));
      }
      snapshot = payload;
      consecutiveErrors = 0;
      renderPracticeJobStatus(snapshot);
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw error;
      }
      renderPracticeJobStatus({
        ...snapshot,
        current_stage: {
          ...(snapshot.current_stage || {}),
          label: "処理状況を再確認しています",
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  renderPracticeJobStatus(snapshot);
  return snapshot;
}

async function waitForPracticeAttemptJob(initialSnapshot) {
  let snapshot = initialSnapshot;
  const deadline = Date.now() + 30 * 60 * 1000;
  let consecutiveErrors = 0;
  while (snapshot?.status === "queued" || snapshot?.status === "running") {
    if (!snapshot.job_id) {
      throw new Error("発音比較を開始できませんでした。");
    }
    if (Date.now() >= deadline) {
      throw new Error("発音比較が30分以内に完了しませんでした。");
    }
    await sleep(snapshot.status === "queued" ? 1200 : 850);
    try {
      const response = await fetch(`/api/practice/attempt-jobs/${encodeURIComponent(snapshot.job_id)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, `job status failed: ${response.status}`));
      }
      snapshot = payload;
      consecutiveErrors = 0;
      renderPracticeJobStatus(snapshot);
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw error;
      }
      renderPracticeJobStatus({
        ...snapshot,
        current_stage: {
          ...(snapshot.current_stage || {}),
          label: "処理状況を再確認しています",
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  renderPracticeJobStatus(snapshot);
  return snapshot;
}

function renderPracticeJobStatus(snapshot) {
  if (!jobStatus || !snapshot) {
    return;
  }
  const stage = snapshot.current_stage || {};
  const state = String(snapshot.status || "running");
  const metrics = snapshot.metrics || {};
  const publicLabel = publicPracticeStageLabel(stage, state);
  const technicalIdentity = [...new Set(
    [stage.provider, stage.model]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )].join(" / ");
  const rawStageLabel = String(stage.label || "").trim();
  const rawStageDetail = String(stage.detail || "").trim();
  const details = [];
  if (rawStageLabel && rawStageLabel !== publicLabel) {
    details.push(rawStageLabel);
  }
  if (rawStageDetail && rawStageDetail !== rawStageLabel) {
    details.push(rawStageDetail);
  }
  if (Number.isFinite(Number(metrics.delay_time_ms))) {
    details.push(`待機 ${formatDurationMilliseconds(Number(metrics.delay_time_ms))}`);
  }
  if (Number.isFinite(Number(metrics.execution_time_ms))) {
    details.push(`処理 ${formatDurationMilliseconds(Number(metrics.execution_time_ms))}`);
  }
  jobStatus.hidden = false;
  jobStatus.dataset.state = state;
  jobStatus.dataset.stage = String(stage.stage || "");
  jobStatusLabel.textContent = publicLabel;
  jobStatusModel.textContent = technicalIdentity;
  jobStatusModel.hidden = !technicalIdentity;
  jobStatusDetail.textContent = details.filter(Boolean).join(" / ");
  jobStatusDetail.hidden = !jobStatusDetail.textContent;
  console.debug("[SpeakLoop job] progress", snapshot);
}

function publicPracticeStageLabel(stage, state) {
  switch (String(stage?.stage || "")) {
    case "gpu_wait":
      return "GPUサーバーの準備を待っています";
    case "initializing":
      return "GPUサーバーを準備しています";
    case "loading_model":
      return "音声認識を準備しています";
    case "transcribing_model":
      return "お手本音声を確認しています";
    case "transcribing_attempt":
      return "録音を確認しています";
    case "loading_seed_vc_model":
      return "お手本の声を調整する準備をしています";
    case "voice_conversion":
      return "お手本の声を調整しています";
    case "finalizing":
      return "比較結果を準備しています";
    case "complete":
      return "完了しました";
    case "failed":
      return "処理に失敗しました";
    default:
      if (state === "failed") return "処理に失敗しました";
      if (state === "succeeded") return "完了しました";
      if (state === "queued") return "GPUサーバーの準備を待っています";
      return "音声を処理しています";
  }
}

function clearPracticeJobStatus() {
  if (!jobStatus) {
    return;
  }
  jobStatus.hidden = true;
  jobStatus.dataset.state = "idle";
  jobStatus.dataset.stage = "";
  jobStatusLabel.textContent = "";
  jobStatusModel.textContent = "";
  jobStatusDetail.textContent = "";
}

function formatDurationMilliseconds(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.max(0, Math.round(milliseconds))}ms`;
  }
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}秒`;
}

function renderPromptResult(payload, { deferModelAudio = false } = {}) {
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
  if (deferModelAudio) {
    stopModelAudio();
  } else {
    setModelAudio(payload.audio_base64, payload.audio_mime_type || "audio/wav");
  }
  nativePanel.hidden = false;
  promptPanel.hidden = false;
  setActiveRecordSlot("repeat");
  stopRepeatAudio();
  currentRecognizedText = "";
  currentAttemptPayload = null;
  currentAttemptComparisonAlignment = null;
  currentModelComparisonAlignment = null;
  recognizedText.textContent = "";
  syncPracticeRecordMode();
  syncModelAudioSpeed();
  syncPlayButton();
  if (!deferModelAudio) {
    ensureAudioMetadata(modelAudio)
      .then(() => {
        return playAudioWithCurrentSpeed(modelAudio);
      })
      .catch(() => {});
  }
}

async function postPracticeForm(url, form) {
  try {
    const response = await fetch(url, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(apiErrorMessage(payload, `${url} failed: ${response.status}`));
    }
    return payload;
  } catch (error) {
    setBusy(false, "");
    throw error;
  }
}

function apiErrorMessage(payload, fallback) {
  if (typeof payload?.error?.message === "string" && payload.error.message) {
    return payload.error.message;
  }
  if (typeof payload?.detail === "string" && payload.detail) {
    return payload.detail;
  }
  if (typeof payload?.error === "string" && payload.error) {
    return payload.error;
  }
  return fallback;
}

function renderAttemptResult(payload) {
  stopComparisonPlayback();
  const noSpeech = payload.outcome === "no_speech";
  currentRecognizedText = noSpeech ? "" : (payload.recognized_text || "");
  currentAttemptPayload = payload;
  currentAttemptComparisonAlignment = payload.comparison_alignment || null;
  currentModelComparisonAlignment = payload.model_comparison_alignment || null;
  resultSummary.hidden = noSpeech;
  scoreBar.hidden = noSpeech;
  gradeGuide.hidden = noSpeech;
  if (noSpeech) {
    gradeBadge.textContent = "";
    gradeBadge.removeAttribute("data-grade");
    scoreText.textContent = "";
    scoreFill.style.width = "0%";
    recognizedText.textContent = payload.message || "音声を検出できませんでした。もう一度録音してください。";
  } else {
    const percent = Math.round(Number(payload.similarity || 0) * 100);
    const grade = renderPracticeGrade(percent);
    gradeBadge.textContent = grade.label;
    gradeBadge.dataset.grade = grade.key;
    scoreText.textContent = `${percent}%`;
    scoreFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    renderRecognizedDiff(payload);
  }
  nativePanel.hidden = false;
  resultPanel.hidden = false;
  setActiveRecordSlot("repeat");
  syncPracticeRecordMode();
  syncPlayButton();
}

function renderPracticeGrade(percent) {
  if (percent >= 100) {
    return { key: "perfect", label: "できました" };
  }
  if (percent >= 95) {
    return { key: "ok", label: "いいかんじ" };
  }
  if (percent >= 90) {
    return { key: "almost", label: "まあまあ" };
  }
  return { key: "retry", label: "もう一回" };
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
  currentAttemptPayload = null;
  currentAttemptComparisonAlignment = null;
  detectedNativeLanguage = "";
  activeRecordSlot = "native";
  nativePanel.hidden = false;
  promptPanel.hidden = true;
  resultPanel.hidden = true;
  nativeTranscriptPanel.hidden = true;
  nativeTranscript.textContent = "";
  recognizedText.textContent = "";
  stopRepeatAudio();
  renderNativeLabels();
  renderTargetDisplay();
  syncRecordSlotVisuals();
  syncPracticeRecordMode();
  setStatus("");
  clearPracticeJobStatus();
  clearError();
}

function setModelAudio(audioBase64, mimeType) {
  stopModelAudio();
  const blob = base64ToBlob(audioBase64, mimeType);
  currentModelAudioBlob = blob;
  modelAudioUrl = URL.createObjectURL(blob);
  modelAudio.src = modelAudioUrl;
  modelAudio.load();
  syncModelAudioSpeed();
  playModelButton.disabled = isBusy;
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
    playAudioWithCurrentSpeed(modelAudio).catch((error) => showError(error.message));
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
  currentModelAudioBlob = null;
  playModelButton.disabled = true;
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
  syncComparisonNote();
}

function syncComparisonNote() {
  const plan = currentComparisonPlaybackPlan();
  comparisonNote.textContent = plan.description;
  comparisonNote.dataset.mode = plan.mode;
  comparisonNote.hidden = !plan.description;
}

function playbackButtonLabel() {
  return currentComparisonPlaybackPlan().label;
}

function audioDurationOrAlignmentEnd(audio, alignment) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return Math.max(0, ...availableComparisonRanges(alignment).map((range) => Number(range.audio_end) || 0));
}

function currentComparisonPlaybackPlan() {
  return playbackContract.comparisonPlaybackPlan({
    modelReady: Boolean(modelAudio.src),
    repeatReady: Boolean(repeatAudio.src),
    resultVisible: !resultPanel.hidden,
    outcome: currentAttemptPayload?.outcome || "evaluated",
    recognizedLanguageMatches: recognizedTextMatchesLearningLanguage(currentRecognizedText, selectedTargetLanguage),
    attemptAlignment: currentAttemptComparisonAlignment,
    modelAlignment: currentModelComparisonAlignment,
    modelDuration: audioDurationOrAlignmentEnd(modelAudio, currentModelComparisonAlignment),
    repeatDuration: audioDurationOrAlignmentEnd(repeatAudio, currentAttemptComparisonAlignment),
  });
}

function syncModelAudioSpeed() {
  const speed = normalizedPlaybackSpeed(speedSlider.value);
  speedSlider.value = String(speed);
  speedValue.textContent = formatPlaybackSpeed(speed);
  [modelAudio, repeatAudio].forEach((audio) => {
    applyPlaybackSpeed(audio, speed);
  });
}

function applyPlaybackSpeed(audio, speed = normalizedPlaybackSpeed(speedSlider.value)) {
  audio.defaultPlaybackRate = speed;
  audio.playbackRate = speed;
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

async function selectChineseScript(script) {
  const nextScript = script === "traditional" ? "traditional" : "simplified";
  if (nextScript === "traditional") {
    try {
      await window.voiceLabChineseScript?.loadTraditional();
    } catch (_error) {
      showError("繁体字表示を読み込めませんでした。");
      return;
    }
  }
  selectedChineseScript = nextScript;
  syncChineseScriptControls();
  savePracticeSettings();
  renderTargetDisplay();
  if (currentAttemptPayload) {
    renderRecognizedDiff(currentAttemptPayload);
  }
}

function displayChineseText(text) {
  const sourceText = String(text || "");
  if (selectedTargetLanguage !== "zh-CN" || selectedChineseScript !== "traditional") {
    return sourceText;
  }
  return window.voiceLabChineseScript?.toTraditional(sourceText) || sourceText;
}

function renderTargetDisplay() {
  const displayText = displayChineseText(currentTargetDisplayText || currentTargetText || "");
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

function pausePlaybackForRecording() {
  stopComparisonPlayback();
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
    const plan = currentComparisonPlaybackPlan();
    if (plan.mode === "model") {
      await playAudioElementToEnd(modelAudio, token);
      return;
    }
    if (plan.mode === "whole" || !plan.ranges.length) {
      await playAudioElementToEnd(modelAudio, token);
      if (!isActiveComparisonPlayback(token)) {
        return;
      }
      await playAudioElementToEnd(repeatAudio, token);
      return;
    }
    for (const range of plan.ranges) {
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
  await ensureAudioMetadata(modelAudio);
  await playAudioWithCurrentSpeed(modelAudio);
}

async function playAudioWithCurrentSpeed(audio) {
  syncModelAudioSpeed();
  applyPlaybackSpeed(audio);
  const playPromise = audio.play();
  applyPlaybackSpeed(audio);
  await playPromise;
  applyPlaybackSpeed(audio);
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
    applyPlaybackSpeed(audio);
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    playAudioWithCurrentSpeed(audio).then(watch).catch(done);
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
      if (playbackContract.shouldStopAudioSegment({
        active: isActiveComparisonPlayback(token),
        ended: audio.ended,
        currentTime: audio.currentTime,
        segmentEnd,
      })) {
        done();
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    audio.pause();
    audio.currentTime = segmentStart;
    applyPlaybackSpeed(audio);
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    playAudioWithCurrentSpeed(audio).then(watch).catch(done);
  });
}

function availableComparisonRanges(alignment) {
  const entries = Array.isArray(alignment?.phrases)
    ? alignment.phrases
    : (Array.isArray(alignment?.ranges) ? alignment.ranges : []);
  return entries.filter((range) => {
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
  repeatRecordButton.disabled = busy || !currentTargetText;
  ownVoiceToggle.disabled = busy;
  playModelButton.disabled = busy || !modelAudio.src;
  const processingButton = buttonForRecordSlot(kind || activeRecordSlot);
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
  } else if (!busy) {
    setStatus("");
  }
  syncRecordSlotVisuals();
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

function setActiveRecordSlot(slot) {
  activeRecordSlot = slot === "repeat" && currentTargetText ? "repeat" : "native";
  syncRecordSlotVisuals();
}

function buttonForRecordSlot(slot) {
  return slot === "repeat" ? repeatRecordButton : nativeRecordButton;
}

function levelForRecordSlot(slot) {
  return slot === "repeat" ? repeatLevel : nativeLevel;
}

function syncRecordSlotVisuals() {
  const repeatAvailable = Boolean(currentTargetText) && !promptPanel.hidden;
  const activeRecordingKind = mediaRecorder?.state === "recording" ? recordingKind : "";
  repeatRecordButton.disabled = isBusy || !repeatAvailable || (Boolean(activeRecordingKind) && activeRecordingKind !== "repeat");
  nativeRecordButton.disabled = isBusy || (Boolean(activeRecordingKind) && activeRecordingKind !== "native");
  nativeCancelButton.hidden = activeRecordingKind !== "native";
  repeatCancelButton.hidden = activeRecordingKind !== "repeat";
  if (!repeatAvailable && activeRecordSlot === "repeat") {
    activeRecordSlot = "native";
  }
  const activeButton = buttonForRecordSlot(activeRecordSlot);
  [nativeRecordButton, repeatRecordButton].forEach((button) => {
    const forcedActive = button === activeButton || button.classList.contains("is-recording") || button.classList.contains("is-processing");
    button.classList.toggle("is-inactive", !forcedActive);
  });
}

function setRecordingVisual(slot, recording) {
  const button = buttonForRecordSlot(slot);
  setActiveRecordSlot(slot);
  button.classList.toggle("is-recording", recording);
  button.classList.remove("is-processing");
  if (recording) {
    recordingStartedAt = performance.now();
    button.setAttribute("aria-label", "録音中");
    startRecordTimer(button);
  } else {
    stopRecordTimer(button);
    syncPracticeRecordMode();
  }
  syncRecordSlotVisuals();
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
  [nativeLevel, repeatLevel].filter(Boolean).forEach((container) => {
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
  const rounded = Math.round(parsed / 0.1) * 0.1;
  return Math.max(0.5, Math.min(2, Number(rounded.toFixed(1))));
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
  statusText.hidden = !message;
  statusText.textContent = message;
}

function showError(message) {
  errorText.hidden = false;
  errorText.textContent = message;
}

function publicPracticeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/runpod|whisper|funasr|seed-vc|openai|billing|残高|job(?:_|\s)?id|job status|model_transcription|provider|backend/i.test(message)) {
    console.error("[SpeakLoop job] technical error", error);
    return "音声処理を完了できませんでした。しばらくしてからもう一度お試しください。";
  }
  return message || "音声処理を完了できませんでした。";
}

function clearError() {
  errorText.hidden = true;
  errorText.textContent = "";
}

function loadPracticeSettings() {
  const settings = readPracticeSettings();
  selectedTargetLanguage = selectablePracticeTargetLanguages.has(settings.target_language)
    ? settings.target_language
    : defaultPracticeTargetLanguage;
  pinyinToggle.checked = selectedTargetLanguage === "zh-CN" ? true : settings.show_pinyin !== false;
  selectedChineseScript = settings.chinese_script === "traditional" ? "traditional" : "simplified";
  ownVoiceToggle.checked = settings.own_voice === true;
  speedSlider.value = String(normalizedPlaybackSpeed(settings.speed));
  targetLanguageSelect.value = selectedTargetLanguage;
  syncPinyinSettingVisibility();
  syncChineseScriptControls();
  syncCurrentLanguageLabel();
  syncModelAudioSpeed();
  if (selectedChineseScript === "traditional") {
    window.voiceLabChineseScript?.loadTraditional()
      .then(() => {
        renderTargetDisplay();
        if (currentAttemptPayload) {
          renderRecognizedDiff(currentAttemptPayload);
        }
      })
      .catch(() => showError("繁体字表示を読み込めませんでした。"));
  }
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
        chinese_script: selectedChineseScript,
        own_voice: Boolean(ownVoiceToggle.checked),
        show_pinyin: Boolean(pinyinToggle.checked),
        speed: normalizedPlaybackSpeed(speedSlider.value),
      }),
    );
  } catch (_error) {
    // localStorageが使えないブラウザでは、現在の画面内状態だけで動かす。
  }
}

function practiceAsrModel() {
  return "whisper-1";
}

function syncPinyinSettingVisibility() {
  const hidden = selectedTargetLanguage !== "zh-CN";
  pinyinSetting.hidden = hidden;
  chineseScriptSetting.hidden = hidden;
}

function syncChineseScriptControls() {
  const traditional = selectedChineseScript === "traditional";
  chineseScriptToggle.dataset.script = traditional ? "traditional" : "simplified";
  simplifiedScriptButton.setAttribute("aria-pressed", String(!traditional));
  traditionalScriptButton.setAttribute("aria-pressed", String(traditional));
}

function handleChineseScriptKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const script = event.key === "ArrowLeft" ? "simplified" : "traditional";
  selectChineseScript(script).then(() => {
    (script === "traditional" ? traditionalScriptButton : simplifiedScriptButton).focus();
  });
}

function syncCurrentLanguageLabel() {
  targetLanguageSelect.value = selectablePracticeTargetLanguages.has(selectedTargetLanguage)
    ? selectedTargetLanguage
    : defaultPracticeTargetLanguage;
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
  recordTitle.textContent = "言いたいことを話す";
  nativeRecordButton.setAttribute("aria-label", "言いたいことを録音");
  repeatRecordButton.setAttribute("aria-label", "練習を録音");
  syncRecordSlotVisuals();
}

function renderRecognizedDiff(payload) {
  const target = practiceDisplayComparableText(payload.target_text || currentTargetText || "");
  const recognized = practiceDisplayComparableText(payload.recognized_text || "");
  const cells = compactPracticeDiffCells(buildPracticeDiffCells(target, recognized));
  const grid = document.createElement("span");
  grid.className = "practice-diff-grid";
  const heardForAccessibility = cells.map((cell) => cell.heard).join("");
  grid.setAttribute("aria-label", `聞こえた言葉: ${displayChineseText(heardForAccessibility || "聞き取れませんでした")}`);
  cells.forEach((cell) => grid.append(renderPracticeDiffCell(cell)));
  recognizedText.replaceChildren(grid);
}

function practiceDisplayComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function renderPracticeDiffCell(cell) {
  const element = document.createElement(cell.type === "equal" ? "span" : "button");
  if (element instanceof HTMLButtonElement) {
    element.type = "button";
    element.title = cell.type === "delete" ? "抜けた部分を比較再生" : "この違いを比較再生";
    element.addEventListener("click", playComparisonAudios);
  }
  element.className = `practice-diff-cell is-${cell.type}`;
  const correction = document.createElement("span");
  correction.className = "practice-diff-correction";
  correction.textContent = displayChineseText(cell.correction || "\u00a0");
  const heard = document.createElement("span");
  heard.className = "practice-diff-heard";
  heard.textContent = displayChineseText(cell.heard || "_");
  element.append(correction, heard);
  return element;
}

function buildPracticeDiffCells(targetTextValue, recognizedTextValue) {
  const targetChars = Array.from(targetTextValue || "");
  const recognizedChars = Array.from(recognizedTextValue || "");
  const rows = targetChars.length + 1;
  const columns = recognizedChars.length + 1;
  const distance = Array.from({ length: rows }, () => new Array(columns).fill(0));
  for (let targetIndex = targetChars.length; targetIndex >= 0; targetIndex -= 1) {
    distance[targetIndex][recognizedChars.length] = targetChars.length - targetIndex;
  }
  for (let recognizedIndex = recognizedChars.length; recognizedIndex >= 0; recognizedIndex -= 1) {
    distance[targetChars.length][recognizedIndex] = recognizedChars.length - recognizedIndex;
  }
  for (let targetIndex = targetChars.length - 1; targetIndex >= 0; targetIndex -= 1) {
    for (let recognizedIndex = recognizedChars.length - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
      if (practiceDisplayCharsEqual(targetChars[targetIndex], recognizedChars[recognizedIndex])) {
        distance[targetIndex][recognizedIndex] = distance[targetIndex + 1][recognizedIndex + 1];
      } else {
        distance[targetIndex][recognizedIndex] = 1 + Math.min(
          distance[targetIndex + 1][recognizedIndex + 1],
          distance[targetIndex + 1][recognizedIndex],
          distance[targetIndex][recognizedIndex + 1],
        );
      }
    }
  }

  const cells = [];
  let targetIndex = 0;
  let recognizedIndex = 0;
  while (targetIndex < targetChars.length || recognizedIndex < recognizedChars.length) {
    const targetChar = targetChars[targetIndex];
    const recognizedChar = recognizedChars[recognizedIndex];
    if (
      targetIndex < targetChars.length &&
      recognizedIndex < recognizedChars.length &&
      practiceDisplayCharsEqual(targetChar, recognizedChar)
    ) {
      cells.push({ type: "equal", correction: "", heard: recognizedChar });
      targetIndex += 1;
      recognizedIndex += 1;
      continue;
    }
    const currentDistance = distance[targetIndex][recognizedIndex];
    if (
      targetIndex < targetChars.length &&
      recognizedIndex < recognizedChars.length &&
      currentDistance === 1 + distance[targetIndex + 1][recognizedIndex + 1]
    ) {
      cells.push({ type: "substitute", correction: targetChar, heard: recognizedChar });
      targetIndex += 1;
      recognizedIndex += 1;
      continue;
    }
    if (
      targetIndex < targetChars.length &&
      currentDistance === 1 + distance[targetIndex + 1][recognizedIndex]
    ) {
      cells.push({ type: "delete", correction: targetChar, heard: "_" });
      targetIndex += 1;
      continue;
    }
    cells.push({ type: "insert", correction: "", heard: recognizedChar || "_" });
    recognizedIndex += 1;
  }
  return cells.length ? cells : [{ type: "insert", correction: "", heard: "（聞き取れませんでした）" }];
}

function compactPracticeDiffCells(cells) {
  const compacted = [];
  cells.forEach((cell) => {
    const previous = compacted[compacted.length - 1];
    if (previous && previous.type === "equal" && cell.type === "equal") {
      previous.heard += cell.heard;
      return;
    }
    compacted.push({ ...cell });
  });
  return compacted;
}

function practiceDisplayCharsEqual(left, right) {
  const normalizedLeft = String(left || "").normalize("NFKC").toLocaleLowerCase();
  const normalizedRight = String(right || "").normalize("NFKC").toLocaleLowerCase();
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  const punctuationPairs = new Set(["?？", "？?", "!！", "！!", ",，", "，,", ".。", "。."]);
  return punctuationPairs.has(`${left || ""}${right || ""}`);
}

loadPracticeSettings();
resetPractice();
