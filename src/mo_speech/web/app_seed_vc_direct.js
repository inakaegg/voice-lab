const seedVcForm = document.querySelector("#seed-vc-form");
const seedVcStatus = document.querySelector("#seed-vc-status");
const sourceAudioInput = document.querySelector("#seed-vc-source-audio");
const sourceAudioStatus = document.querySelector("#seed-vc-source-status");
const audioDeviceSelect = document.querySelector("#seed-vc-audio-device");
const audioDeviceRefreshButton = document.querySelector("#seed-vc-audio-device-refresh");
const recordButton = document.querySelector("#seed-vc-record-button");
const stopButton = document.querySelector("#seed-vc-stop-button");
const recordingLabel = document.querySelector("#seed-vc-recording-label");
const inputLevel = document.querySelector("#seed-vc-input-level");
const recordingDetails = document.querySelector("#seed-vc-recording-details");
const inputAudio = document.querySelector("#seed-vc-input-audio");
const referenceAudioInput = document.querySelector("#seed-vc-reference-audio");
const referenceAudioStatus = document.querySelector("#seed-vc-reference-status");
const seedVcPresetSelect = document.querySelector("#seed_vc_preset");
const seedVcDiffusionStepsInput = document.querySelector("#seed_vc_diffusion_steps");
const seedVcReferenceMaxSecondsInput = document.querySelector("#seed_vc_reference_max_seconds");
const seedVcReferenceAutoSelectInput = document.querySelector("#seed_vc_reference_auto_select");
const seedVcLengthAdjustInput = document.querySelector("#seed_vc_length_adjust");
const seedVcInferenceCfgRateInput = document.querySelector("#seed_vc_inference_cfg_rate");
const seedVcReferencePreviewButton = document.querySelector("#seed-vc-reference-preview-button");
const seedVcSubmitButton = document.querySelector("#seed-vc-submit-button");
const seedVcErrorMessage = document.querySelector("#seed-vc-error-message");
const processingPanel = document.querySelector("#seed-vc-processing-panel");
const processingCurrent = document.querySelector("#seed-vc-processing-current");
const processingSteps = document.querySelector("#seed-vc-processing-steps");
const referencePreviewSection = document.querySelector("#reference-preview-section");
const referencePreviewOriginalAudio = document.querySelector("#reference-preview-original");
const referencePreviewNormalizedAudio = document.querySelector("#reference-preview-normalized");
const referencePreviewTimings = document.querySelector("#reference-preview-timings");
const outputAudio = document.querySelector("#seed-vc-output-audio");
const downloadLink = document.querySelector("#seed-vc-download");
const timingsList = document.querySelector("#seed-vc-timings");
const providersList = document.querySelector("#seed-vc-providers");
const warningsList = document.querySelector("#seed-vc-warnings");
const seedVcRangeInputs = Array.from(document.querySelectorAll("[data-seed-vc-range]"));

let outputObjectUrl = null;
let referencePreviewOriginalObjectUrl = null;
let referencePreviewNormalizedObjectUrl = null;
let inputAudioObjectUrl = null;
let seedVcAvailable = true;
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedFileName = "recording.audio";
let inputLevelAudioContext = null;
let inputLevelSource = null;
let inputLevelAnimationFrame = null;

sourceAudioInput.addEventListener("change", handleSourceAudioFileChange);
audioDeviceRefreshButton.addEventListener("click", loadAudioDevices);
recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
referenceAudioInput.addEventListener("change", () => {
  renderSelectedFileStatus(referenceAudioInput, referenceAudioStatus, "参照音声なし");
  clearReferencePreview();
});
seedVcForm.addEventListener("submit", submitSeedVcConversion);
seedVcReferencePreviewButton.addEventListener("click", previewSeedVcReferenceAudio);
seedVcPresetSelect.addEventListener("change", applySeedVcPreset);
[seedVcDiffusionStepsInput, seedVcReferenceMaxSecondsInput, seedVcLengthAdjustInput, seedVcInferenceCfgRateInput].forEach(
  (input) => {
    input.addEventListener("input", () => {
      renderSeedVcRangeValue(input);
      syncSeedVcPresetSelection();
    });
  },
);
seedVcRangeInputs.forEach(renderSeedVcRangeValue);

applySeedVcPreset();
loadAudioDevices();
loadRuntime();

