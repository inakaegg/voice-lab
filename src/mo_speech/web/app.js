const form = document.querySelector("#translation-form");
const audioInput = document.querySelector("#audio");
const audioLabel = document.querySelector("#audio-label");
const sourceAudioHint = document.querySelector("#source-audio-hint");
const referenceAudioInput = document.querySelector("#reference_audio");
const operationModeSelect = document.querySelector("#operation_mode");
const translationBackendSelect = document.querySelector("#translation_backend");
const voiceProcessingSelect = document.querySelector("#voice_processing");
const ttsTextInput = document.querySelector("#tts_text");
const ttsTargetLanguageSelect = document.querySelector("#tts_target_language");
const ttsBackendSelect = document.querySelector("#tts_backend");
const ttsBackendHint = document.querySelector("#tts-backend-hint");
const voiceBackendSelect = document.querySelector("#voice_backend");
const voiceBackendHint = document.querySelector("#voice-backend-hint");
const seedVcSettingsPanel = document.querySelector("#seed-vc-settings");
const seedVcPresetSelect = document.querySelector("#seed_vc_preset");
const seedVcDiffusionStepsInput = document.querySelector("#seed_vc_diffusion_steps");
const seedVcReferenceMaxSecondsInput = document.querySelector("#seed_vc_reference_max_seconds");
const seedVcLengthAdjustInput = document.querySelector("#seed_vc_length_adjust");
const seedVcInferenceCfgRateInput = document.querySelector("#seed_vc_inference_cfg_rate");
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
const translationBatchOnlyElements = [...document.querySelectorAll(".translation-batch-only")];
const textTtsOnlyElements = [...document.querySelectorAll(".text-tts-only")];
const audioInputOnlyElements = [...document.querySelectorAll(".audio-input-only")];
const recordedAudioOnlyElements = [...document.querySelectorAll(".recorded-audio-only")];
const realtimeStreamingOnlyElements = [...document.querySelectorAll(".realtime-streaming-only")];
const realtimeStreamingStopButton = document.querySelector("#realtime-streaming-stop");
const historyRefreshButton = document.querySelector("#history-refresh");
const historyRecordings = document.querySelector("#history-recordings");
const historyOutputs = document.querySelector("#history-outputs");

const languageLabels = {
  auto: "自動判定",
  "id-ID": "インドネシア語",
  "ja-JP": "日本語",
  "zh-CN": "中国語（普通話）",
  "en-US": "英語",
};

