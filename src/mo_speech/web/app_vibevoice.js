const form = document.querySelector("#vibevoice-form");
const generateButton = document.querySelector("#vibevoice-generate-button");
const message = document.querySelector("#vibevoice-message");
const runtimeStatus = document.querySelector("#vibevoice-runtime-status");
const runtimeDetails = document.querySelector("#vibevoice-runtime-details");
const resultPanel = document.querySelector("#vibevoice-result");
const audio = document.querySelector("#vibevoice-audio");
const downloadLink = document.querySelector("#vibevoice-download");
const normalizedScript = document.querySelector("#vibevoice-normalized-script");
const diagnostics = document.querySelector("#vibevoice-diagnostics");
const cancelButton = document.querySelector("#vibevoice-cancel-button");
const jobProgress = document.querySelector("#vibevoice-job-progress");
const timingLabel = document.querySelector("#vibevoice-timing");
const scriptInput = document.querySelector("#vibevoice-script");
const scriptFileInput = document.querySelector("#vibevoice-script-file");
const voiceFileInputs = Array.from(form.querySelectorAll('input[type="file"][name^="voice_file_"]'));
const savedVoiceLabels = Array.from(document.querySelectorAll("[data-saved-voice-slot]"));
const rangeInputs = Array.from(form.querySelectorAll("[data-vibevoice-range]"));
const savedVoiceDbName = "mo-speech-vibevoice";
const savedVoiceStoreName = "voice-files";
const vibevoiceSettingsStorageKey = "mo-speech-vibevoice-draft";
const persistedFieldNames = [
  "backend",
  "model_id",
  "cfg_scale",
  "inference_steps",
  "seed",
  "temperature",
  "top_p",
  "top_k",
  "max_voice_seconds",
  "line_gap",
  "do_sample",
  "line_by_line",
];
const persistedControls = persistedFieldNames
  .map((name) => form.elements[name])
  .filter((control) => control && typeof control.name === "string");
const savedVoiceFilesBySlot = new Map();

let currentAudioUrl = "";
let savedVoiceFilesReady = Promise.resolve();
let currentJobId = "";
let jobPollTimer = 0;
let elapsedTimer = 0;
let jobStartedAt = 0;

form.addEventListener("submit", handleGenerate);
cancelButton.addEventListener("click", cancelVibeVoiceJob);
scriptInput.addEventListener("input", saveVibeVoiceDraft);
scriptFileInput.addEventListener("change", handleScriptFileChange);
persistedControls.forEach((control) => {
  const eventName = control.type === "checkbox" || control.tagName === "SELECT" ? "change" : "input";
  control.addEventListener(eventName, saveVibeVoiceDraft);
});
voiceFileInputs.forEach((input) => {
  input.addEventListener("change", () => handleVoiceFileChange(input));
});
loadVibeVoiceDraft();
rangeInputs.forEach((input) => {
  input.addEventListener("input", () => renderRangeValue(input));
  renderRangeValue(input);
});
loadStatus();
savedVoiceFilesReady = loadSavedVoiceFiles();

function loadVibeVoiceDraft() {
  const draft = readVibeVoiceDraft();
  if (!draft || typeof draft !== "object") {
    return;
  }
  if (typeof draft.script === "string") {
    scriptInput.value = draft.script;
  }
  const settings = draft.settings && typeof draft.settings === "object" ? draft.settings : {};
  for (const control of persistedControls) {
    if (!Object.hasOwn(settings, control.name)) {
      continue;
    }
    restoreControlValue(control, settings[control.name]);
  }
}

