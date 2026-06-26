recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
audioDeviceRefreshButton.addEventListener("click", loadAudioDevices);
historyRefreshButton.addEventListener("click", loadAudioHistory);
useOutputAsInputButton.addEventListener("click", () => {
  if (currentOutputBlob) {
    useAudioBlobAsInput(currentOutputBlob, currentOutputFileName, "出力音声を入力に設定しました", null, "出力音声を入力");
  }
});
useOutputAsReferenceButton.addEventListener("click", () => {
  if (currentOutputBlob) {
    useAudioBlobAsReference(currentOutputBlob, currentOutputFileName, "出力音声をVC参照に設定しました", "出力音声をVC参照");
  }
});
textResultActionButtons.forEach((button) => {
  button.addEventListener("click", () => useTextResultForTts(button.dataset.resultSource || ""));
});
audioInput.addEventListener("change", handleAudioFileChange);
referenceAudioInput.addEventListener("change", handleReferenceAudioFileChange);
ttsTextFileInput.addEventListener("change", handleTtsTextFileChange);
operationModeSelect.addEventListener("change", () => {
  stopRealtimeStreaming();
  syncOperationMode();
  clearResultOutputs();
});
translationBackendSelect.addEventListener("change", () => {
  userSelectedTranslationBackend = true;
  stopRealtimeStreaming();
  syncOperationMode();
});
ttsBackendSelect.addEventListener("change", () => {
  syncTtsBackendAvailability();
  syncRuntimeNote();
});
voiceProcessingSelect.addEventListener("change", () => {
  syncVoiceModeHint();
  syncSeedVcSettingsVisibility();
});
voiceBackendSelect.addEventListener("change", () => {
  syncVoiceBackendHint();
  syncSeedVcSettingsVisibility();
});
form.source_language.addEventListener("change", syncTargetOptions);
form.target_language.addEventListener("change", syncVoiceModeHint);
ttsTargetLanguageSelect.addEventListener("change", syncTtsBackendAvailability);
seedVcPresetSelect.addEventListener("change", applySeedVcPreset);
seedVcReferencePreviewButton.addEventListener("click", previewSeedVcReferenceAudio);
[seedVcDiffusionStepsInput, seedVcReferenceMaxSecondsInput, seedVcLengthAdjustInput, seedVcInferenceCfgRateInput].forEach(
  (input) => input.addEventListener("input", syncSeedVcPresetSelection),
);
form.addEventListener("submit", submitCurrentOperation);
syncTargetOptions();
syncTranslationBackendAvailability();
syncVoiceProcessingAvailability();
syncOperationMode();
loadRuntime();
loadAudioDevices();
loadAudioHistory();

async function submitCurrentOperation(event) {
  if (operationModeSelect.value === "voice_conversion") {
    await submitVoiceConversion(event);
    return;
  }
  if (operationModeSelect.value === "text_tts") {
    await submitTextToSpeech(event);
    return;
  }
  if (isRealtimeStreamingTranslationBackend()) {
    if (realtimeStreamingSession) {
      event.preventDefault();
      await stopRealtimeStreaming();
      return;
    }
    await startRealtimeStreaming(event);
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
    formData.append("translation_backend", selectedTranslationBackend());
    formData.append("source_language", selectedSourceLanguage());
    formData.append("target_language", form.target_language.value);
    const voiceMode = selectedVoiceMode();
    formData.append("voice_mode", voiceMode);
    if (voiceMode === "convert") {
      appendSeedVcSettings(formData, "seed-vc");
    }

    const enableSuffix = shouldUseBatchTranslationControls() && document.querySelector("#enable_suffix").checked;
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
      if (inputHistorySource) {
        formData.append("input_history_kind", inputHistorySource.kind);
        formData.append("input_history_filename", inputHistorySource.filename);
      }
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
    loadAudioHistory();
    setStatus("完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
}

async function submitTextToSpeech(event) {
  event.preventDefault();
  setStatus("処理中");
  renderPartialResult({});
  renderProcessingJob({ status: "queued", stages: [] });
  clearError();
  submitButton.disabled = true;

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
    const completedJob = await pollTextToSpeechJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("読み上げ結果を取得できませんでした");
    }
    renderVoiceConversionResult(completedJob.result);
    loadAudioHistory();
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
    const voiceBackend = selectedVoiceBackend();
    formData.append("voice_backend", voiceBackend);
    appendSeedVcSettings(formData, voiceBackend);
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
    if (referenceFile) {
      if (referenceFile.size < 1) {
        throw new Error("参照音声ファイルが空です");
      }
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
    const completedJob = await pollVoiceConversionJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("VC結果を取得できませんでした");
    }
    renderVoiceConversionResult(completedJob.result);
    loadAudioHistory();
    setStatus("完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
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

    let response = null;
    try {
      response = await fetch(new URL("/api/seed-vc/reference-preview", window.location.href), {
        method: "POST",
        body: formData,
      });
    } catch (error) {
      const detail = error.message ? ` (${error.message})` : "";
      throw new Error(`参照音声の確認APIに接続できませんでした。サーバーを起動し直してページを再読み込みしてください。${detail}`);
    }

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "参照音声の確認に失敗しました");
    }

    renderSeedVcReferencePreview(referenceAudio.blob, await response.json());
    setStatus("参照音声確認完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    seedVcReferencePreviewButton.disabled = false;
  }
}

