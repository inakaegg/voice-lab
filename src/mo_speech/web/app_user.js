const userRecordButton = document.querySelector("#user-record-button");
const userLanguageLabel = document.querySelector("#user-language-label");
const userStatus = document.querySelector("#user-status");
const userMinimumHint = document.querySelector("#user-minimum-hint");
const recordTimer = document.querySelector("#record-timer");
const userOutputAudio = document.querySelector("#user-output-audio");
const userReplayButton = document.querySelector("#user-replay-button");
const userReplayLabel = document.querySelector("#user-replay-label");
const userOutputTexts = document.querySelector("#user-output-texts");
const userOutputHiragana = document.querySelector("#user-output-hiragana");
const userOutputKanji = document.querySelector("#user-output-kanji");
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
let recordTimerId = null;
let currentUserOutputUrl = "";
let userSettings = {
  target_language: "ja-JP",
  joke_text: "",
  joke_position: "after",
};

userRecordButton.addEventListener("click", handleUserRecordButton);
userReplayButton.addEventListener("click", toggleUserReplay);
userOutputAudio.addEventListener("ended", syncReplayButton);
userOutputAudio.addEventListener("pause", syncReplayButton);
userOutputAudio.addEventListener("play", syncReplayButton);
refreshUserSettings();
loadUserRuntime();

async function handleUserRecordButton() {
  clearUserError();
  if (userMediaRecorder && userMediaRecorder.state === "recording") {
    const elapsedMs = performance.now() - userRecordingStartedAt;
    if (elapsedMs < minimumRecordingMs) {
      setUserStatus("もうすこし はなしてください");
      userMinimumHint.hidden = false;
      nudgeRecordButton();
      return;
    }
    setUserStatus("へんかんちゅう");
    userRecordButton.classList.remove("is-recording", "is-ready-to-stop");
    userRecordButton.classList.add("is-processing");
    userMediaRecorder.stop();
    return;
  }
  await startUserRecording();
}

async function startUserRecording() {
  await refreshUserSettings();
  userOutputAudio.hidden = true;
  userReplayButton.hidden = true;
  userOutputTexts.hidden = true;
  userOutputAudio.removeAttribute("src");
  if (currentUserOutputUrl) {
    URL.revokeObjectURL(currentUserOutputUrl);
    currentUserOutputUrl = "";
  }
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
    userRecordButton.classList.add("is-recording", "is-locked");
    userRecordButton.style.setProperty("--record-progress", "0deg");
    userRecordButton.setAttribute("aria-label", "ろくおんちゅう");
    userMinimumHint.textContent = "5びょう いじょう はなしてください";
    userMinimumHint.hidden = false;
    setUserStatus("5びょう いじょう はなしてください");
    startRecordTimer();
  } catch (error) {
    renderUserError(error.message || "マイクが つかえません");
  }
}

