const form = document.querySelector("#translation-form");
const audioInput = document.querySelector("#audio");
const audioLabel = document.querySelector("#audio-label");
const sourceAudioHint = document.querySelector("#source-audio-hint");
const referenceAudioInput = document.querySelector("#reference_audio");
const operationModeSelect = document.querySelector("#operation_mode");
const voiceBackendSelect = document.querySelector("#voice_backend");
const voiceBackendHint = document.querySelector("#voice-backend-hint");
const audioDeviceSelect = document.querySelector("#audio_device");
const audioDeviceRefreshButton = document.querySelector("#audio-device-refresh");
const recordButton = document.querySelector("#record-button");
const stopButton = document.querySelector("#stop-button");
const recordingLabel = document.querySelector("#recording-label");
const statusLabel = document.querySelector("#status");
const submitButton = document.querySelector("#submit-button");
const outputAudio = document.querySelector("#output-audio");
const inputAudio = document.querySelector("#input-audio");
const inputLevel = document.querySelector("#input-level");
const recordingDetails = document.querySelector("#recording-details");
const routeHint = document.querySelector("#route-hint");
const voiceModeHint = document.querySelector("#voice-mode-hint");
const errorMessage = document.querySelector("#error-message");
const runtimeMode = document.querySelector("#runtime-mode");
const runtimeNote = document.querySelector("#runtime-note");
const runtimeProviders = document.querySelector("#runtime-providers");
const processingPanel = document.querySelector("#processing-panel");
const processingCurrent = document.querySelector("#processing-current");
const processingSteps = document.querySelector("#processing-steps");
const textResultSection = document.querySelector("#text-result-section");
const outputAudioHeading = document.querySelector("#output-audio-heading");
const translationOnlyElements = [...document.querySelectorAll(".translation-only")];

const supportedRoutes = {
  "id-ID": [{ value: "ja-JP", label: "日本語" }],
  "ja-JP": [{ value: "zh-CN", label: "中国語（普通話）" }],
};

const voiceModeLabels = {
  clone: "Qwenで直接声寄せ",
  convert: "Qwen生成後にSeed-VC変換",
};

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedFileName = "recording.audio";
let inputAudioObjectUrl = null;
let outputAudioObjectUrl = null;
let inputLevelAnimation = null;
let inputLevelAudioContext = null;
let inputLevelSource = null;
let supportedVoiceModes = ["convert", "clone"];
let voiceConversionBackends = [];
let runtimeProviderMode = "fake";

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
audioDeviceRefreshButton.addEventListener("click", loadAudioDevices);
audioInput.addEventListener("change", handleAudioFileChange);
operationModeSelect.addEventListener("change", () => {
  syncOperationMode();
  clearResultOutputs();
});
voiceBackendSelect.addEventListener("change", syncVoiceBackendHint);
form.source_language.addEventListener("change", syncTargetOptions);
form.target_language.addEventListener("change", syncVoiceModeHint);
form.voice_mode.addEventListener("change", syncVoiceModeHint);
form.addEventListener("submit", submitCurrentOperation);
syncTargetOptions();
syncVoiceModeAvailability();
syncOperationMode();
loadRuntime();
loadAudioDevices();

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("このブラウザでは録音できません", "error");
    return;
  }
  if (!window.MediaRecorder) {
    setStatus("このブラウザでは録音できません", "error");
    return;
  }

  let stream = null;
  try {
    clearError();
    stream = await navigator.mediaDevices.getUserMedia({ audio: selectedAudioConstraint() });
    loadAudioDevices();
  } catch (error) {
    renderError(error.message || "マイク入力を開始できませんでした");
    return;
  }
  audioInput.value = "";
  recordedChunks = [];
  recordedBlob = null;
  recordedFileName = "recording.audio";
  clearInputAudioPreview();
  recordingDetails.textContent = "録音中";
  startInputLevelMeter(stream);
  mediaRecorder = new MediaRecorder(stream, chooseRecorderOptions());

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  });

  mediaRecorder.addEventListener("stop", () => {
    const mimeType = mediaRecorder.mimeType || recordedChunks[0]?.type || "audio/webm";
    recordedBlob = new Blob(recordedChunks, { type: mimeType });
    recordedFileName = `recording.${extensionForMimeType(mimeType)}`;
    stopInputLevelMeter();
    if (recordedBlob.size < 1024) {
      recordedBlob = null;
      recordingDetails.textContent = "録音データが小さすぎます。マイク入力を確認してください。";
      stream.getTracks().forEach((track) => track.stop());
      recordingLabel.textContent = "録音失敗";
      recordButton.disabled = false;
      stopButton.disabled = true;
      setStatus("エラー", "error");
      return;
    }
    renderInputAudioPreview(recordedBlob);
    stream.getTracks().forEach((track) => track.stop());
    recordingLabel.textContent = "録音済み";
    recordButton.disabled = false;
    stopButton.disabled = true;
    setStatus("待機中");
  });

  mediaRecorder.start();
  recordingLabel.textContent = "録音中";
  recordButton.disabled = true;
  stopButton.disabled = false;
  setStatus("録音中");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    if (mediaRecorder.state === "recording" && typeof mediaRecorder.requestData === "function") {
      mediaRecorder.requestData();
    }
    mediaRecorder.stop();
  }
}

