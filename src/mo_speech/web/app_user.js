const userRecordButton = document.querySelector("#user-record-button");
const userLanguageLabel = document.querySelector("#user-language-label");
const userStatus = document.querySelector("#user-status");
const userMinimumHint = document.querySelector("#user-minimum-hint");
const recordTimer = document.querySelector("#record-timer");
const userOutputAudio = document.querySelector("#user-output-audio");
const userReplayButton = document.querySelector("#user-replay-button");
const userReplayLabel = document.querySelector("#user-replay-label");
const userProcessingPanel = document.querySelector("#user-processing-panel");
const userProcessingFill = document.querySelector("#user-processing-fill");
const userOutputTexts = document.querySelector("#user-output-texts");
const userOutputTextCard = document.querySelector("#user-output-text-card");
const userOutputTextMode = document.querySelector("#user-output-text-mode");
const userOutputText = document.querySelector("#user-output-text");
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
let lastUserInputBlob = null;
let lastUserInputFileName = "";
let lastAppliedUserRequestSignature = "";
let hasUserOutput = false;
let isUserProcessing = false;
let userDisplayText = {
  kanji_text: "",
  hiragana_text: "",
};
let userTextMode = "hiragana";
let userSettings = {
  target_language: "ja-JP",
  joke_text: "",
  joke_position: "after",
};