function selectedSeedVcReferenceAudio() {
  if (operationModeSelect.value === "voice_conversion") {
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

  const inputFile = audioInput.files[0];
  if (inputFile) {
    assertAudioBlob(inputFile, "音声ファイルが空です");
    return { blob: inputFile, filename: inputFile.name || "input.audio" };
  }
  if (recordedBlob) {
    assertAudioBlob(recordedBlob, "音声ファイルが空です");
    return { blob: recordedBlob, filename: recordedFileName };
  }
  throw new Error("入力音声ファイルを選択するか録音してください");
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

async function pollTextToSpeechJob(jobId) {
  while (true) {
    await delay(800);
    const response = await fetch(`/api/text-to-speech-jobs/${jobId}`);
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
      throw new Error(job.error || "読み上げに失敗しました");
    }
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
  renderOutputAudioBlob(audioBlob, `translation-output.${extensionForMimeType(audioBlob.type || "audio/wav")}`);

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
  renderOutputAudioBlob(audioBlob, `output.${extensionForMimeType(audioBlob.type || "audio/wav")}`);

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
    supportedVoiceModes = ["default"];
    translationBackends = [];
    textTtsBackends = [];
    syncTranslationBackendAvailability();
    syncVoiceProcessingAvailability();
    syncTtsBackendAvailability();
  }
}

function renderRuntime(payload) {
  const providerMode = payload.provider_mode || "fake";
  if (runtimeMode) {
    runtimeMode.textContent = providerMode;
    runtimeMode.dataset.mode = providerMode;
  }
  runtimeProviderMode = providerMode;
  supportedVoiceModes = payload.supported_voice_modes || ["default"];
  translationBackends = payload.translation_backends || [];
  textTtsBackends = payload.text_tts_backends || [];
  voiceConversionBackends = payload.voice_conversion_backends || [];
  syncTranslationBackendAvailability();
  syncVoiceProcessingAvailability();
  syncTtsBackendAvailability();
  syncVoiceBackendAvailability();
  syncSeedVcSettingsDefaults();
  syncSeedVcSettingsVisibility();
  syncRuntimeNote();
  if (runtimeProviders) {
    runtimeProviders.replaceChildren();
    Object.entries(payload.providers || {}).forEach(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = key;
      const description = document.createElement("dd");
      description.textContent = String(value);
      runtimeProviders.append(term, description);
    });
  }
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
  const backend = selectedTranslationBackendInfo();
  const sourceLanguages = supportedSourceLanguagesForBackend(backend);
  const previousSource = form.source_language.value;
  form.source_language.replaceChildren(...sourceLanguages.map((language) => new Option(languageLabels[language] || language, language)));
  if (sourceLanguages.includes(previousSource)) {
    form.source_language.value = previousSource;
  } else {
    form.source_language.value = sourceLanguages[0] || "auto";
  }

  const targets = supportedTargetLanguagesForBackend(backend, form.source_language.value);
  const previousTarget = form.target_language.value;
  form.target_language.replaceChildren(
    ...targets.map((language) => new Option(languageLabels[language] || language, language)),
  );
  if (targets.includes(previousTarget)) {
    form.target_language.value = previousTarget;
  }
  const sourceLabel = isRealtimeTranslationBackend() ? "自動判定" : form.source_language.selectedOptions[0]?.textContent || "未対応";
  const targetLabel = form.target_language.selectedOptions[0]?.textContent || "未対応";
  routeHint.textContent = `${sourceLabel} -> ${targetLabel}`;
  syncVoiceProcessingAvailability();
  syncTtsBackendAvailability();
}