function handleAudioFileChange() {
  const file = audioInput.files[0];
  recordedBlob = null;
  recordedChunks = [];
  recordedFileName = "recording.audio";
  stopInputLevelMeter();
  if (file) {
    recordingLabel.textContent = "ファイル選択済み";
    renderInputAudioPreview(file);
    return;
  }
  recordingLabel.textContent = "録音なし";
  recordingDetails.textContent = sourceAudioEmptyText();
  clearInputAudioPreview();
}

async function submitCurrentOperation(event) {
  if (operationModeSelect.value === "voice_conversion") {
    await submitVoiceConversion(event);
    return;
  }
  await submitTranslation(event);
}

async function submitTranslation(event) {
  event.preventDefault();
  setStatus("処理中");
  renderPartialResult({});
  renderProcessingJob({ status: "queued", stages: [] });
  clearError();
  submitButton.disabled = true;

  try {
    const formData = new FormData();
    formData.append("source_language", form.source_language.value);
    formData.append("target_language", form.target_language.value);
    formData.append("voice_mode", selectedVoiceMode());

    const enableSuffix = document.querySelector("#enable_suffix").checked;
    if (enableSuffix) {
      formData.append("text_transform", "append_suffix");
      formData.append("text_transform_suffix", form.suffix.value);
      formData.append("text_transform_unit", form.suffix_unit.value);
    }

    const file = audioInput.files[0];
    if (file) {
      if (file.size < 1) {
        throw new Error("音声ファイルが空です");
      }
      formData.append("audio", file);
    } else if (recordedBlob) {
      formData.append("audio", recordedBlob, recordedFileName);
    } else {
      throw new Error("音声ファイルを選択するか録音してください");
    }

    const response = await fetch("/api/translate-speech-jobs", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "変換に失敗しました");
    }

    const job = await response.json();
    renderProcessingJob(job);
    const completedJob = await pollTranslationJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("変換結果を取得できませんでした");
    }
    renderResult(completedJob.result);
    setStatus("完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
}

async function submitVoiceConversion(event) {
  event.preventDefault();
  setStatus("処理中");
  renderPartialResult({});
  renderProcessingJob({ status: "queued", stages: [] });
  clearError();
  submitButton.disabled = true;

  try {
    const sourceFile = audioInput.files[0];
    const referenceFile = referenceAudioInput.files[0];
    const formData = new FormData();
    formData.append("voice_backend", selectedVoiceBackend());
    if (sourceFile) {
      if (sourceFile.size < 1) {
        throw new Error("変換元音声ファイルが空です");
      }
      formData.append("source_audio", sourceFile);
    } else if (recordedBlob) {
      formData.append("source_audio", recordedBlob, recordedFileName);
    } else {
      throw new Error("変換元音声ファイルを選択するか録音してください");
    }
    if (!referenceFile || referenceFile.size < 1) {
      throw new Error("参照音声ファイルを選択してください");
    }
    formData.append("reference_audio", referenceFile);

    const response = await fetch("/api/voice-conversion-jobs", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "VCに失敗しました");
    }

    const job = await response.json();
    renderProcessingJob(job);
    const completedJob = await pollVoiceConversionJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("VC結果を取得できませんでした");
    }
    renderVoiceConversionResult(completedJob.result);
    setStatus("完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
}

