const userRecordButton = document.querySelector("#user-record-button");
const userStatus = document.querySelector("#user-status");
const userMinimumHint = document.querySelector("#user-minimum-hint");
const userOutputAudio = document.querySelector("#user-output-audio");
const userError = document.querySelector("#user-error");
const userTargetLanguage = document.querySelector("#target_language");
const similarVoiceToggle = document.querySelector("#similar_voice");
const jokeModeToggle = document.querySelector("#joke_mode");
const osakaDialectToggle = document.querySelector("#osaka_dialect");
const variationModeToggle = document.querySelector("#variation_mode");

const minimumRecordingMs = 5000;
let userMediaRecorder = null;
let userRecordingStream = null;
let userRecordingChunks = [];
let userRecordingStartedAt = 0;
let userSettings = {
  target_language: "ja-JP",
  joke_text: "",
  joke_position: "after",
};

userRecordButton.addEventListener("click", handleUserRecordButton);
loadUserSettings();
loadUserRuntime();

async function handleUserRecordButton() {
  clearUserError();
  if (userMediaRecorder && userMediaRecorder.state === "recording") {
    const elapsedMs = performance.now() - userRecordingStartedAt;
    if (elapsedMs < minimumRecordingMs) {
      setUserStatus("もうすこし はなしてください");
      userMinimumHint.hidden = false;
      return;
    }
    setUserStatus("へんかんちゅう");
    userMediaRecorder.stop();
    return;
  }
  await startUserRecording();
}

async function startUserRecording() {
  userOutputAudio.hidden = true;
  userOutputAudio.removeAttribute("src");
  userRecordingChunks = [];
  try {
    userRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    userMediaRecorder = new MediaRecorder(userRecordingStream, chooseUserRecorderOptions());
    userMediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        userRecordingChunks.push(event.data);
      }
    });
    userMediaRecorder.addEventListener("stop", submitUserTranslation);
    userRecordingStartedAt = performance.now();
    userMediaRecorder.start();
    userRecordButton.classList.add("is-recording");
    userMinimumHint.hidden = false;
    setUserStatus("5びょう いじょう はなしてください");
  } catch (error) {
    renderUserError(error.message || "マイクが つかえません");
  }
}

async function submitUserTranslation() {
  stopUserRecordingStream();
  userRecordButton.classList.remove("is-recording");
  userMinimumHint.hidden = true;
  setUserStatus("へんかんちゅう");

  try {
    const audioBlob = new Blob(userRecordingChunks, { type: userMediaRecorder?.mimeType || "audio/webm" });
    if (audioBlob.size < 1) {
      throw new Error("ろくおんが ありません");
    }

    const formData = new FormData();
    formData.append("translation_backend", "openai");
    formData.append("source_language", "auto");
    formData.append("target_language", userTargetLanguage.value || "ja-JP");
    formData.append("voice_mode", similarVoiceToggle.checked ? "convert" : "default");
    if (similarVoiceToggle.checked) {
      formData.append("seed_vc_diffusion_steps", "30");
      formData.append("seed_vc_reference_max_seconds", "10");
      formData.append("seed_vc_reference_auto_select", "true");
      formData.append("seed_vc_length_adjust", "1.0");
      formData.append("seed_vc_inference_cfg_rate", "0.7");
    }

    const textTransformOptions = userTextTransformOptions();
    if (Object.keys(textTransformOptions).length > 0) {
      formData.append("text_transform", "user_effects");
      formData.append("text_transform_options", JSON.stringify(textTransformOptions));
    }
    formData.append("audio", audioBlob, "user-recording.webm");

    const response = await fetch("/api/translate-speech-jobs", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "へんかんできませんでした");
    }

    const job = await response.json();
    renderUserJob(job);
    const completedJob = await pollUserTranslationJob(job.job_id);
    if (!completedJob.result) {
      throw new Error("できたこえが ありません");
    }
    renderUserOutput(completedJob.result);
    setUserStatus("できました");
  } catch (error) {
    renderUserError(error.message || "エラー");
  } finally {
    userRecordingChunks = [];
  }
}

function userTextTransformOptions() {
  const options = {};
  if (osakaDialectToggle.checked) {
    options.osaka_dialect = true;
  }
  if (variationModeToggle.checked) {
    options.variation = true;
  }
  if (jokeModeToggle.checked && userSettings.joke_text) {
    options.joke_text = userSettings.joke_text;
    options.joke_position = userSettings.joke_position || "after";
  }
  return options;
}

async function pollUserTranslationJob(jobId) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const response = await fetch(`/api/translate-speech-jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new Error("じょうたいを よめませんでした");
    }
    const job = await response.json();
    renderUserJob(job);
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "へんかんできませんでした");
    }
  }
}

function renderUserJob(job) {
  const stage = job.current_stage?.stage || "";
  if (job.status === "queued") {
    setUserStatus("じゅんびちゅう");
  } else if (stage === "asr") {
    setUserStatus("きいています");
  } else if (stage === "translation" || stage === "text_transform") {
    setUserStatus("ことばを かえています");
  } else if (stage === "tts") {
    setUserStatus("こえを つくっています");
  } else if (stage === "voice_conversion") {
    setUserStatus("こえを にせています");
  } else if (stage === "complete") {
    setUserStatus("できました");
  } else if (job.status === "running") {
    setUserStatus("へんかんちゅう");
  }
}

function renderUserOutput(result) {
  const mimeType = result.audio_mime_type || "audio/wav";
  const binary = atob(result.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const audioBlob = new Blob([bytes], { type: mimeType });
  userOutputAudio.src = URL.createObjectURL(audioBlob);
  userOutputAudio.hidden = false;
  userOutputAudio.play().catch(() => {});
}

async function loadUserSettings() {
  try {
    const response = await fetch("/api/user-settings");
    if (!response.ok) {
      return;
    }
    userSettings = await response.json();
    userTargetLanguage.value = userSettings.target_language || "ja-JP";
  } catch (_error) {
    userTargetLanguage.value = "ja-JP";
  }
}

async function loadUserRuntime() {
  try {
    const response = await fetch("/api/runtime");
    if (!response.ok) {
      return;
    }
    const runtime = await response.json();
    const openai = (runtime.translation_backends || []).find((backend) => backend.id === "openai");
    if (openai && openai.available === false) {
      setUserStatus("APIキーが ひつようです");
    }
  } catch (_error) {
    return;
  }
}

function chooseUserRecorderOptions() {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return { mimeType: "audio/webm;codecs=opus" };
  }
  if (MediaRecorder.isTypeSupported("audio/webm")) {
    return { mimeType: "audio/webm" };
  }
  return {};
}

function stopUserRecordingStream() {
  if (userRecordingStream) {
    userRecordingStream.getTracks().forEach((track) => track.stop());
  }
  userRecordingStream = null;
}

function setUserStatus(message) {
  userStatus.textContent = message;
}

function clearUserError() {
  userError.hidden = true;
  userError.textContent = "";
}

function renderUserError(message) {
  stopUserRecordingStream();
  userRecordButton.classList.remove("is-recording");
  userMinimumHint.hidden = true;
  userError.hidden = false;
  userError.textContent = message;
  setUserStatus("もういちど");
}