function syncOperationMode() {
  const isTranslation = operationModeSelect.value === "translation";
  const isVoiceConversion = operationModeSelect.value === "voice_conversion";
  const isTextTts = operationModeSelect.value === "text_tts";
  const isRealtime = isTranslation && isRealtimeTranslationBackend();
  const isRealtimeStreaming = isTranslation && isRealtimeStreamingTranslationBackend();
  document.querySelectorAll(".vc-only").forEach((element) => {
    element.hidden = !isVoiceConversion;
  });
  translationOnlyElements.forEach((element) => {
    element.hidden = !isTranslation;
  });
  translationBatchOnlyElements.forEach((element) => {
    element.hidden = !isTranslation || isRealtime;
  });
  textTtsOnlyElements.forEach((element) => {
    element.hidden = !isTextTts;
  });
  audioInputOnlyElements.forEach((element) => {
    element.hidden = isTextTts;
  });
  recordedAudioOnlyElements.forEach((element) => {
    element.hidden = isTextTts || isRealtimeStreaming;
  });
  realtimeStreamingOnlyElements.forEach((element) => {
    element.hidden = !isRealtimeStreaming;
  });
  audioLabel.textContent = isVoiceConversion ? "変換元音声ファイル" : "入力音声ファイル";
  sourceAudioHint.textContent = isVoiceConversion
    ? "録音またはファイル選択で変換元音声を指定します。"
    : "録音またはファイル選択で入力音声を指定します。";
  outputAudioHeading.textContent = isVoiceConversion ? "VC出力音声" : isTextTts ? "読み上げ音声" : "出力音声";
  submitButton.textContent = isVoiceConversion
    ? "VC実行"
    : isTextTts
      ? "読み上げ"
      : isRealtimeStreaming
        ? realtimeStreamingSession
          ? "接続停止"
          : "接続開始"
        : "変換";
  if (!audioInput.files[0] && !recordedBlob) {
    recordingDetails.textContent = sourceAudioEmptyText();
  }
  textResultSection.hidden = !isTranslation;
  syncTargetOptions();
  syncRuntimeNote();
  syncVoiceBackendAvailability();
  syncSeedVcSettingsVisibility();
  syncVoiceModeHint();
  syncTtsBackendAvailability();
}

function syncRuntimeNote() {
  if (!runtimeNote) {
    return;
  }
  if (operationModeSelect.value === "text_tts") {
    const selected = selectedTtsBackendOption();
    runtimeNote.textContent = selected?.disabled
      ? selected.dataset.reason || "選択したTTS方式は利用できません。"
      : "入力テキストを選択したTTS方式で音声化します。";
    return;
  }
  if (operationModeSelect.value === "voice_conversion") {
    runtimeNote.textContent = "変換元音声と参照音声をVC backendで処理します。";
    return;
  }
  const selected = selectedTranslationBackendOption();
  if (selected?.disabled) {
    runtimeNote.textContent = selected.dataset.reason || "選択した翻訳方式は利用できません。";
    return;
  }
  if (translationBackendSelect.value === "openai") {
    runtimeNote.textContent = "OpenAI APIで文字起こし、翻訳、音声生成を行います。";
    return;
  }
  if (translationBackendSelect.value === "openai_realtime") {
    runtimeNote.textContent = "OpenAI Realtime translationで入力言語を自動判定し、翻訳音声を生成します。";
    return;
  }
  if (translationBackendSelect.value === "openai_realtime_stream") {
    runtimeNote.textContent = "OpenAI Realtime translationへWebRTCで接続し、翻訳音声を逐次再生します。";
    return;
  }
  runtimeNote.textContent =
    runtimeProviderMode === "local"
      ? "Qwen/local系providerで録音または選択した音声を処理します。"
      : "Qwen/local枠は現在fake providerのデモ応答です。";
}