userRecordButton.addEventListener("click", handleUserRecordButton);
userReplayButton.addEventListener("click", toggleUserReplay);
userOutputTextCard.addEventListener("click", cycleUserTextMode);
userOutputTextCard.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    cycleUserTextMode();
  }
});
userOutputAudio.addEventListener("ended", syncReplayButton);
userOutputAudio.addEventListener("pause", syncReplayButton);
userOutputAudio.addEventListener("play", syncReplayButton);
[similarVoiceToggle, jokeModeToggle, osakaDialectToggle, variationModeToggle].forEach((toggle) => {
  toggle.addEventListener("change", markUserOutputStale);
});
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
    setUserStatus("しょりちゅう");
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
  hideUserProcessing();
  hasUserOutput = false;
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
  setUserStatus("しょりちゅう");

  try {
    await refreshUserSettings();
    const audioBlob = new Blob(userRecordingChunks, { type: userMediaRecorder?.mimeType || "audio/webm" });
    if (audioBlob.size < 1) {
      throw new Error("ろくおんが ありません");
    }
    lastUserInputBlob = audioBlob;
    lastUserInputFileName = "user-recording.webm";
    await runUserTranslation(audioBlob, lastUserInputFileName);
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

async function runUserTranslation(audioBlob, fileName) {
  isUserProcessing = true;
  hasUserOutput = false;
  userReplayButton.hidden = true;
  setUserProcessingProgress(4);
  const requestSignature = currentUserRequestSignature();
  const formData = buildUserTranslationFormData(audioBlob, fileName);

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
  lastAppliedUserRequestSignature = requestSignature;
  hasUserOutput = true;
  setUserProcessingProgress(100);
  hideUserProcessing();
}

function buildUserTranslationFormData(audioBlob, fileName) {
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
  formData.append("audio", audioBlob, fileName);
  return formData;
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

function currentUserRequestSignature() {
  return JSON.stringify({
    target_language: userTargetLanguage.value || "ja-JP",
    similar_voice: similarVoiceToggle.checked,
    text_transform_options: userTextTransformOptions(),
  });
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
  setUserStatus("しょりちゅう");
  if (job.status === "queued") {
    setUserProcessingProgress(8);
  } else if (stage === "asr") {
    setUserProcessingProgress(25);
  } else if (stage === "translation" || stage === "text_transform") {
    setUserProcessingProgress(stage === "translation" ? 48 : 62);
  } else if (stage === "tts") {
    setUserProcessingProgress(78);
  } else if (stage === "voice_conversion") {
    setUserProcessingProgress(92);
  } else if (stage === "complete") {
    setUserProcessingProgress(100);
  } else if (job.status === "running") {
    setUserProcessingProgress(16);
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
  userDisplayText = {
    kanji_text: text,
    hiragana_text: "よみこみちゅう",
  };
  userTextMode = "hiragana";
  renderUserTextMode();
  try {
    const displayText = await loadUserDisplayText(text, userTargetLanguage.value || "ja-JP");
    userDisplayText = {
      kanji_text: displayText.kanji_text || text,
      hiragana_text: displayText.hiragana_text || text,
    };
    renderUserTextMode();
  } catch (_error) {
    userDisplayText = {
      kanji_text: text,
      hiragana_text: text,
    };
    renderUserTextMode();
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
    syncReplayButton();
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
  await refreshUserSettings();
  if (lastUserInputBlob && hasUserOutput && currentUserRequestSignature() !== lastAppliedUserRequestSignature) {
    await reprocessLatestUserOutput();
    return;
  }
  if (userOutputAudio.paused) {
    await userOutputAudio.play().catch(() => {});
  } else {
    userOutputAudio.pause();
  }
  syncReplayButton();
}

async function reprocessLatestUserOutput() {
  clearUserError();
  userOutputAudio.pause();
  userReplayButton.disabled = true;
  userRecordButton.disabled = true;
  userRecordButton.classList.add("is-processing");
  setUserStatus("しょりちゅう");
  try {
    await runUserTranslation(lastUserInputBlob, lastUserInputFileName || "user-recording.webm");
    setUserStatus("できました");
  } catch (error) {
    renderUserError(error.message || "エラー");
  } finally {
    userReplayButton.disabled = false;
    userRecordButton.disabled = false;
    userRecordButton.classList.remove("is-processing");
    userRecordButton.setAttribute("aria-label", "ろくおん");
    syncReplayButton();
  }
}

function syncReplayButton() {
  if (hasUserOutput && lastAppliedUserRequestSignature !== "" && currentUserRequestSignature() !== lastAppliedUserRequestSignature) {
    userReplayButton.dataset.state = "stale";
    userReplayLabel.textContent = "つくりなおす";
    return;
  }
  const isPlaying = !userOutputAudio.paused && !userOutputAudio.ended;
  userReplayButton.dataset.state = isPlaying ? "playing" : "paused";
  userReplayLabel.textContent = isPlaying ? "とめる" : "もういちど";
}

function markUserOutputStale() {
  if (hasUserOutput) {
    syncReplayButton();
  }
}

function cycleUserTextMode() {
  const modes = ["hiragana", "kanji", "ruby"];
  const nextIndex = (modes.indexOf(userTextMode) + 1) % modes.length;
  userTextMode = modes[nextIndex];
  renderUserTextMode();
}

function renderUserTextMode() {
  const modeLabels = {
    hiragana: "ひらがな",
    kanji: "かんじ",
    ruby: "ルビ",
  };
  userOutputTextMode.textContent = modeLabels[userTextMode] || "ひらがな";
  userOutputText.classList.toggle("ruby-line", userTextMode === "ruby");
  if (userTextMode === "kanji") {
    userOutputText.textContent = userDisplayText.kanji_text;
  } else if (userTextMode === "ruby") {
    const kanji = escapeHtml(userDisplayText.kanji_text);
    const hiragana = escapeHtml(userDisplayText.hiragana_text || userDisplayText.kanji_text);
    userOutputText.innerHTML = `<ruby>${kanji}<rt>${hiragana}</rt></ruby>`;
  } else {
    userOutputText.textContent = userDisplayText.hiragana_text || userDisplayText.kanji_text;
  }
}

function setUserProcessingProgress(percent) {
  userProcessingPanel.hidden = false;
  userProcessingFill.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
}

function hideUserProcessing() {
  userProcessingPanel.hidden = true;
  userProcessingFill.style.width = "0%";
  isUserProcessing = false;
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
  hideUserProcessing();
  userRecordButton.classList.remove("is-recording", "is-locked", "is-ready-to-stop", "is-processing");
  userRecordButton.disabled = false;
  userMinimumHint.hidden = true;
  userMinimumHint.textContent = "5びょう いじょう はなしてください";
  userError.hidden = false;
  userError.textContent = message;
  setUserStatus("もういちど");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