async function loadRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) {
      throw new Error("runtime API error");
    }
    const runtime = await response.json();
    const seedVcBackend = (runtime.voice_conversion_backends || []).find((backend) => backend.id === "seed-vc");
    if (seedVcBackend?.settings?.seed_vc) {
      applyRuntimeSeedVcDefaults(seedVcBackend.settings.seed_vc);
    }
    seedVcAvailable = seedVcBackend ? Boolean(seedVcBackend.available) : true;
    seedVcSubmitButton.disabled = !seedVcAvailable;
    seedVcStatus.textContent = seedVcAvailable ? "待機中" : seedVcBackend?.reason || "Seed-VC利用不可";
  } catch (_error) {
    seedVcAvailable = true;
    seedVcStatus.textContent = "待機中";
  }
}

async function submitSeedVcConversion(event) {
  event.preventDefault();
  clearError();
  clearResult();
  if (!seedVcAvailable) {
    renderError("Seed-VCが利用できません");
    return;
  }
  seedVcSubmitButton.disabled = true;
  seedVcStatus.textContent = "送信中";
  renderProcessingJob({ status: "queued", stages: [] });

  try {
    const referenceFile = requireSelectedAudio(referenceAudioInput, "参照音声を選択してください");
    const formData = new FormData();
    formData.append("voice_backend", "seed-vc");
    appendSelectedSourceAudio(formData);
    formData.append("reference_audio", referenceFile, referenceFile.name || "reference.audio");
    appendSeedVcSettings(formData);

    const response = await fetch("/api/voice-conversion-jobs", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "Seed-VC変換に失敗しました");
    }

    const job = await response.json();
    renderProcessingJob(job);
    const completedJob = await pollVoiceConversionJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("Seed-VC変換結果を取得できませんでした");
    }
    renderSeedVcResult(completedJob.result);
    seedVcStatus.textContent = "完了";
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    seedVcSubmitButton.disabled = !seedVcAvailable;
  }
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    renderError("このブラウザでは録音できません");
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

  sourceAudioInput.value = "";
  recordedChunks = [];
  recordedBlob = null;
  recordedFileName = "recording.audio";
  clearInputAudioPreview();
  clearSourceAudioStatus("録音中");
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
    stream.getTracks().forEach((track) => track.stop());
    recordButton.disabled = false;
    stopButton.disabled = true;

    if (recordedBlob.size < 1024) {
      recordedBlob = null;
      recordingLabel.textContent = "録音失敗";
      recordingDetails.textContent = "録音データが小さすぎます。マイク入力を確認してください。";
      clearSourceAudioStatus("録音失敗");
      renderError("録音データが小さすぎます。マイク入力を確認してください。");
      return;
    }

    renderInputAudioPreview(recordedBlob, recordedFileName);
    setSourceAudioStatus("録音済み", recordedBlob, recordedFileName);
    recordingLabel.textContent = "録音済み";
    seedVcStatus.textContent = "待機中";
  });

  mediaRecorder.start();
  recordingLabel.textContent = "録音中";
  recordButton.disabled = true;
  stopButton.disabled = false;
  seedVcStatus.textContent = "録音中";
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

function handleSourceAudioFileChange() {
  const file = sourceAudioInput.files[0];
  recordedBlob = null;
  recordedChunks = [];
  recordedFileName = "recording.audio";
  stopInputLevelMeter();
  if (file) {
    recordingLabel.textContent = "ファイル選択済み";
    renderInputAudioPreview(file, file.name);
    setSourceAudioStatus("ファイル選択", file, file.name);
    return;
  }
  recordingLabel.textContent = "録音なし";
  recordingDetails.textContent = "変換元音声なし";
  clearInputAudioPreview();
  clearSourceAudioStatus("変換元音声なし");
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
      options.push(new Option(device.label || `マイク ${index + 1}`, device.deviceId));
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

function appendSelectedSourceAudio(formData) {
  const sourceFile = sourceAudioInput.files[0];
  if (sourceFile) {
    requireSelectedAudio(sourceAudioInput, "変換元音声を選択してください");
    formData.append("source_audio", sourceFile, sourceFile.name || "source.audio");
    return;
  }
  if (recordedBlob && recordedBlob.size >= 1) {
    formData.append("source_audio", recordedBlob, recordedFileName);
    return;
  }
  throw new Error("変換元音声を選択するか録音してください");
}

async function previewSeedVcReferenceAudio(event) {
  event.preventDefault();
  clearError();
  seedVcReferencePreviewButton.disabled = true;
  seedVcStatus.textContent = "参照音声準備中";

  try {
    const referenceFile = requireSelectedAudio(referenceAudioInput, "参照音声を選択してください");
    const formData = new FormData();
    formData.append("reference_audio", referenceFile, referenceFile.name || "reference.audio");
    appendSeedVcSettings(formData);

    const response = await fetch("/api/seed-vc/reference-preview", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "参照音声の確認に失敗しました");
    }
    renderReferencePreview(referenceFile, await response.json());
    seedVcStatus.textContent = "参照音声確認完了";
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    seedVcReferencePreviewButton.disabled = false;
  }
}

