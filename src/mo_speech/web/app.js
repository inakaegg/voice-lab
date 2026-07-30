recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
audioDeviceRefreshButton.addEventListener("click", loadAudioDevices);
historyRefreshButton.addEventListener("click", () => loadAudioHistory({ announce: true }));
useOutputAsInputButton.addEventListener("click", () => {
  if (currentOutputBlob) {
    useAudioBlobAsInput(
      currentOutputBlob,
      currentOutputFileName,
      "出力音声をVC入力に設定しました",
      null,
      "出力音声をVC入力",
    );
  }
});
useOutputAsReferenceButton.addEventListener("click", () => {
  if (currentOutputBlob) {
    useAudioBlobAsReference(
      currentOutputBlob,
      currentOutputFileName,
      "出力音声をVC参照に設定しました",
      "出力音声をVC参照",
    );
  }
});
audioInput.addEventListener("change", handleAudioFileChange);
referenceAudioInput.addEventListener("change", handleReferenceAudioFileChange);
ttsTextFileInput.addEventListener("change", handleTtsTextFileChange);
operationModeSelect.addEventListener("change", () => {
  syncOperationMode();
  clearResultOutputs();
});
ttsBackendSelect.addEventListener("change", syncTtsBackendAvailability);
ttsTargetLanguageSelect.addEventListener("change", syncTtsBackendAvailability);
voiceBackendSelect.addEventListener("change", () => {
  syncVoiceBackendHint();
  syncSeedVcSettingsVisibility();
});
seedVcPresetSelect.addEventListener("change", applySeedVcPreset);
seedVcReferencePreviewButton.addEventListener("click", previewSeedVcReferenceAudio);
if (runpodWarmupButton) {
  runpodWarmupButton.addEventListener("click", startRunpodWarmup);
}
[seedVcDiffusionStepsInput, seedVcReferenceMaxSecondsInput, seedVcLengthAdjustInput, seedVcInferenceCfgRateInput].forEach(
  (input) => input.addEventListener("input", syncSeedVcPresetSelection),
);
form.addEventListener("submit", submitCurrentOperation);

syncOperationMode();
loadRuntime();
loadAudioDevices();
loadAudioHistory();

async function submitCurrentOperation(event) {
  if (operationModeSelect.value === "voice_conversion") {
    await submitVoiceConversion(event);
    return;
  }
  await submitTextToSpeech(event);
}

async function submitTextToSpeech(event) {
  event.preventDefault();
  beginOperation("読み上げ処理中");
  try {
    const text = ttsTextInput.value.trim();
    if (!text) {
      throw new Error("読み上げテキストを入力してください");
    }
    const formData = new FormData();
    formData.append("text", text);
    formData.append("target_language", ttsTargetLanguageSelect.value);
    formData.append("tts_backend", selectedTtsBackend());

    const response = await fetch("/api/text-to-speech-jobs", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "読み上げに失敗しました");
    }

    const job = await response.json();
    renderProcessingJob(job);
    const completedJob = await pollJob(`/api/text-to-speech-jobs/${job.job_id}`, "読み上げ");
    if (!completedJob.result) {
      throw new Error("読み上げ結果を取得できませんでした");
    }
    renderAudioResult(completedJob.result, "tts-output");
    await loadAudioHistory();
    setStatus("完了", "success");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
}

