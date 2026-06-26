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
  inputHistorySource = null;
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
    renderInputAudioPreview(recordedBlob, recordedFileName);
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
    mediaRecorder.stop();
  }
}

function handleAudioFileChange() {
  const file = audioInput.files[0];
  recordedBlob = null;
  recordedChunks = [];
  recordedFileName = "recording.audio";
  inputHistorySource = null;
  stopInputLevelMeter();
  if (file) {
    recordingLabel.textContent = "ファイル選択済み";
    renderInputAudioPreview(file, file.name);
    return;
  }
  recordingLabel.textContent = "録音なし";
  recordingDetails.textContent = sourceAudioEmptyText();
  clearInputAudioPreview();
}

async function handleTtsTextFileChange() {
  const file = ttsTextFileInput.files[0];
  if (!file) {
    ttsTextFileHint.textContent = "ファイル内容を読み上げテキスト欄へ読み込みます。";
    return;
  }
  try {
    clearError();
    const text = await file.text();
    ttsTextInput.value = text;
    ttsTextFileHint.textContent = `${file.name} を読み込みました（${formatBytes(file.size)}）。必要なら編集してから読み上げます。`;
    setStatus("テキストファイルを読み込みました");
  } catch (error) {
    ttsTextFileInput.value = "";
    renderError(error.message || "テキストファイルを読み込めませんでした");
  }
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

function renderInputAudioPreview(blob, filename = "") {
  if (inputAudioObjectUrl) {
    URL.revokeObjectURL(inputAudioObjectUrl);
  }
  inputAudioObjectUrl = URL.createObjectURL(blob);
  inputAudio.src = inputAudioObjectUrl;
  inputAudio.hidden = false;
  const name = filename || "選択済み音声";
  recordingDetails.textContent = `${name} / ${blob.type || "unknown"} / ${formatBytes(blob.size)}`;
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

function setCurrentOutputBlob(blob, filename) {
  currentOutputBlob = blob;
  currentOutputFileName = filename || `output.${extensionForMimeType(blob.type || "audio/wav")}`;
  useOutputAsInputButton.disabled = false;
  useOutputAsReferenceButton.disabled = false;
}

function clearCurrentOutputBlob() {
  currentOutputBlob = null;
  currentOutputFileName = "output.audio";
  useOutputAsInputButton.disabled = true;
  useOutputAsReferenceButton.disabled = true;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
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