async function pollTranslationJob(jobId) {
  while (true) {
    await delay(800);
    const response = await fetch(`/api/translate-speech-jobs/${jobId}`);
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "処理状況を取得できませんでした");
    }
    const job = await response.json();
    renderProcessingJob(job);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "変換に失敗しました");
    }
  }
}

async function pollVoiceConversionJob(jobId) {
  while (true) {
    await delay(800);
    const response = await fetch(`/api/voice-conversion-jobs/${jobId}`);
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "処理状況を取得できませんでした");
    }
    const job = await response.json();
    renderProcessingJob(job);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "VCに失敗しました");
    }
  }
}

function renderProcessingJob(job) {
  processingPanel.hidden = false;
  renderPartialResult(job.partial_result || {});
  const currentStage = job.current_stage || null;
  const currentText = processingCurrentText(job.status, currentStage);
  processingCurrent.textContent = currentText;
  if (job.status === "running" && currentStage) {
    setStatus(`処理中: ${currentStage.label}`);
  }
  processingSteps.replaceChildren();
  const stages = job.stages || [];
  const activeIndex = stages.findIndex((stage) => currentStage && stage.stage === currentStage.stage);
  stages.forEach((stage, index) => {
    const item = document.createElement("li");
    item.dataset.state = processingStepState(job.status, index, activeIndex);
    const label = document.createElement("span");
    label.textContent = stage.label;
    const provider = document.createElement("strong");
    provider.textContent = stage.provider;
    item.append(label, provider);
    processingSteps.append(item);
  });
}

function processingCurrentText(status, currentStage) {
  if (status === "queued") {
    return "待機中";
  }
  if (status === "succeeded") {
    return "完了";
  }
  if (status === "failed") {
    return "失敗";
  }
  if (!currentStage) {
    return "準備中";
  }
  return `${currentStage.label}: ${currentStage.provider}`;
}

function processingStepState(status, index, activeIndex) {
  if (status === "succeeded") {
    return "done";
  }
  if (index === activeIndex) {
    return "active";
  }
  if (activeIndex >= 0 && index < activeIndex) {
    return "done";
  }
  return "pending";
}

function renderResult(payload) {
  renderPartialResult(payload);

  const audioBytes = base64ToBytes(payload.audio_base64);
  const audioBlob = new Blob([audioBytes], { type: payload.audio_mime_type || "audio/wav" });
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
  }
  outputAudioObjectUrl = URL.createObjectURL(audioBlob);
  outputAudio.src = outputAudioObjectUrl;

  const timings = document.querySelector("#timings");
  renderKeyValueList(timings, payload.timings_ms || {}, (value) => `${Number(value).toFixed(1)} ms`);

  const providers = document.querySelector("#providers");
  renderKeyValueList(providers, payload.providers || {}, (value) => String(value));

  const warnings = document.querySelector("#warnings");
  warnings.replaceChildren();
  (payload.warnings || []).forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    warnings.append(item);
  });
}

function renderVoiceConversionResult(payload) {
  renderPartialResult({});

  const audioBytes = base64ToBytes(payload.audio_base64);
  const audioBlob = new Blob([audioBytes], { type: payload.audio_mime_type || "audio/wav" });
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
  }
  outputAudioObjectUrl = URL.createObjectURL(audioBlob);
  outputAudio.src = outputAudioObjectUrl;

  const timings = document.querySelector("#timings");
  renderKeyValueList(timings, payload.timings_ms || {}, (value) => `${Number(value).toFixed(1)} ms`);

  const providers = document.querySelector("#providers");
  renderKeyValueList(providers, payload.providers || {}, (value) => String(value));

  const warnings = document.querySelector("#warnings");
  warnings.replaceChildren();
  (payload.warnings || []).forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    warnings.append(item);
  });
}