async function submitVoiceConversion(event) {
  event.preventDefault();
  beginOperation("VC処理中");
  try {
    const sourceFile = audioInput.files[0];
    const referenceFile = referenceAudioInput.files[0];
    const formData = new FormData();
    const voiceBackend = selectedVoiceBackend();
    formData.append("voice_backend", voiceBackend);
    appendSeedVcSettings(formData, voiceBackend);
    if (sourceFile) {
      assertAudioBlob(sourceFile, "変換元音声ファイルが空です");
      formData.append("source_audio", sourceFile);
    } else if (recordedBlob) {
      formData.append("source_audio", recordedBlob, recordedFileName);
    } else {
      throw new Error("変換元音声ファイルを選択するか録音してください");
    }
    if (referenceFile) {
      assertAudioBlob(referenceFile, "参照音声ファイルが空です");
      formData.append("reference_audio", referenceFile);
    } else if (referenceAudioBlob) {
      formData.append("reference_audio", referenceAudioBlob, referenceAudioFileName);
    } else {
      throw new Error("参照音声ファイルを選択してください");
    }

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
    const completedJob = await pollJob(`/api/voice-conversion-jobs/${job.job_id}`, "VC");
    if (!completedJob.result) {
      throw new Error("VC結果を取得できませんでした");
    }
    renderAudioResult(completedJob.result, "vc-output");
    await loadAudioHistory();
    setStatus("完了", "success");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
}

function beginOperation(message) {
  setStatus(message);
  renderProcessingJob({ status: "queued", stages: [] });
  clearError();
  submitButton.disabled = true;
}

async function previewSeedVcReferenceAudio(event) {
  event.preventDefault();
  clearError();
  setStatus("参照音声準備中");
  seedVcReferencePreviewButton.disabled = true;
  try {
    const referenceAudio = selectedSeedVcReferenceAudio();
    const formData = new FormData();
    appendSeedVcSettings(formData, "seed-vc");
    formData.append("reference_audio", referenceAudio.blob, referenceAudio.filename);
    const response = await fetch(new URL("/api/seed-vc/reference-preview", window.location.href), {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "参照音声の確認に失敗しました");
    }
    renderSeedVcReferencePreview(referenceAudio.blob, await response.json());
    setStatus("参照音声確認完了", "success");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    seedVcReferencePreviewButton.disabled = false;
  }
}

function selectedSeedVcReferenceAudio() {
  const referenceFile = referenceAudioInput.files[0];
  if (referenceFile) {
    assertAudioBlob(referenceFile, "参照音声ファイルが空です");
    return { blob: referenceFile, filename: referenceFile.name || "reference.audio" };
  }
  if (referenceAudioBlob) {
    assertAudioBlob(referenceAudioBlob, "参照音声ファイルが空です");
    return { blob: referenceAudioBlob, filename: referenceAudioFileName };
  }
  throw new Error("参照音声ファイルを選択してください");
}

function assertAudioBlob(blob, message) {
  if (!blob || blob.size < 1) {
    throw new Error(message);
  }
}

function renderSeedVcReferencePreview(originalBlob, payload) {
  clearSeedVcReferencePreview();
  const normalizedBytes = base64ToBytes(payload.audio_base64);
  const normalizedBlob = new Blob([normalizedBytes], { type: payload.audio_mime_type || "audio/wav" });
  referencePreviewOriginalObjectUrl = URL.createObjectURL(originalBlob);
  referencePreviewNormalizedObjectUrl = URL.createObjectURL(normalizedBlob);
  referencePreviewOriginalAudio.src = referencePreviewOriginalObjectUrl;
  referencePreviewNormalizedAudio.src = referencePreviewNormalizedObjectUrl;
  renderKeyValueList(referencePreviewTimings, payload.timings_ms || {}, (value) => `${Number(value).toFixed(1)} ms`);
  referencePreviewSection.hidden = false;
}

function clearSeedVcReferencePreview() {
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

async function pollJob(url, operationLabel) {
  while (true) {
    await delay(800);
    const response = await fetch(url);
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
      throw new Error(job.error || `${operationLabel}に失敗しました`);
    }
  }
}

function renderProcessingJob(job) {
  processingPanel.hidden = false;
  const currentStage = job.current_stage || null;
  processingCurrent.textContent = processingCurrentText(job.status, currentStage);
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
  return currentStage ? `${currentStage.label}: ${currentStage.provider}` : "準備中";
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

function renderAudioResult(payload, filenamePrefix) {
  const audioBytes = base64ToBytes(payload.audio_base64);
  const audioBlob = new Blob([audioBytes], { type: payload.audio_mime_type || "audio/wav" });
  renderOutputAudioBlob(
    audioBlob,
    `${filenamePrefix}.${extensionForMimeType(audioBlob.type || "audio/wav")}`,
  );
  renderKeyValueList(
    document.querySelector("#timings"),
    payload.timings_ms || {},
    (value) => `${Number(value).toFixed(1)} ms`,
  );
  renderKeyValueList(document.querySelector("#providers"), payload.providers || {}, String);
  const warnings = document.querySelector("#warnings");
  warnings.replaceChildren();
  (payload.warnings || []).forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    warnings.append(item);
  });
}

async function loadRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) {
      throw new Error("runtime request failed");
    }
    renderRuntime(await response.json());
  } catch {
    textTtsBackends = [];
    voiceConversionBackends = [];
    syncTtsBackendAvailability();
    syncVoiceBackendAvailability();
    syncRunpodWarmupStatusFromRuntime();
  }
}

