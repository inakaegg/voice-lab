const seedVcForm = document.querySelector("#seed-vc-form");
const seedVcStatus = document.querySelector("#seed-vc-status");
const sourceAudioInput = document.querySelector("#seed-vc-source-audio");
const sourceAudioStatus = document.querySelector("#seed-vc-source-status");
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

let outputObjectUrl = null;
let referencePreviewOriginalObjectUrl = null;
let referencePreviewNormalizedObjectUrl = null;
let seedVcAvailable = true;

sourceAudioInput.addEventListener("change", () => {
  renderSelectedFileStatus(sourceAudioInput, sourceAudioStatus, "変換元音声なし");
});
referenceAudioInput.addEventListener("change", () => {
  renderSelectedFileStatus(referenceAudioInput, referenceAudioStatus, "参照音声なし");
  clearReferencePreview();
});
seedVcForm.addEventListener("submit", submitSeedVcConversion);
seedVcReferencePreviewButton.addEventListener("click", previewSeedVcReferenceAudio);
seedVcPresetSelect.addEventListener("change", applySeedVcPreset);
[seedVcDiffusionStepsInput, seedVcReferenceMaxSecondsInput, seedVcLengthAdjustInput, seedVcInferenceCfgRateInput].forEach(
  (input) => input.addEventListener("input", syncSeedVcPresetSelection),
);

applySeedVcPreset();
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
    const sourceFile = requireSelectedAudio(sourceAudioInput, "変換元音声を選択してください");
    const referenceFile = requireSelectedAudio(referenceAudioInput, "参照音声を選択してください");
    const formData = new FormData();
    formData.append("voice_backend", "seed-vc");
    formData.append("source_audio", sourceFile, sourceFile.name || "source.audio");
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