const seedVcPresets = {
  fast: {
    diffusion_steps: 10,
    reference_max_seconds: 5,
    length_adjust: 1.0,
    inference_cfg_rate: 0.7,
  },
  reasonable: {
    diffusion_steps: 25,
    reference_max_seconds: 8,
    length_adjust: 1.0,
    inference_cfg_rate: 0.7,
  },
  quality: {
    diffusion_steps: 30,
    reference_max_seconds: 10,
    length_adjust: 1.0,
    inference_cfg_rate: 0.7,
  },
  best: {
    diffusion_steps: 50,
    reference_max_seconds: 15,
    length_adjust: 1.0,
    inference_cfg_rate: 0.7,
  },
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
let translationBackends = [];
let textTtsBackends = [];
let voiceConversionBackends = [];
let runtimeProviderMode = "fake";
let realtimeStreamingSession = null;

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
audioDeviceRefreshButton.addEventListener("click", loadAudioDevices);
realtimeStreamingStopButton.addEventListener("click", stopRealtimeStreaming);
historyRefreshButton.addEventListener("click", loadAudioHistory);
audioInput.addEventListener("change", handleAudioFileChange);
operationModeSelect.addEventListener("change", () => {
  stopRealtimeStreaming();
  syncOperationMode();
  clearResultOutputs();
});
translationBackendSelect.addEventListener("change", () => {
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
  if (operationModeSelect.value === "text_tts") {
    await submitTextToSpeech(event);
    return;
  }
  if (isRealtimeStreamingTranslationBackend()) {
    await startRealtimeStreaming(event);
    return;
  }
  await submitTranslation(event);
}

async function startRealtimeStreaming(event) {
  event.preventDefault();
  clearError();
  clearResultOutputs();
  stopRealtimeStreaming();
  setStatus("接続中: OpenAI Realtime streaming");
  submitButton.disabled = true;
  realtimeStreamingStopButton.disabled = true;
  renderProcessingJob({
    status: "running",
    current_stage: {
      stage: "streaming",
      label: "Realtime streaming",
      provider: "OpenAI Realtime WebRTC",
    },
    stages: [
      {
        stage: "streaming",
        label: "Realtime streaming",
        provider: "OpenAI Realtime WebRTC",
      },
    ],
  });

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("このブラウザではマイク入力を利用できません");
    }
    const tokenResponse = await fetch("/api/openai-realtime-translation-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_language: form.target_language.value }),
    });
    if (!tokenResponse.ok) {
      const errorPayload = await tokenResponse.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "Realtime sessionを作成できませんでした");
    }
    const { value: clientSecret } = await tokenResponse.json();
    if (!clientSecret) {
      throw new Error("Realtime client secretを取得できませんでした");
    }

    const sourceStream = await navigator.mediaDevices.getUserMedia({ audio: selectedAudioConstraint() });
    startInputLevelMeter(sourceStream);
    const peerConnection = new RTCPeerConnection();
    const sourceTrack = sourceStream.getAudioTracks()[0];
    if (!sourceTrack) {
      throw new Error("マイクの音声trackを取得できませんでした");
    }
    peerConnection.addTrack(sourceTrack, sourceStream);

    const dataChannel = peerConnection.createDataChannel("oai-events");
    realtimeStreamingSession = {
      peerConnection,
      sourceStream,
      dataChannel,
    };
    let inputTranscript = "";
    let outputTranscript = "";
    dataChannel.addEventListener("message", (message) => {
      const realtimeEvent = JSON.parse(message.data);
      if (realtimeEvent.type === "session.input_transcript.delta") {
        inputTranscript += realtimeEvent.delta || "";
      }
      if (realtimeEvent.type === "session.output_transcript.delta") {
        outputTranscript += realtimeEvent.delta || "";
      }
      if (realtimeEvent.type === "session.input_transcript.delta" || realtimeEvent.type === "session.output_transcript.delta") {
        renderPartialResult({
          transcript: inputTranscript,
          translated_text: outputTranscript,
          transformed_text: outputTranscript,
        });
      }
    });

    peerConnection.addEventListener("track", ({ streams }) => {
      outputAudio.srcObject = streams[0];
      outputAudio.autoplay = true;
      outputAudio.play().catch(() => {});
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (peerConnection.connectionState === "failed") {
        renderError("Realtime streaming接続が失敗しました");
      }
      if (peerConnection.connectionState === "disconnected") {
        setStatus("切断済み");
      }
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
    realtimeStreamingStopButton.disabled = false;
    setStatus("接続中: Realtime streaming");
  } catch (error) {
    stopRealtimeStreaming();
    renderError(error.message || "Realtime streaming接続に失敗しました");
  } finally {
    submitButton.disabled = false;
  }
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
    loadAudioHistory();
    setStatus("完了");
  } catch (error) {
    renderError(error.message || "エラー");
  } finally {
    submitButton.disabled = false;
  }
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
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
  }
  outputAudio.srcObject = null;
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
  outputAudio.srcObject = null;
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

function stopRealtimeStreaming() {
  if (!realtimeStreamingSession) {
    realtimeStreamingStopButton.disabled = true;
    return;
  }
  const { peerConnection, sourceStream, dataChannel } = realtimeStreamingSession;
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.close();
  }
  sourceStream?.getTracks().forEach((track) => track.stop());
  peerConnection?.close();
  realtimeStreamingSession = null;
  realtimeStreamingStopButton.disabled = true;
  stopInputLevelMeter();
  setStatus("切断済み");
}

async function loadAudioHistory() {
  try {
    const response = await fetch("/api/audio-history");
    if (!response.ok) {
      throw new Error("audio history request failed");
    }
    const payload = await response.json();
    renderAudioHistoryList(historyRecordings, payload.recordings || []);
    renderAudioHistoryList(historyOutputs, payload.outputs || []);
  } catch {
    historyRecordings.textContent = "履歴を取得できませんでした。";
    historyOutputs.textContent = "履歴を取得できませんでした。";
  }
}