function renderRuntime(payload) {
  textTtsBackends = payload.text_tts_backends || [];
  voiceConversionBackends = payload.voice_conversion_backends || [];
  syncTtsBackendAvailability();
  syncVoiceBackendAvailability();
  syncSeedVcSettingsDefaults();
  syncSeedVcSettingsVisibility();
  syncRunpodWarmupStatusFromRuntime();
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

function seedVcBackendInfo() {
  return voiceConversionBackends.find((backend) => backend.id === "seed-vc");
}

function syncRunpodWarmupStatusFromRuntime() {
  if (!runpodWarmupButton || !runpodWarmupStatus) {
    return;
  }
  if (runpodWarmupInFlight || runpodWarmupJobId) {
    setRunpodWarmupStatus("準備中", "warming");
    runpodWarmupButton.disabled = true;
    return;
  }
  const backend = seedVcBackendInfo();
  if (!backend?.available) {
    setRunpodWarmupStatus(backend?.reason || "Seed-VCは利用できません", "failed");
    runpodWarmupButton.disabled = true;
    runpodWarmupButton.textContent = "RunPodを準備";
    return;
  }
  const warmup = backend.settings?.warmup || {};
  const modelResident = Boolean(warmup.ready || backend.settings?.seed_vc?.model_resident);
  if (modelResident) {
    setRunpodWarmupStatus("準備OK", "ready");
    runpodWarmupButton.disabled = false;
    runpodWarmupButton.textContent = "再準備";
    return;
  }
  setRunpodWarmupStatus("未準備", "cold");
  runpodWarmupButton.disabled = false;
  runpodWarmupButton.textContent = "RunPodを準備";
}

function setRunpodWarmupStatus(message, state = "unknown") {
  runpodWarmupStatus.textContent = message;
  runpodWarmupStatus.dataset.state = state;
}

async function startRunpodWarmup() {
  if (runpodWarmupInFlight) {
    return;
  }
  runpodWarmupInFlight = true;
  runpodWarmupJobId = "";
  runpodWarmupButton.disabled = true;
  setRunpodWarmupStatus("準備中", "warming");
  try {
    const response = await fetch("/api/warmup", { method: "POST" });
    if (!response.ok) {
      throw new Error(await runpodWarmupErrorMessage(response));
    }
    let job = await response.json();
    if (job.status !== "succeeded" && job.status !== "failed") {
      if (!job.job_id) {
        throw new Error("warmup job IDを取得できませんでした");
      }
      runpodWarmupJobId = job.job_id;
      job = await pollRunpodWarmupJob(job.job_id);
    }
    if (job.status !== "succeeded") {
      throw new Error(job.error || "warmupに失敗しました");
    }
    setRunpodWarmupStatus("準備OK", "ready");
    await loadRuntime();
  } catch (error) {
    setRunpodWarmupStatus(error.message || "準備失敗", "failed");
    runpodWarmupButton.disabled = false;
  } finally {
    runpodWarmupInFlight = false;
    runpodWarmupJobId = "";
  }
}

async function pollRunpodWarmupJob(jobId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await delay(1000);
    const response = await fetch(`/api/warmup/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new Error(await runpodWarmupErrorMessage(response));
    }
    const job = await response.json();
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    setRunpodWarmupStatus("準備中", "warming");
  }
  return { status: "failed", error: "warmupがタイムアウトしました" };
}

async function runpodWarmupErrorMessage(response) {
  const payload = await response.json().catch(() => ({}));
  return payload.detail || payload.error || `warmup request failed (${response.status})`;
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

function syncOperationMode() {
  const voiceConversion = operationModeSelect.value === "voice_conversion";
  textTtsOnlyElements.forEach((element) => {
    element.hidden = voiceConversion;
  });
  vcOnlyElements.forEach((element) => {
    element.hidden = !voiceConversion;
  });
  if (voiceConversion) {
    inputAudio.hidden = !inputAudio.getAttribute("src");
    submitButton.textContent = "VCを実行";
    outputAudioHeading.textContent = "VC出力音声";
    audioLabel.textContent = "変換元音声ファイル";
    syncVoiceBackendAvailability();
  } else {
    inputAudio.hidden = true;
    submitButton.textContent = "読み上げる";
    outputAudioHeading.textContent = "読み上げ音声";
    syncTtsBackendAvailability();
  }
  syncSeedVcSettingsVisibility();
}

function syncVoiceBackendAvailability() {
  const fallbackBackends =
    voiceConversionBackends.length > 0
      ? voiceConversionBackends
      : [{ id: "seed-vc", label: "Seed-VC", provider: "Seed-VC", available: true, reason: "", settings: {} }];
  const currentValue = voiceBackendSelect.value;
  voiceBackendSelect.replaceChildren(
    ...fallbackBackends.map((backend) => {
      const option = new Option(
        backend.available ? backend.label : `${backend.label}（未導入）`,
        backend.id,
      );
      option.disabled = !backend.available;
      option.dataset.reason = backend.reason || "";
      option.dataset.provider = backend.provider || "";
      return option;
    }),
  );
  const availableBackends = fallbackBackends.filter((backend) => backend.available);
  voiceBackendSelect.disabled = availableBackends.length === 0;
  if (availableBackends.some((backend) => backend.id === currentValue)) {
    voiceBackendSelect.value = currentValue;
  } else if (availableBackends.length > 0) {
    voiceBackendSelect.value = availableBackends[0].id;
  }
  syncVoiceBackendHint();
  syncSeedVcSettingsVisibility();
}

function syncTtsBackendAvailability() {
  const fallbackBackends =
    textTtsBackends.length > 0
      ? textTtsBackends
      : [
          {
            id: "google_translate",
            label: "Google Translate TTS endpoint",
            available: true,
            reason: "",
            settings: { supported_target_languages: ["id-ID", "ja-JP", "zh-CN", "en-US"] },
          },
          {
            id: "openai",
            label: "OpenAI TTS API",
            available: false,
            reason: "OPENAI_API_KEY が設定されていません。",
            settings: { supported_target_languages: ["auto", ...openAiTargetLanguages] },
          },
        ];
  const currentValue = ttsBackendSelect.value;
  ttsBackendSelect.replaceChildren(
    ...fallbackBackends.map((backend) => {
      const option = new Option(
        backend.available ? backend.label : `${backend.label}（未設定）`,
        backend.id,
      );
      option.disabled = !backend.available;
      option.dataset.reason = backend.reason || "";
      return option;
    }),
  );
  const availableBackends = fallbackBackends.filter((backend) => backend.available);
  ttsBackendSelect.disabled = availableBackends.length === 0;
  if (availableBackends.some((backend) => backend.id === currentValue)) {
    ttsBackendSelect.value = currentValue;
  } else if (availableBackends.length > 0) {
    ttsBackendSelect.value = availableBackends[0].id;
  }

  const backend = fallbackBackends.find((item) => item.id === ttsBackendSelect.value);
  const supportedLanguages = backend?.settings?.supported_target_languages || ["id-ID", "ja-JP", "zh-CN", "en-US"];
  const previousLanguage = ttsTargetLanguageSelect.value;
  ttsTargetLanguageSelect.replaceChildren(
    ...supportedLanguages.map((language) => new Option(languageLabels[language] || language, language)),
  );
  if (supportedLanguages.includes(previousLanguage)) {
    ttsTargetLanguageSelect.value = previousLanguage;
  } else if (supportedLanguages.includes("auto")) {
    ttsTargetLanguageSelect.value = "auto";
  } else if (supportedLanguages.length > 0) {
    ttsTargetLanguageSelect.value = supportedLanguages[0];
  }
  const selected = selectedTtsBackendOption();
  ttsBackendHint.textContent = selected?.disabled
    ? selected.dataset.reason || ""
    : ttsBackendSelect.value === "google_translate"
      ? "読み上げ言語を明示して音声を生成します。"
      : "OpenAI TTS APIで読み上げ音声を生成します。";
}

function syncVoiceBackendHint() {
  const selected = [...voiceBackendSelect.options].find(
    (option) => option.value === voiceBackendSelect.value,
  );
  voiceBackendHint.textContent = selected
    ? selected.dataset.reason || selected.dataset.provider || ""
    : "利用できるVC backendがありません。";
}

function selectedTtsBackend() {
  const selected = selectedTtsBackendOption();
  if (!selected || selected.disabled) {
    throw new Error("利用可能なTTS方式を選択してください");
  }
  return selected.value;
}

function selectedTtsBackendOption() {
  return [...ttsBackendSelect.options].find((option) => option.value === ttsBackendSelect.value);
}

function selectedVoiceBackend() {
  const selected = [...voiceBackendSelect.options].find(
    (option) => option.value === voiceBackendSelect.value,
  );
  if (!selected || selected.disabled) {
    throw new Error("利用可能なVC backendを選択してください");
  }
  return selected.value;
}

function sourceAudioEmptyText() {
  return "変換元音声なし";
}

function clearResultOutputs() {
  processingPanel.hidden = true;
  processingCurrent.textContent = "待機中";
  processingSteps.replaceChildren();
  clearSeedVcReferencePreview();
  clearCurrentOutputBlob();
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
    outputAudioObjectUrl = null;
  }
  outputAudio.removeAttribute("src");
  outputAudio.srcObject = null;
  document.querySelector("#timings").replaceChildren();
  document.querySelector("#providers").replaceChildren();
  document.querySelector("#warnings").replaceChildren();
  clearError();
  setStatus("待機中");
}