async function pollVoiceConversionJob(jobId) {
  while (true) {
    await delay(800);
    const response = await fetch(`/api/voice-conversion-jobs/${encodeURIComponent(jobId)}`);
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
      throw new Error(job.error || "Seed-VC変換に失敗しました");
    }
  }
}

function appendSeedVcSettings(formData) {
  appendNumberSetting(formData, "seed_vc_diffusion_steps", seedVcDiffusionStepsInput.value);
  appendNumberSetting(formData, "seed_vc_reference_max_seconds", seedVcReferenceMaxSecondsInput.value);
  formData.append("seed_vc_reference_auto_select", seedVcReferenceAutoSelectInput.checked ? "true" : "false");
  appendNumberSetting(formData, "seed_vc_length_adjust", seedVcLengthAdjustInput.value);
  appendNumberSetting(formData, "seed_vc_inference_cfg_rate", seedVcInferenceCfgRateInput.value);
}

function applyRuntimeSeedVcDefaults(settings) {
  setInputValue(seedVcDiffusionStepsInput, settings.diffusion_steps);
  setInputValue(seedVcReferenceMaxSecondsInput, settings.reference_max_seconds);
  setInputValue(seedVcLengthAdjustInput, settings.length_adjust);
  setInputValue(seedVcInferenceCfgRateInput, settings.inference_cfg_rate);
  if (settings.reference_auto_select !== undefined && settings.reference_auto_select !== null) {
    seedVcReferenceAutoSelectInput.checked = Boolean(settings.reference_auto_select);
  }
  seedVcRangeInputs.forEach(renderSeedVcRangeValue);
  syncSeedVcPresetSelection();
}

function applySeedVcPreset() {
  const preset = seedVcPresets[seedVcPresetSelect.value];
  if (!preset) {
    return;
  }
  setInputValue(seedVcDiffusionStepsInput, preset.diffusion_steps);
  setInputValue(seedVcReferenceMaxSecondsInput, preset.reference_max_seconds);
  setInputValue(seedVcLengthAdjustInput, preset.length_adjust);
  setInputValue(seedVcInferenceCfgRateInput, preset.inference_cfg_rate);
  seedVcRangeInputs.forEach(renderSeedVcRangeValue);
}

function syncSeedVcPresetSelection() {
  const current = currentSeedVcSettings();
  const matched = Object.entries(seedVcPresets).find(([, preset]) => sameSeedVcSettings(current, preset));
  seedVcPresetSelect.value = matched ? matched[0] : "custom";
}

function currentSeedVcSettings() {
  return {
    diffusion_steps: Number(seedVcDiffusionStepsInput.value),
    reference_max_seconds: Number(seedVcReferenceMaxSecondsInput.value),
    length_adjust: Number(seedVcLengthAdjustInput.value),
    inference_cfg_rate: Number(seedVcInferenceCfgRateInput.value),
  };
}

function sameSeedVcSettings(left, right) {
  return (
    numbersEqual(left.diffusion_steps, right.diffusion_steps) &&
    numbersEqual(left.reference_max_seconds, right.reference_max_seconds) &&
    numbersEqual(left.length_adjust, right.length_adjust) &&
    numbersEqual(left.inference_cfg_rate, right.inference_cfg_rate)
  );
}