function readVibeVoiceDraft() {
  try {
    const value = localStorage.getItem(vibevoiceSettingsStorageKey);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function saveVibeVoiceDraft() {
  const settings = {};
  for (const control of persistedControls) {
    settings[control.name] = control.type === "checkbox" ? control.checked : control.value;
  }
  try {
    localStorage.setItem(
      vibevoiceSettingsStorageKey,
      JSON.stringify({
        script: scriptInput.value,
        settings,
      }),
    );
  } catch {
    // 保存できない環境でも生成自体は続ける。
  }
}

function restoreControlValue(control, value) {
  if (control.type === "checkbox") {
    control.checked = value === true || value === "true";
    return;
  }
  const nextValue = String(value);
  if (control.tagName === "SELECT" && !Array.from(control.options).some((option) => option.value === nextValue)) {
    return;
  }
  control.value = nextValue;
}

async function loadStatus() {
  try {
    const response = await fetch("/api/vibevoice/status");
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const status = await response.json();
    renderStatus(status);
  } catch (error) {
    runtimeStatus.textContent = "実行環境を確認できませんでした";
    runtimeStatus.dataset.state = "error";
    runtimeDetails.textContent = String(error.message || error);
  }
}

function renderStatus(status) {
  const localStatus = status.backends?.local || status;
  const runpodStatus = status.backends?.runpod_serverless || {};
  const modelLabels = Array.isArray(localStatus.model_presets)
    ? localStatus.model_presets.map((preset) => preset.label || preset.model_id).join(" / ")
    : "";
  runtimeStatus.dataset.state = localStatus.available ? "ready" : "missing";
  runtimeStatus.textContent = localStatus.available ? "ローカル実行できます" : "ローカルモデルまたはCLIが見つかりません";
  runtimeDetails.replaceChildren(
    detailItem("Default Model", localStatus.default_model_id || ""),
    detailItem("Selectable Models", modelLabels),
    detailItem("Local CLI", localStatus.cli_exists ? localStatus.cli_path : `${localStatus.cli_path} (missing)`),
    detailItem(
      "Local Module",
      localStatus.comfyui_vibevoice_exists
        ? localStatus.comfyui_vibevoice_path
        : `${localStatus.comfyui_vibevoice_path} (missing)`,
    ),
    detailItem("Local Model", localStatus.model_cache_found ? localStatus.model_cache_path : "missing"),
    detailItem("Local Tokenizer", localStatus.tokenizer_found ? localStatus.tokenizer_path : "missing"),
    detailItem("RunPod", runpodStatus.available ? `configured (${runpodStatus.request_mode})` : runpodStatus.reason || "not configured"),
    detailItem("Timeout", `${localStatus.timeout_seconds}s`),
  );
}

function detailItem(label, value) {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = String(value || "");
  fragment.append(dt, dd);
  return fragment;
}

function renderRangeValue(input) {
  const output = form.querySelector(`[data-vibevoice-range-output="${input.name}"]`);
  if (!output) {
    return;
  }
  output.textContent = formatRangeValue(input);
}

function formatRangeValue(input) {
  const value = Number(input.value || 0);
  const step = String(input.step || "");
  if (!Number.isFinite(value)) {
    return input.value || "";
  }
  if (!step.includes(".") || Number.isInteger(value)) {
    return String(Math.round(value));
  }
  const decimals = step.split(".")[1]?.length || 0;
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

async function handleGenerate(event) {
  event.preventDefault();
  saveVibeVoiceDraft();
  clearResult();
  setBusy(true, "生成中です。初回はモデルロードに時間がかかります。");
  try {
    const body = new FormData(form);
    const requiredSlots = requiredVoiceSlotsFromScript(scriptInput.value);
    const voiceState = await appendVoiceFiles(body, requiredSlots);
    if (voiceState.missingSlots.length > 0) {
      throw new Error(`Speaker ${voiceState.missingSlots.join(", ")} の参照音声を指定してください。`);
    }
    if (voiceState.count < 1) {
      throw new Error("参照音声を1つ以上指定してください。");
    }
    body.set("do_sample", form.elements.do_sample.checked ? "true" : "false");
    body.set("line_by_line", form.elements.line_by_line.checked ? "true" : "false");
    const response = await fetch("/api/vibevoice/jobs", {
      method: "POST",
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `generation failed: ${response.status}`);
    }
    currentJobId = payload.job_id || "";
    if (!currentJobId) {
      throw new Error("job_idが返りませんでした。");
    }
    startJobProgress(payload);
    await pollVibeVoiceJob(currentJobId);
  } catch (error) {
    stopJobProgress();
    setBusy(false, "");
    message.textContent = String(error.message || error);
    message.dataset.state = "error";
  }
}

async function handleScriptFileChange() {
  const file = scriptFileInput.files?.[0];
  if (!file) {
    return;
  }
  try {
    scriptInput.value = await file.text();
    saveVibeVoiceDraft();
    message.dataset.state = "ready";
    message.textContent = `${file.name} を台本へ読み込みました。`;
  } catch (error) {
    message.dataset.state = "error";
    message.textContent = `テキストファイルを読み込めませんでした: ${error.message || error}`;
  }
}

async function handleVoiceFileChange(input) {
  const slot = voiceSlotFromInput(input);
  const file = input.files?.[0];
  if (!slot || !file) {
    return;
  }
  try {
    await saveVoiceFile(slot, file);
    const record = voiceRecordFromFile(slot, file);
    savedVoiceFilesBySlot.set(slot, record);
    renderSavedVoiceFile(slot, record);
    message.dataset.state = "ready";
    message.textContent = `Speaker ${slot} の参照音声を保存しました。`;
  } catch (error) {
    message.dataset.state = "error";
    message.textContent = `参照音声を保存できませんでした: ${error.message || error}`;
  }
}

async function appendVoiceFiles(body, requiredSlots = null) {
  await savedVoiceFilesReady;
  let count = 0;
  const missingSlots = [];
  for (const input of voiceFileInputs) {
    const slot = voiceSlotFromInput(input);
    if (!slot) {
      continue;
    }
    body.delete(input.name);
    if (requiredSlots && !requiredSlots.has(slot)) {
      continue;
    }
    const selectedFile = input.files?.[0];
    if (selectedFile && selectedFile.size > 0) {
      body.set(input.name, selectedFile, selectedFile.name || `voice-${slot}`);
      count += 1;
      continue;
    }
    const saved = savedVoiceFilesBySlot.get(slot);
    if (saved?.blob) {
      body.set(input.name, saved.blob, saved.name || `voice-${slot}`);
      count += 1;
      continue;
    }
    missingSlots.push(slot);
  }
  return { count, missingSlots };
}

function requiredVoiceSlotsFromScript(scriptText) {
  const slots = new Set();
  const lines = String(scriptText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return new Set(["1"]);
  }
  for (const line of lines) {
    const speakerMatch = line.match(/^Speaker\s+([1-4])\s*:/i);
    if (speakerMatch) {
      slots.add(speakerMatch[1]);
      continue;
    }
    const shortMatch = line.match(/^([1-4]|[A-Da-d]):?\s+.+$/);
    if (shortMatch) {
      slots.add(slotFromShortTag(shortMatch[1]));
      continue;
    }
    slots.add("1");
  }
  return slots;
}

function slotFromShortTag(tag) {
  if (/^[1-4]$/.test(tag)) {
    return tag;
  }
  return String(tag.toUpperCase().charCodeAt(0) - "A".charCodeAt(0) + 1);
}

function startJobProgress(payload) {
  jobStartedAt = performance.now();
  jobProgress.hidden = false;
  renderJobProgress(payload);
  clearInterval(elapsedTimer);
  elapsedTimer = window.setInterval(() => {
    if (!currentJobId) {
      return;
    }
    renderElapsed();
  }, 500);
}

async function pollVibeVoiceJob(jobId) {
  clearTimeout(jobPollTimer);
  const response = await fetch(`/api/vibevoice/jobs/${encodeURIComponent(jobId)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `job status failed: ${response.status}`);
  }
  if (jobId !== currentJobId) {
    return;
  }
  renderJobProgress(payload);
  if (payload.status === "succeeded") {
    stopJobProgress({ keepTiming: true });
    renderResult(payload.result || {});
    renderElapsed(payload.elapsed_ms);
    setBusy(false, "生成しました。");
    currentJobId = "";
    return;
  }
  if (payload.status === "failed" || payload.status === "cancelled") {
    const errorText = payload.error || (payload.status === "cancelled" ? "キャンセルしました。" : "生成に失敗しました。");
    stopJobProgress({ keepTiming: true });
    setBusy(false, "");
    message.textContent = errorText;
    message.dataset.state = payload.status === "cancelled" ? "ready" : "error";
    currentJobId = "";
    return;
  }
  jobPollTimer = window.setTimeout(() => {
    pollVibeVoiceJob(jobId).catch((error) => {
      stopJobProgress({ keepTiming: true });
      setBusy(false, "");
      message.textContent = String(error.message || error);
      message.dataset.state = "error";
      currentJobId = "";
    });
  }, 1200);
}

async function cancelVibeVoiceJob() {
  if (!currentJobId) {
    return;
  }
  cancelButton.disabled = true;
  message.dataset.state = "busy";
  message.textContent = "キャンセル中です。";
  try {
    await fetch(`/api/vibevoice/jobs/${encodeURIComponent(currentJobId)}/cancel`, { method: "POST" });
  } catch (error) {
    message.dataset.state = "error";
    message.textContent = `キャンセル要求に失敗しました: ${error.message || error}`;
  }
}

function renderJobProgress(payload) {
  const stage = payload.current_stage || {};
  const label = stage.label || statusLabel(payload.status);
  message.dataset.state = payload.status === "failed" ? "error" : "busy";
  message.textContent = label ? `${label}...` : "生成中です。";
  renderElapsed(payload.elapsed_ms);
}

function renderElapsed(elapsedMs = null) {
  const elapsed = Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) > 0 ? Number(elapsedMs) : performance.now() - jobStartedAt;
  timingLabel.textContent = `経過 ${formatDuration(elapsed)}`;
}

function stopJobProgress({ keepTiming = false } = {}) {
  clearTimeout(jobPollTimer);
  clearInterval(elapsedTimer);
  jobPollTimer = 0;
  elapsedTimer = 0;
  cancelButton.disabled = false;
  if (!keepTiming) {
    timingLabel.textContent = "";
    jobProgress.hidden = true;
  }
}

function statusLabel(status) {
  switch (status) {
    case "queued":
      return "待機中";
    case "running":
      return "生成中";
    case "cancelling":
      return "キャンセル中";
    default:
      return "";
  }
}

async function loadSavedVoiceFiles() {
  for (const label of savedVoiceLabels) {
    renderSavedVoiceFile(label.dataset.savedVoiceSlot, null);
  }
  try {
    const records = await getAllSavedVoiceFiles();
    for (const record of records) {
      if (!record?.slot || !record.blob) {
        continue;
      }
      savedVoiceFilesBySlot.set(String(record.slot), record);
      renderSavedVoiceFile(String(record.slot), record);
    }
  } catch {
    for (const label of savedVoiceLabels) {
      label.textContent = "このブラウザでは保存できません";
    }
  }
}

function renderSavedVoiceFile(slot, record) {
  const label = savedVoiceLabels.find((element) => element.dataset.savedVoiceSlot === String(slot));
  if (!label) {
    return;
  }
  if (!record) {
    label.textContent = "未保存";
    return;
  }
  label.textContent = `保存済み: ${record.name || `voice-${slot}`} (${formatBytes(record.size || record.blob?.size || 0)})`;
}

function voiceSlotFromInput(input) {
  return String(input?.name || "").replace("voice_file_", "");
}

function voiceRecordFromFile(slot, file) {
  return {
    slot: String(slot),
    name: file.name || `voice-${slot}`,
    type: file.type || "application/octet-stream",
    size: file.size || 0,
    lastModified: file.lastModified || Date.now(),
    blob: file,
  };
}

function saveVoiceFile(slot, file) {
  return withSavedVoiceStore("readwrite", (store, resolve, reject) => {
    const request = store.put(voiceRecordFromFile(slot, file));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("IndexedDB write failed"));
  });
}

function getAllSavedVoiceFiles() {
  return withSavedVoiceStore("readonly", (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
}

function withSavedVoiceStore(mode, callback) {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(savedVoiceDbName, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(savedVoiceStoreName)) {
        db.createObjectStore(savedVoiceStoreName, { keyPath: "slot" });
      }
    };
    openRequest.onerror = () => reject(openRequest.error || new Error("IndexedDB open failed"));
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const transaction = db.transaction(savedVoiceStoreName, mode);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("IndexedDB transaction failed"));
      };
      callback(transaction.objectStore(savedVoiceStoreName), resolve, reject);
    };
  });
}

function renderResult(payload) {
  const audioBytes = base64ToBytes(payload.audio_base64 || "");
  const blob = new Blob([audioBytes], { type: payload.audio_mime_type || "audio/wav" });
  currentAudioUrl = URL.createObjectURL(blob);
  audio.src = currentAudioUrl;
  downloadLink.href = currentAudioUrl;
  normalizedScript.textContent = payload.normalized_script || "";
  diagnostics.textContent = JSON.stringify(
    {
      providers: payload.providers || {},
      timings_ms: payload.timings_ms || {},
      diagnostics: payload.diagnostics || {},
    },
    null,
    2,
  );
  resultPanel.hidden = false;
  audio.play().catch(() => {});
}

function clearResult() {
  stopJobProgress();
  currentJobId = "";
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = "";
  }
  audio.removeAttribute("src");
  downloadLink.href = "#";
  normalizedScript.textContent = "";
  diagnostics.textContent = "";
  resultPanel.hidden = true;
}

function setBusy(busy, text) {
  generateButton.disabled = busy;
  generateButton.textContent = busy ? "生成中..." : "生成";
  cancelButton.hidden = !busy;
  if (busy) {
    jobProgress.hidden = false;
  } else if (!timingLabel.textContent) {
    jobProgress.hidden = true;
  }
  message.dataset.state = busy ? "busy" : "ready";
  message.textContent = text;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}秒`;
  }
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}