function renderPartialResult(payload) {
  setText("#transcript", payload.transcript);
  setText("#translated-text", payload.translated_text);
  setText("#transformed-text", payload.transformed_text);
}

async function loadRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) {
      throw new Error("runtime request failed");
    }
    renderRuntime(await response.json());
  } catch {
    runtimeMode.textContent = "不明";
    runtimeNote.textContent = "実行モードを取得できませんでした。";
    runtimeProviders.replaceChildren();
    supportedVoiceModes = ["default"];
    syncVoiceModeAvailability();
  }
}

function renderRuntime(payload) {
  const providerMode = payload.provider_mode || "fake";
  runtimeMode.textContent = providerMode;
  runtimeMode.dataset.mode = providerMode;
  runtimeProviderMode = providerMode;
  supportedVoiceModes = payload.supported_voice_modes || ["default"];
  voiceConversionBackends = payload.voice_conversion_backends || [];
  syncVoiceModeAvailability();
  syncVoiceBackendAvailability();
  syncRuntimeNote();
  runtimeProviders.replaceChildren();
  Object.entries(payload.providers || {}).forEach(([key, value]) => {
    const term = document.createElement("dt");
    term.textContent = key;
    const description = document.createElement("dd");
    description.textContent = String(value);
    runtimeProviders.append(term, description);
  });
}

async function loadAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    audioDeviceSelect.replaceChildren(new Option("このブラウザでは選択できません", ""));
    audioDeviceSelect.disabled = true;
    audioDeviceRefreshButton.disabled = true;
    return;
  }

  try {
    const previousValue = audioDeviceSelect.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === "audioinput");
    const options = [new Option("既定のマイク", "")];
    audioInputs.forEach((device, index) => {
      const label = device.label || `マイク ${index + 1}`;
      options.push(new Option(label, device.deviceId));
    });
    audioDeviceSelect.replaceChildren(...options);
    if ([...audioDeviceSelect.options].some((option) => option.value === previousValue)) {
      audioDeviceSelect.value = previousValue;
    }
    audioDeviceSelect.disabled = audioInputs.length === 0;
  } catch {
    audioDeviceSelect.replaceChildren(new Option("マイク一覧を取得できません", ""));
    audioDeviceSelect.disabled = true;
  }
}

function selectedAudioConstraint() {
  if (!audioDeviceSelect.value) {
    return true;
  }
  return { deviceId: { exact: audioDeviceSelect.value } };
}

function renderInputAudioPreview(blob) {
  if (inputAudioObjectUrl) {
    URL.revokeObjectURL(inputAudioObjectUrl);
  }
  inputAudioObjectUrl = URL.createObjectURL(blob);
  inputAudio.src = inputAudioObjectUrl;
  inputAudio.hidden = false;
  recordingDetails.textContent = `${blob.type || "unknown"} / ${formatBytes(blob.size)}`;
}

function clearInputAudioPreview() {
  if (inputAudioObjectUrl) {
    URL.revokeObjectURL(inputAudioObjectUrl);
    inputAudioObjectUrl = null;
  }
  inputAudio.removeAttribute("src");
  inputAudio.hidden = true;
  inputLevel.value = 0;
}

function chooseRecorderOptions() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) {
    return {};
  }
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? { mimeType } : {};
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  if (mimeType.includes("webm")) {
    return "webm";
  }
  return "audio";
}

function startInputLevelMeter(stream) {
  stopInputLevelMeter();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  inputLevelAudioContext = new AudioContextClass();
  const analyser = inputLevelAudioContext.createAnalyser();
  analyser.fftSize = 512;
  inputLevelSource = inputLevelAudioContext.createMediaStreamSource(stream);
  inputLevelSource.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  const updateLevel = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    inputLevel.value = Math.min(1, Math.sqrt(sum / samples.length) * 4);
    inputLevelAnimation = requestAnimationFrame(updateLevel);
  };

  updateLevel();
}

