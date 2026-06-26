async function startRealtimeStreaming(event) {
  event.preventDefault();
  clearError();
  clearResultOutputs();
  await stopRealtimeStreaming();
  setStatus("接続中: OpenAI Realtime streaming");
  submitButton.disabled = true;
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
      const remoteStream = streams[0];
      outputAudio.srcObject = remoteStream;
      outputAudio.autoplay = true;
      outputAudio.play().catch(() => {});
      if (realtimeStreamingSession) {
        realtimeStreamingSession.outputRecording = startRealtimeOutputRecording(remoteStream);
      }
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
    setStatus("接続中: Realtime streaming");
    syncOperationMode();
  } catch (error) {
    await stopRealtimeStreaming({ saveOutput: false });
    renderError(error.message || "Realtime streaming接続に失敗しました");
  } finally {
    submitButton.disabled = false;
    syncOperationMode();
  }
}

async function stopRealtimeStreaming({ saveOutput = true } = {}) {
  if (!realtimeStreamingSession) {
    return;
  }
  const { peerConnection, sourceStream, dataChannel, outputRecording } = realtimeStreamingSession;
  const outputBlobPromise = stopRealtimeOutputRecording(outputRecording);
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.close();
  }
  sourceStream?.getTracks().forEach((track) => track.stop());
  peerConnection?.close();
  realtimeStreamingSession = null;
  stopInputLevelMeter();
  submitButton.disabled = false;
  syncOperationMode();
  const outputBlob = await outputBlobPromise;
  if (!saveOutput) {
    setStatus("切断済み");
    return;
  }
  if (outputBlob && outputBlob.size > 0) {
    renderStreamingOutputBlob(outputBlob);
    try {
      await saveRealtimeStreamingOutput(outputBlob);
      loadAudioHistory();
      setStatus("切断済み: 出力音声を保存しました");
    } catch (error) {
      setStatus("切断済み: 出力音声の保存に失敗", "error");
      errorMessage.textContent = error.message || "streaming出力音声の保存に失敗しました";
      errorMessage.hidden = false;
    }
    return;
  }
  setStatus("切断済み");
}

function startRealtimeOutputRecording(stream) {
  if (!window.MediaRecorder) {
    return null;
  }
  const chunks = [];
  let recorder = null;
  try {
    recorder = new MediaRecorder(stream, chooseRecorderOptions());
  } catch {
    return null;
  }
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.start();
  return { recorder, chunks };
}

function stopRealtimeOutputRecording(outputRecording) {
  if (!outputRecording?.recorder) {
    return Promise.resolve(null);
  }
  const { recorder, chunks } = outputRecording;
  return new Promise((resolve) => {
    const finish = () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const mimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
      resolve(new Blob(chunks, { type: mimeType }));
    };
    if (recorder.state === "inactive") {
      finish();
      return;
    }
    recorder.addEventListener("stop", finish, { once: true });
    recorder.stop();
  });
}

function renderStreamingOutputBlob(blob) {
  setCurrentOutputBlob(blob, `realtime-streaming-output.${extensionForMimeType(blob.type || "audio/webm")}`);
  if (outputAudioObjectUrl) {
    URL.revokeObjectURL(outputAudioObjectUrl);
  }
  outputAudio.srcObject = null;
  outputAudioObjectUrl = URL.createObjectURL(blob);
  outputAudio.src = outputAudioObjectUrl;
  outputAudio.autoplay = false;
}

async function saveRealtimeStreamingOutput(blob) {
  const formData = new FormData();
  const extension = extensionForMimeType(blob.type || "audio/webm");
  formData.append("audio", blob, `realtime-streaming-output.${extension}`);
  formData.append("endpoint", "openai-realtime-streaming");
  formData.append("translation_backend", "openai_realtime_stream");
  formData.append("target_language", form.target_language.value);
  const response = await fetch("/api/audio-history/outputs", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.detail || "streaming出力音声を保存できませんでした");
  }
  return response.json();
}