function renderProcessingJob(job) {
  processingPanel.hidden = false;
  const currentStage = job.current_stage || null;
  processingCurrent.textContent = processingCurrentText(job.status, currentStage);
  if (job.status === "running" && currentStage) {
    seedVcStatus.textContent = `処理中: ${currentStage.label}`;
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

function renderReferencePreview(originalFile, payload) {
  clearReferencePreview();
  const normalizedBlob = audioBlobFromBase64(payload.audio_base64, payload.audio_mime_type || "audio/wav");
  referencePreviewOriginalObjectUrl = URL.createObjectURL(originalFile);
  referencePreviewNormalizedObjectUrl = URL.createObjectURL(normalizedBlob);
  referencePreviewOriginalAudio.src = referencePreviewOriginalObjectUrl;
  referencePreviewNormalizedAudio.src = referencePreviewNormalizedObjectUrl;
  renderKeyValueList(referencePreviewTimings, payload.timings_ms || {}, (value) => `${Number(value).toFixed(1)} ms`);
  referencePreviewSection.hidden = false;
}

function renderSeedVcResult(result) {
  const audioBlob = audioBlobFromBase64(result.audio_base64, result.audio_mime_type || "audio/wav");
  if (outputObjectUrl) {
    URL.revokeObjectURL(outputObjectUrl);
  }
  outputObjectUrl = URL.createObjectURL(audioBlob);
  outputAudio.src = outputObjectUrl;
  downloadLink.href = outputObjectUrl;
  downloadLink.hidden = false;
  renderKeyValueList(timingsList, result.timings_ms || {}, (value) => `${Number(value).toFixed(1)} ms`);
  renderKeyValueList(providersList, result.providers || {}, String);
  renderWarnings(result.warnings || []);
}

function clearReferencePreview() {
  if (referencePreviewOriginalObjectUrl) {
    URL.revokeObjectURL(referencePreviewOriginalObjectUrl);
    referencePreviewOriginalObjectUrl = null;
  }
  if (referencePreviewNormalizedObjectUrl) {
    URL.revokeObjectURL(referencePreviewNormalizedObjectUrl);
    referencePreviewNormalizedObjectUrl = null;
  }
  referencePreviewOriginalAudio.removeAttribute("src");
  referencePreviewNormalizedAudio.removeAttribute("src");
  referencePreviewTimings.replaceChildren();
  referencePreviewSection.hidden = true;
}

function clearResult() {
  if (outputObjectUrl) {
    URL.revokeObjectURL(outputObjectUrl);
    outputObjectUrl = null;
  }
  outputAudio.removeAttribute("src");
  downloadLink.removeAttribute("href");
  downloadLink.hidden = true;
  timingsList.replaceChildren();
  providersList.replaceChildren();
  warningsList.replaceChildren();
}

function renderInputAudioPreview(blob, filename = "") {
  if (inputAudioObjectUrl) {
    URL.revokeObjectURL(inputAudioObjectUrl);
  }
  inputAudioObjectUrl = URL.createObjectURL(blob);
  inputAudio.src = inputAudioObjectUrl;
  inputAudio.hidden = false;
  recordingDetails.textContent = `${filename || "選択済み音声"} / ${blob.type || "unknown"} / ${formatBytes(blob.size)}`;
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

function setSourceAudioStatus(label, blob, filename = "") {
  const displayName = filename || blob?.name || "音声";
  const sizeText = blob?.size ? ` / ${formatBytes(blob.size)}` : "";
  sourceAudioStatus.textContent = `${label}: ${displayName}${sizeText}`;
  sourceAudioStatus.dataset.state = "selected";
}

function clearSourceAudioStatus(message) {
  sourceAudioStatus.textContent = message;
  delete sourceAudioStatus.dataset.state;
}

function renderKeyValueList(list, entries, formatValue) {
  list.replaceChildren();
  Object.entries(entries).forEach(([key, value]) => {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = formatValue(value);
    list.append(term, detail);
  });
}

function renderWarnings(warnings) {
  warningsList.replaceChildren();
  warnings.forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    warningsList.append(item);
  });
}

function renderSelectedFileStatus(input, target, emptyMessage) {
  const file = input.files[0];
  target.textContent = file ? `${file.name || "audio"} (${formatBytes(file.size)})` : emptyMessage;
}

function renderSeedVcRangeValue(input) {
  const output = document.querySelector(`[data-seed-vc-range-output="${input.name}"]`);
  if (!output) {
    return;
  }
  output.value = input.value;
  output.textContent = input.value;
}

function renderError(message) {
  seedVcErrorMessage.textContent = message;
  seedVcErrorMessage.hidden = false;
  seedVcStatus.textContent = "エラー";
}

function clearError() {
  seedVcErrorMessage.textContent = "";
  seedVcErrorMessage.hidden = true;
}

function requireSelectedAudio(input, message) {
  const file = input.files[0];
  if (!file || file.size < 1) {
    throw new Error(message);
  }
  return file;
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

function appendNumberSetting(formData, name, value) {
  if (value !== "") {
    formData.append(name, value);
  }
}

function setInputValue(input, value) {
  if (input && value !== undefined && value !== null) {
    input.value = String(value);
  }
}

function numbersEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.0001;
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
    inputLevel.value = Math.min(Math.sqrt(sum / samples.length) * 3, 1);
    inputLevelAnimationFrame = requestAnimationFrame(updateLevel);
  };
  updateLevel();
}

function stopInputLevelMeter() {
  if (inputLevelAnimationFrame) {
    cancelAnimationFrame(inputLevelAnimationFrame);
    inputLevelAnimationFrame = null;
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

function audioBlobFromBase64(audioBase64, mimeType) {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