function stopInputLevelMeter() {
  if (inputLevelAnimation !== null) {
    cancelAnimationFrame(inputLevelAnimation);
    inputLevelAnimation = null;
  }
  if (inputLevelSource) {
    inputLevelSource.disconnect();
    inputLevelSource = null;
  }
  if (inputLevelAudioContext) {
    inputLevelAudioContext.close();
    inputLevelAudioContext = null;
  }
  inputLevel.value = 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function renderKeyValueList(list, entries, formatValue) {
  list.replaceChildren();
  Object.entries(entries).forEach(([key, value]) => {
    const term = document.createElement("dt");
    term.textContent = key;
    const description = document.createElement("dd");
    description.textContent = formatValue(value);
    list.append(term, description);
  });
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  element.textContent = value || "未実行";
  element.classList.toggle("empty", !value);
}

function setStatus(message, state = "normal") {
  statusLabel.textContent = message;
  statusLabel.dataset.state = state;
}

function renderError(message) {
  setStatus("エラー", "error");
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

function syncTargetOptions() {
  const targets = supportedRoutes[form.source_language.value] || [];
  form.target_language.replaceChildren(
    ...targets.map((target) => {
      const option = document.createElement("option");
      option.value = target.value;
      option.textContent = target.label;
      return option;
    }),
  );
  const routeText = `${form.source_language.selectedOptions[0].textContent} -> ${
    form.target_language.selectedOptions[0]?.textContent || "未対応"
  }`;
  routeHint.textContent = routeText;
  syncVoiceModeAvailability();
}

function syncOperationMode() {
  const isVoiceConversion = operationModeSelect.value === "voice_conversion";
  document.querySelectorAll(".vc-only").forEach((element) => {
    element.hidden = !isVoiceConversion;
  });
  translationOnlyElements.forEach((element) => {
    element.hidden = isVoiceConversion;
  });
  audioLabel.textContent = isVoiceConversion ? "変換元音声ファイル" : "入力音声ファイル";
  sourceAudioHint.textContent = isVoiceConversion
    ? "録音またはファイル選択で変換元音声を指定します。"
    : "録音またはファイル選択で入力音声を指定します。";
  outputAudioHeading.textContent = isVoiceConversion ? "VC出力音声" : "出力音声";
  submitButton.textContent = isVoiceConversion ? "VC実行" : "変換";
  if (!audioInput.files[0] && !recordedBlob) {
    recordingDetails.textContent = sourceAudioEmptyText();
  }
  textResultSection.hidden = isVoiceConversion;
  syncRuntimeNote();
  syncVoiceBackendAvailability();
  syncVoiceModeHint();
}

function syncRuntimeNote() {
  if (operationModeSelect.value === "voice_conversion") {
    runtimeNote.textContent = "変換元音声と参照音声をVC backendで処理します。";
    return;
  }
  runtimeNote.textContent =
    runtimeProviderMode === "local"
      ? "録音または選択した音声を実際に処理します。"
      : "入力音声の内容に関係なく固定のデモ応答を返します。";
}

function syncVoiceModeHint() {
  if (operationModeSelect.value === "voice_conversion") {
    voiceModeHint.textContent = "";
    return;
  }
  const route = `${form.source_language.value}->${form.target_language.value}`;
  const voiceMode = form.voice_mode.value;
  if (!supportedVoiceModes.some((mode) => mode !== "default")) {
    voiceModeHint.textContent = "現在のTTS providerでは声寄せは使えません。";
    return;
  }
  if (route === "id-ID->ja-JP") {
    voiceModeHint.textContent =
      voiceMode === "convert"
        ? "Qwenで音声生成後、Seed-VCで入力音声の声質へ変換します。"
        : "Qwenが参照音声を使い、出力音声を直接生成します。";
    return;
  }
  if (route === "ja-JP->zh-CN") {
    voiceModeHint.textContent =
      voiceMode === "convert"
        ? "Qwen生成後にSeed-VC変換します。"
        : "Qwenで直接声を寄せて生成します。";
    return;
  }
  voiceModeHint.textContent = "";
}

function syncVoiceBackendAvailability() {
  if (!voiceBackendSelect) {
    return;
  }
  const fallbackBackends =
    voiceConversionBackends.length > 0
      ? voiceConversionBackends
      : [{ id: "seed-vc", label: "Seed-VC", provider: "Plachta/Seed-VC", available: true, reason: "" }];
  const currentValue = voiceBackendSelect.value;
  voiceBackendSelect.replaceChildren(
    ...fallbackBackends.map((backend) => {
      const label = backend.available ? backend.label : `${backend.label}（未導入）`;
      const option = new Option(label, backend.id);
      option.disabled = !backend.available;
      option.dataset.reason = backend.reason || "";
      option.dataset.provider = backend.provider || "";
      return option;
    }),
  );
  const availableBackends = fallbackBackends.filter((backend) => backend.available);
  if (availableBackends.length === 0) {
    voiceBackendSelect.disabled = true;
  } else {
    voiceBackendSelect.disabled = false;
    if (availableBackends.some((backend) => backend.id === currentValue)) {
      voiceBackendSelect.value = currentValue;
    } else {
      voiceBackendSelect.value = availableBackends[0].id;
    }
  }
  syncVoiceBackendHint();
}

function syncVoiceBackendHint() {
  if (!voiceBackendHint) {
    return;
  }
  const selected = [...voiceBackendSelect.options].find((option) => option.value === voiceBackendSelect.value);
  if (!selected) {
    voiceBackendHint.textContent = "利用できるVC backendがありません。";
    return;
  }
  const reason = selected.dataset.reason;
  const provider = selected.dataset.provider;
  voiceBackendHint.textContent = reason || provider || "";
}

function syncVoiceModeAvailability() {
  const selectableModes = supportedVoiceModes.filter((mode) => mode !== "default");
  if (selectableModes.length === 0) {
    form.voice_mode.replaceChildren(new Option("声寄せなし", "default"));
    form.voice_mode.disabled = true;
    syncVoiceModeHint();
    return;
  }

  form.voice_mode.disabled = false;
  form.voice_mode.replaceChildren(
    ...selectableModes.map((mode) => new Option(voiceModeLabels[mode] || mode, mode)),
  );
  const preferred = preferredVoiceMode(selectableModes);
  form.voice_mode.value = preferred;
  syncVoiceModeHint();
}

function preferredVoiceMode(selectableModes) {
  if (selectableModes.includes("convert")) {
    return "convert";
  }
  if (selectableModes.includes(form.voice_mode.value)) {
    return form.voice_mode.value;
  }
  return selectableModes[0];
}

function selectedVoiceMode() {
  const selectableModes = supportedVoiceModes.filter((mode) => mode !== "default");
  if (selectableModes.length === 0) {
    return "default";
  }
  return form.voice_mode.value || preferredVoiceMode(selectableModes);
}

function selectedVoiceBackend() {
  const selected = [...voiceBackendSelect.options].find((option) => option.value === voiceBackendSelect.value);
  if (!selected || selected.disabled) {
    throw new Error("利用可能なVC backendを選択してください");
  }
  return selected.value;
}

function sourceAudioEmptyText() {
  return operationModeSelect.value === "voice_conversion" ? "変換元音声なし" : "入力音声なし";
}

function clearResultOutputs() {
  renderPartialResult({});
  processingPanel.hidden = true;
  processingCurrent.textContent = "待機中";
  processingSteps.replaceChildren();
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
    outputAudioObjectUrl = null;
  }
  outputAudio.removeAttribute("src");
  document.querySelector("#timings").replaceChildren();
  document.querySelector("#providers").replaceChildren();
  document.querySelector("#warnings").replaceChildren();
  clearError();
  setStatus("待機中");
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