function renderAudioHistoryList(container, entries) {
  container.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-meta";
    empty.textContent = "まだありません";
    container.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = entry.url;
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const endpoint = entry.metadata?.endpoint || entry.kind;
    const createdAt = entry.created_at || "";
    meta.textContent = `${endpoint} / ${formatBytes(Number(entry.size_bytes || 0))} / ${createdAt}`;
    item.append(audio, meta);
    container.append(item);
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
    translationBackends = [];
    textTtsBackends = [];
    syncTranslationBackendAvailability();
    syncVoiceProcessingAvailability();
    syncTtsBackendAvailability();
  }
}

function renderRuntime(payload) {
  const providerMode = payload.provider_mode || "fake";
  runtimeMode.textContent = providerMode;
  runtimeMode.dataset.mode = providerMode;
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
  submitButton.textContent = isVoiceConversion ? "VC実行" : isTextTts ? "読み上げ" : isRealtimeStreaming ? "接続開始" : "変換";
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
            id: "qwen",
            label: "音声翻訳（Qwen/local）",
            available: true,
            reason: "",
          },
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
    if (availableBackends.some((backend) => backend.id === currentValue)) {
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
            settings: { supported_target_languages: ["id-ID", "ja-JP", "zh-CN", "en-US"] },
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

  const backend = selectedTtsBackendInfo();
  const supportedLanguages = backend?.settings?.supported_target_languages || ["id-ID", "ja-JP", "zh-CN", "en-US"];
  const previousLanguage = ttsTargetLanguageSelect.value;
  ttsTargetLanguageSelect.replaceChildren(
    ...supportedLanguages.map((language) => new Option(languageLabels[language] || language, language)),
  );
  if (supportedLanguages.includes(previousLanguage)) {
    ttsTargetLanguageSelect.value = previousLanguage;
  }
  const selected = selectedTtsBackendOption();
  ttsBackendHint.textContent = selected?.disabled
    ? selected.dataset.reason || ""
    : ttsBackendSelect.value === "google_translate"
      ? "比較用の無料endpointです。安定運用の既定にはしません。"
      : "OpenAI TTS APIで読み上げ音声を生成します。";
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

function syncSeedVcSettingsDefaults() {
  const settings = seedVcSettingsForSelectedBackend();
  if (!settings) {
    return;
  }
  setInputValue(seedVcDiffusionStepsInput, settings.diffusion_steps);
  setInputValue(seedVcReferenceMaxSecondsInput, settings.reference_max_seconds);
  setInputValue(seedVcLengthAdjustInput, settings.length_adjust);
  setInputValue(seedVcInferenceCfgRateInput, settings.inference_cfg_rate);
  syncSeedVcPresetSelection();
}

function syncSeedVcSettingsVisibility() {
  if (!seedVcSettingsPanel) {
    return;
  }
  const selected = [...voiceBackendSelect.options].find((option) => option.value === voiceBackendSelect.value);
  const translationUsesSeedVc =
    operationModeSelect.value === "translation" && selectedVoiceMode() === "convert";
  const voiceConversionUsesSeedVc =
    operationModeSelect.value === "voice_conversion" &&
    voiceBackendSelect.value === "seed-vc" &&
    !Boolean(selected?.disabled);
  seedVcSettingsPanel.hidden =
    !translationUsesSeedVc && !voiceConversionUsesSeedVc;
}

function seedVcSettingsForSelectedBackend() {
  const selected = voiceConversionBackends.find((backend) => backend.id === "seed-vc");
  return selected?.settings?.seed_vc || null;
}

function appendSeedVcSettings(formData, voiceBackend) {
  if (voiceBackend !== "seed-vc") {
    return;
  }
  appendNumberSetting(formData, "seed_vc_diffusion_steps", seedVcDiffusionStepsInput.value);
  appendNumberSetting(formData, "seed_vc_reference_max_seconds", seedVcReferenceMaxSecondsInput.value);
  appendNumberSetting(formData, "seed_vc_length_adjust", seedVcLengthAdjustInput.value);
  appendNumberSetting(formData, "seed_vc_inference_cfg_rate", seedVcInferenceCfgRateInput.value);
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

function numbersEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.0001;
}

function appendNumberSetting(formData, name, value) {
  if (value !== "") {
    formData.append(name, value);
  }
}

function setInputValue(input, value) {
  if (!input || value === undefined || value === null) {
    return;
  }
  input.value = String(value);
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