async function submitUserTranslation() {
  stopUserRecordingStream();
  stopRecordTimer();
  userRecordButton.classList.remove("is-recording", "is-locked", "is-ready-to-stop");
  userRecordButton.classList.add("is-processing");
  userRecordButton.disabled = true;
  userMinimumHint.hidden = true;
  setUserStatus("へんかんちゅう");

  try {
    await refreshUserSettings();
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
    await renderUserResult(completedJob.result);
    setUserStatus("できました");
  } catch (error) {
    renderUserError(error.message || "エラー");
  } finally {
    userRecordingChunks = [];
    userRecordButton.disabled = false;
    userRecordButton.classList.remove("is-processing");
    userRecordButton.setAttribute("aria-label", "ろくおん");
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

async function renderUserResult(result) {
  await renderUserTexts(result);
  renderUserOutput(result);
}

async function renderUserTexts(result) {
  const text = (result.transformed_text || result.translated_text || "").trim();
  if (!text) {
    userOutputTexts.hidden = true;
    return;
  }
  userOutputTexts.hidden = false;
  userOutputKanji.textContent = text;
  userOutputHiragana.textContent = "よみこみちゅう";
  try {
    const displayText = await loadUserDisplayText(text, userTargetLanguage.value || "ja-JP");
    userOutputKanji.textContent = displayText.kanji_text || text;
    userOutputHiragana.textContent = displayText.hiragana_text || text;
  } catch (_error) {
    userOutputHiragana.textContent = text;
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
  if (currentUserOutputUrl) {
    URL.revokeObjectURL(currentUserOutputUrl);
  }
  currentUserOutputUrl = URL.createObjectURL(audioBlob);
  userOutputAudio.src = currentUserOutputUrl;
  userOutputAudio.hidden = true;
  userReplayButton.hidden = false;
  userOutputAudio.play().catch(() => {});
  syncReplayButton();
}

async function refreshUserSettings() {
  try {
    const response = await fetch("/api/user-settings", { cache: "no-store" });
    if (!response.ok) {
      return userSettings;
    }
    userSettings = await response.json();
    userTargetLanguage.value = userSettings.target_language || "ja-JP";
    renderUserLanguageLabel();
  } catch (_error) {
    userTargetLanguage.value = "ja-JP";
  }
  return userSettings;
}

async function loadUserDisplayText(text, targetLanguage) {
  const response = await fetch("/api/user-display-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target_language: targetLanguage }),
  });
  if (!response.ok) {
    throw new Error("ひらがなを つくれませんでした");
  }
  return response.json();
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

function startRecordTimer() {
  stopRecordTimer();
  updateRecordTimer();
  recordTimerId = window.setInterval(updateRecordTimer, 100);
}

function stopRecordTimer() {
  if (recordTimerId !== null) {
    window.clearInterval(recordTimerId);
  }
  recordTimerId = null;
  userRecordButton.style.setProperty("--record-progress", "0deg");
  recordTimer.textContent = "5";
}

function updateRecordTimer() {
  const elapsedMs = performance.now() - userRecordingStartedAt;
  const progress = Math.min(elapsedMs / minimumRecordingMs, 1);
  const remainingSeconds = Math.max(Math.ceil((minimumRecordingMs - elapsedMs) / 1000), 0);
  userRecordButton.style.setProperty("--record-progress", `${Math.round(progress * 360)}deg`);
  if (progress < 1) {
    userRecordButton.classList.add("is-locked");
    userRecordButton.classList.remove("is-ready-to-stop");
    recordTimer.textContent = String(remainingSeconds);
    return;
  }
  userRecordButton.classList.remove("is-locked");
  userRecordButton.classList.add("is-ready-to-stop");
  recordTimer.textContent = "OK";
  userMinimumHint.textContent = "おすと とまる";
  setUserStatus("ろくおんちゅう");
}

function nudgeRecordButton() {
  userRecordButton.classList.remove("is-nudged");
  window.requestAnimationFrame(() => {
    userRecordButton.classList.add("is-nudged");
  });
}

async function toggleUserReplay() {
  if (!userOutputAudio.src) {
    return;
  }
  if (userOutputAudio.paused) {
    await userOutputAudio.play().catch(() => {});
  } else {
    userOutputAudio.pause();
  }
  syncReplayButton();
}

function syncReplayButton() {
  const isPlaying = !userOutputAudio.paused && !userOutputAudio.ended;
  userReplayButton.dataset.state = isPlaying ? "playing" : "paused";
  userReplayLabel.textContent = isPlaying ? "とめる" : "もういちど";
}

function renderUserLanguageLabel() {
  const labels = {
    "ja-JP": "にほんご へ へんかん",
    "id-ID": "インドネシアご へ へんかん",
    "zh-CN": "ちゅうごくご へ へんかん",
    "en-US": "えいご へ へんかん",
  };
  userLanguageLabel.textContent = labels[userTargetLanguage.value] || "ことばを へんかん";
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
  stopRecordTimer();
  userRecordButton.classList.remove("is-recording", "is-locked", "is-ready-to-stop", "is-processing");
  userRecordButton.disabled = false;
  userMinimumHint.hidden = true;
  userMinimumHint.textContent = "5びょう いじょう はなしてください";
  userError.hidden = false;
  userError.textContent = message;
  setUserStatus("もういちど");
}