function syncVoiceModeHint() {
  if (operationModeSelect.value === "voice_conversion") {
    voiceModeHint.textContent = "";
    return;
  }
  if (isRealtimeTranslationBackend()) {
    voiceModeHint.textContent = "";
    return;
  }
  const voiceMode = selectedVoiceMode();
  const selected = selectedTranslationBackendOption();
  if (selected?.disabled) {
    voiceModeHint.textContent = selected.dataset.reason || "";
    return;
  }
  if (voiceMode === "convert") {
    const backendLabel = translationBackendSelect.selectedOptions[0]?.textContent || "選択した翻訳方式";
    voiceModeHint.textContent = `${backendLabel}で音声生成後、Seed-VCで入力音声の声質へ変換します。`;
    return;
  }
  voiceModeHint.textContent = "声質変換なしで翻訳音声を出力します。";
}

function syncTranslationBackendAvailability() {
  const fallbackBackends =
    translationBackends.length > 0
      ? translationBackends
      : [
          {
            id: "openai",
            label: "音声翻訳（OpenAI API）",
            available: false,
            reason: "OPENAI_API_KEY が設定されていません。",
          },
          {
            id: "openai_realtime",
            label: "音声翻訳（OpenAI Realtime）",
            available: false,
            reason: "OPENAI_API_KEY が設定されていません。",
          },
          {
            id: "openai_realtime_stream",
            label: "音声翻訳（OpenAI Realtime streaming）",
            available: false,
            reason: "OPENAI_API_KEY が設定されていません。",
          },
          {
            id: "qwen",
            label: "音声翻訳（Qwen/local）",
            available: true,
            reason: "",
          },
        ];
  const currentValue = translationBackendSelect.value;
  translationBackendSelect.replaceChildren(
    ...fallbackBackends.map((backend) => {
      const label = backend.available ? backend.label : `${backend.label}（未設定）`;
      const option = new Option(label, backend.id);
      option.disabled = !backend.available;
      option.dataset.reason = backend.reason || "";
      return option;
    }),
  );
  const availableBackends = fallbackBackends.filter((backend) => backend.available);
  if (availableBackends.length === 0) {
    translationBackendSelect.disabled = true;
  } else {
    translationBackendSelect.disabled = false;
    if (!userSelectedTranslationBackend && translationBackends.length > 0) {
      translationBackendSelect.value = availableBackends[0].id;
    } else if (availableBackends.some((backend) => backend.id === currentValue)) {
      translationBackendSelect.value = currentValue;
    } else {
      translationBackendSelect.value = availableBackends[0].id;
    }
  }
  syncRuntimeNote();
  syncTargetOptions();
  syncVoiceProcessingAvailability();
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
      const option = new Option(backend.available ? backend.label : `${backend.label}（未設定）`, backend.id);
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

  const previousBackend = ttsTargetLanguageSelect.dataset.backend || "";
  const backend = fallbackBackends.find((item) => item.id === ttsBackendSelect.value) || selectedTtsBackendInfo();
  const supportedLanguages = backend?.settings?.supported_target_languages || ["id-ID", "ja-JP", "zh-CN", "en-US"];
  const previousLanguage = ttsTargetLanguageSelect.value;
  ttsTargetLanguageSelect.replaceChildren(
    ...supportedLanguages.map((language) => new Option(languageLabels[language] || language, language)),
  );
  if (ttsBackendSelect.value === "openai" && previousBackend !== "openai" && supportedLanguages.includes("auto")) {
    ttsTargetLanguageSelect.value = "auto";
  } else if (supportedLanguages.includes(previousLanguage)) {
    ttsTargetLanguageSelect.value = previousLanguage;
  } else if (supportedLanguages.includes("auto")) {
    ttsTargetLanguageSelect.value = "auto";
  } else if (supportedLanguages.length > 0) {
    ttsTargetLanguageSelect.value = supportedLanguages[0];
  }
  ttsTargetLanguageSelect.dataset.backend = ttsBackendSelect.value;
  const selected = selectedTtsBackendOption();
  ttsBackendHint.textContent = selected?.disabled
    ? selected.dataset.reason || ""
    : ttsBackendSelect.value === "google_translate"
      ? "Google側のtl指定が必要なため、読み上げ言語を明示します。"
      : "OpenAI TTS APIで読み上げ音声を生成します。通常はテキストから言語を自動判定します。";
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

function syncVoiceProcessingAvailability() {
  const currentValue = voiceProcessingSelect.value;
  const modes = voiceModesForSelectedTranslationBackend();
  const options = [];
  if (modes.includes("convert")) {
    options.push(new Option("Seed-VCで入力音声に寄せる", "seed-vc"));
  }
  if (modes.includes("default")) {
    options.push(new Option("なし", "none"));
  }
  if (options.length === 0) {
    options.push(new Option("利用できる声質変換がありません", "none"));
    voiceProcessingSelect.disabled = true;
  } else {
    voiceProcessingSelect.disabled = false;
  }
  voiceProcessingSelect.replaceChildren(...options);
  if ([...voiceProcessingSelect.options].some((option) => option.value === currentValue)) {
    voiceProcessingSelect.value = currentValue;
  } else {
    voiceProcessingSelect.value = modes.includes("convert") ? "seed-vc" : "none";
  }
  syncVoiceModeHint();
  syncSeedVcSettingsVisibility();
}

function selectedVoiceMode() {
  if (isRealtimeTranslationBackend()) {
    return "default";
  }
  return voiceProcessingSelect.value === "seed-vc" ? "convert" : "default";
}

function selectedSourceLanguage() {
  return isRealtimeTranslationBackend() ? "auto" : form.source_language.value;
}

function selectedTranslationBackend() {
  const selected = selectedTranslationBackendOption();
  if (!selected || selected.disabled) {
    throw new Error("利用可能な翻訳方式を選択してください");
  }
  return selected.value;
}

function selectedTranslationBackendOption() {
  return [...translationBackendSelect.options].find((option) => option.value === translationBackendSelect.value);
}

function selectedTranslationBackendInfo() {
  return translationBackends.find((backend) => backend.id === translationBackendSelect.value) || null;
}

function voiceModesForSelectedTranslationBackend() {
  const backend = selectedTranslationBackendInfo();
  if (backend?.settings?.supported_voice_modes) {
    return backend.settings.supported_voice_modes;
  }
  if (translationBackendSelect.value === "openai") {
    return ["default", "convert"];
  }
  if (translationBackendSelect.value === "openai_realtime") {
    return ["default"];
  }
  if (translationBackendSelect.value === "openai_realtime_stream") {
    return ["default"];
  }
  return supportedVoiceModes;
}

function supportedSourceLanguagesForBackend(backend) {
  const settings = backend?.settings || {};
  if (settings.source_language_mode === "auto") {
    return ["auto"];
  }
  if (settings.supported_source_languages) {
    return settings.supported_source_languages;
  }
  if (settings.supported_routes) {
    return [...new Set(settings.supported_routes.map((route) => route.source_language))];
  }
  return ["id-ID", "ja-JP"];
}

function supportedTargetLanguagesForBackend(backend, sourceLanguage) {
  const settings = backend?.settings || {};
  if (settings.supported_target_languages) {
    return settings.supported_target_languages.filter((language) => sourceLanguage === "auto" || language !== sourceLanguage);
  }
  if (settings.supported_routes) {
    return settings.supported_routes
      .filter((route) => route.source_language === sourceLanguage)
      .map((route) => route.target_language);
  }
  return sourceLanguage === "id-ID" ? ["ja-JP"] : ["zh-CN"];
}

function isRealtimeTranslationBackend() {
  return (
    operationModeSelect.value === "translation" &&
    (translationBackendSelect.value === "openai_realtime" ||
      translationBackendSelect.value === "openai_realtime_stream")
  );
}

function isRealtimeStreamingTranslationBackend() {
  return operationModeSelect.value === "translation" && translationBackendSelect.value === "openai_realtime_stream";
}

function shouldUseBatchTranslationControls() {
  return operationModeSelect.value === "translation" && !isRealtimeTranslationBackend();
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

function selectedTtsBackendInfo() {
  return textTtsBackends.find((backend) => backend.id === ttsBackendSelect.value) || null;
}

function selectedVoiceBackend() {
  const selected = [...voiceBackendSelect.options].find((option) => option.value === voiceBackendSelect.value);
  if (!selected || selected.disabled) {
    throw new Error("利用可能なVC backendを選択してください");
  }
  return selected.value;
}

function sourceAudioEmptyText() {
  if (operationModeSelect.value === "text_tts") {
    return "";
  }
  return operationModeSelect.value === "voice_conversion" ? "変換元音声なし" : "入力音声なし";
}

function clearResultOutputs() {
  renderPartialResult({});
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
