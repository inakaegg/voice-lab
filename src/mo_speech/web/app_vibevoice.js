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
const copyDiagnosticsButton = document.querySelector("#vibevoice-copy-diagnostics");
const speakerScriptsContainer = document.querySelector("#vibevoice-speaker-scripts");
const artifactsContainer = document.querySelector("#vibevoice-artifacts");
const cancelButton = document.querySelector("#vibevoice-cancel-button");
const jobProgress = document.querySelector("#vibevoice-job-progress");
const timingLabel = document.querySelector("#vibevoice-timing");
const progressLog = document.querySelector("#vibevoice-progress-log");
const progressBar = document.querySelector(".vibevoice-progress-bar");
const progressFill = progressBar?.querySelector("span");
const scriptInput = document.querySelector("#vibevoice-script");
const scriptFileInput = document.querySelector("#vibevoice-script-file");
const resetSettingsButton = document.querySelector("#vibevoice-reset-settings-button");
const backendSelect = form.elements.backend;
const modelSelect = form.elements.model_id;
const lineByLineControl = form.elements.line_by_line;
const lineByLineSwitch = lineByLineControl?.closest(".vibevoice-switch");
const directedLineModeControl = form.elements.directed_line_mode;
const directedLineModeSwitch = directedLineModeControl?.closest(".vibevoice-switch");
const directedRetryLowScoreControl = form.elements.directed_retry_low_score;
const directedRetryLowScoreSwitch = directedRetryLowScoreControl?.closest(".vibevoice-switch");
const directedRetrySettingControls = Array.from(form.querySelectorAll("[data-directed-retry-setting] input"));
const voiceFileInputs = Array.from(form.querySelectorAll('input[type="file"][name^="voice_file_"]'));
const savedVoiceLabels = Array.from(document.querySelectorAll("[data-saved-voice-slot]"));
const savedVoicePreviews = Array.from(document.querySelectorAll("[data-saved-voice-preview-slot]"));
const referenceUrlSlotSelect = document.querySelector("#vibevoice-reference-url-slot");
const referenceUrlInput = document.querySelector("#vibevoice-reference-url");
const referenceUrlStartInput = document.querySelector("#vibevoice-reference-url-start");
const referenceUrlDurationInput = document.querySelector("#vibevoice-reference-url-duration");
const referenceUrlButton = document.querySelector("#vibevoice-reference-url-button");
const referenceUrlStatus = document.querySelector("#vibevoice-reference-url-status");
const rangeInputs = Array.from(form.querySelectorAll("[data-vibevoice-range]"));
const savedVoiceDbName = "mo-speech-vibevoice";
const savedVoiceStoreName = "voice-files";
const vibevoiceSettingsStorageKey = "mo-speech-vibevoice-draft";
const autoLineByLineMinLines = 4;
const autoLineByLineMinChars = 180;
const directedTargetMaxChars = 120;
const directedLineMaxChars = 180;
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
  "directed_line_mode",
  "directed_retry_low_score",
  "directed_retry_score_threshold",
  "directed_retry_max_lines",
];
const persistedControls = persistedFieldNames
  .map((name) => form.elements[name])
  .filter((control) => control && typeof control.name === "string");
const defaultGenerationSettings = Object.fromEntries(
  persistedControls.map((control) => [control.name, defaultControlValue(control)]),
);
const savedVoiceFilesBySlot = new Map();

let currentAudioUrl = "";
let artifactAudioUrls = [];
const savedVoicePreviewUrls = new Map();
let savedVoiceFilesReady = Promise.resolve();
let currentJobId = "";
let jobPollTimer = 0;
let elapsedTimer = 0;
let jobStartedAt = 0;
let copyDiagnosticsResetTimer = 0;
let lineByLineUserPreference = lineByLineControl?.checked === true;
let generationBusy = false;
let referenceUrlFetching = false;

form.addEventListener("submit", handleGenerate);
cancelButton.addEventListener("click", cancelVibeVoiceJob);
resetSettingsButton.addEventListener("click", resetVibeVoiceGenerationSettings);
copyDiagnosticsButton?.addEventListener("click", copyDiagnosticsToClipboard);
referenceUrlButton?.addEventListener("click", handleReferenceUrlFetch);
scriptInput.addEventListener("input", () => {
  updateLineByLineAutoState();
  updateDirectedLineModeState();
  saveVibeVoiceDraft();
});
scriptFileInput.addEventListener("change", handleScriptFileChange);
persistedControls.forEach((control) => {
  if (control === lineByLineControl) {
    control.addEventListener("change", () => {
      lineByLineUserPreference = control.checked;
      updateLineByLineAutoState();
      updateDirectedLineModeState();
      saveVibeVoiceDraft();
    });
    return;
  }
  if (control === directedLineModeControl) {
    control.addEventListener("change", () => {
      updateDirectedLineModeState();
      saveVibeVoiceDraft();
    });
    return;
  }
  if (control === directedRetryLowScoreControl) {
    control.addEventListener("change", () => {
      updateDirectedLineModeState();
      saveVibeVoiceDraft();
    });
    return;
  }
  if (control === backendSelect) {
    control.addEventListener("change", () => {
      updateModelAvailability();
      updateLineByLineAutoState();
      updateDirectedLineModeState();
      saveVibeVoiceDraft();
    });
    return;
  }
  if (control === modelSelect) {
    control.addEventListener("change", () => {
      updateLineByLineAutoState();
      updateDirectedLineModeState();
      saveVibeVoiceDraft();
    });
    return;
  }
  const eventName = control.type === "checkbox" || control.tagName === "SELECT" ? "change" : "input";
  control.addEventListener(eventName, saveVibeVoiceDraft);
});
voiceFileInputs.forEach((input) => {
  input.addEventListener("change", () => handleVoiceFileChange(input));
});
savedVoicePreviews.forEach((preview) => {
  preview.addEventListener("click", stopPreviewEventPropagation);
  preview.addEventListener("pointerdown", stopPreviewEventPropagation);
});
loadVibeVoiceDraft();
updateModelAvailability();
updateLineByLineAutoState();
updateDirectedLineModeState();
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
    if (control === lineByLineControl) {
      lineByLineUserPreference = checkboxValue(settings[control.name]);
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
    if (control === lineByLineControl) {
      settings[control.name] = lineByLineUserPreference;
      continue;
    }
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

function defaultControlValue(control) {
  if (control.type === "checkbox") {
    return control.defaultChecked;
  }
  if (control.tagName === "SELECT") {
    const selectedOption = Array.from(control.options).find((option) => option.defaultSelected);
    return selectedOption?.value || control.options[0]?.value || "";
  }
  return control.defaultValue;
}

function restoreControlValue(control, value) {
  if (control.type === "checkbox") {
    control.checked = checkboxValue(value);
    return;
  }
  const nextValue = String(value);
  if (control.tagName === "SELECT" && !Array.from(control.options).some((option) => option.value === nextValue)) {
    return;
  }
  control.value = nextValue;
}

function resetVibeVoiceGenerationSettings() {
  for (const control of persistedControls) {
    const defaultValue = defaultGenerationSettings[control.name];
    if (control === lineByLineControl) {
      lineByLineUserPreference = checkboxValue(defaultValue);
      control.checked = lineByLineUserPreference;
      continue;
    }
    restoreControlValue(control, defaultValue);
  }
  updateModelAvailability();
  updateLineByLineAutoState();
  updateDirectedLineModeState();
  rangeInputs.forEach((input) => renderRangeValue(input));
  saveVibeVoiceDraft();
  message.dataset.state = "ready";
  message.textContent = "生成設定をデフォルトに戻しました。";
}

function checkboxValue(value) {
  return value === true || value === "true";
}

function updateModelAvailability() {
  if (!backendSelect || !modelSelect) {
    return;
  }
  const backend = backendSelect.value || "local";
  let firstAvailableOption = null;
  let selectedOptionIsAvailable = false;
  for (const option of Array.from(modelSelect.options)) {
    const allowedBackends = String(option.dataset.vibevoiceBackends || "local runpod_serverless")
      .split(/\s+/)
      .filter(Boolean);
    option.disabled = !allowedBackends.includes(backend);
    if (!option.disabled && firstAvailableOption === null) {
      firstAvailableOption = option;
    }
    if (option.selected && !option.disabled) {
      selectedOptionIsAvailable = true;
    }
  }
  if (!selectedOptionIsAvailable && firstAvailableOption !== null) {
    firstAvailableOption.selected = true;
  }
}

function updateLineByLineAutoState() {
  if (!lineByLineControl) {
    return;
  }
  const directedLineModeEnabled = directedLineModeControl?.checked === true;
  const autoLineByLine = directedLineModeEnabled ? false : shouldAutoLineByLine(scriptInput.value);
  lineByLineControl.disabled = autoLineByLine || directedLineModeEnabled;
  lineByLineControl.checked = directedLineModeEnabled ? false : autoLineByLine || lineByLineUserPreference;
  if (lineByLineSwitch) {
    lineByLineSwitch.dataset.autoLineByLine = autoLineByLine ? "true" : "false";
  }
}

function updateDirectedLineModeState() {
  const directedLineModeEnabled = directedLineModeControl?.checked === true;
  const retryLowScoreEnabled = directedLineModeEnabled && directedRetryLowScoreControl?.checked === true;
  if (directedLineModeSwitch) {
    directedLineModeSwitch.dataset.directedLineMode = directedLineModeEnabled ? "true" : "false";
  }
  if (directedRetryLowScoreControl) {
    directedRetryLowScoreControl.disabled = !directedLineModeEnabled;
  }
  if (directedRetryLowScoreSwitch) {
    directedRetryLowScoreSwitch.dataset.directedRetryLowScore = retryLowScoreEnabled ? "true" : "false";
  }
  directedRetrySettingControls.forEach((control) => {
    control.disabled = !retryLowScoreEnabled;
  });
  updateLineByLineAutoState();
}

function effectiveLineByLineEnabled() {
  updateLineByLineAutoState();
  return lineByLineControl?.checked === true;
}

function effectiveDirectedRetryLowScoreEnabled() {
  updateDirectedLineModeState();
  return directedLineModeControl?.checked === true && directedRetryLowScoreControl?.checked === true;
}

function shouldAutoLineByLine(script) {
  if (!selectedModelAllowsAutoLineByLine()) {
    return false;
  }
  const lines = String(script || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= autoLineByLineMinLines) {
    return true;
  }
  const textChars = lines.reduce((total, line) => total + speakerTextFromScriptLine(line).length, 0);
  return textChars >= autoLineByLineMinChars;
}

function selectedModelAllowsAutoLineByLine() {
  const selectedOption = modelSelect?.selectedOptions?.[0];
  return selectedOption?.dataset.vibevoiceAutoLineByLine !== "false";
}

function speakerTextFromScriptLine(line) {
  const shortTag = String(line || "").trim().match(/^([0-9]+|[A-Za-z]):?\s+(.+)$/);
  if (shortTag) {
    return shortTag[2].trim();
  }
  const speakerTag = String(line || "").trim().match(/^Speaker\s+\d+\s*:\s*(.*)$/i);
  return speakerTag ? speakerTag[1].trim() : String(line || "").trim();
}

function validateDirectedLineModeScript(scriptText) {
  const parsedLines = parseDirectedPreflightLines(scriptText);
  if (parsedLines.length === 0) {
    return { ok: true, summary: "" };
  }
  const errors = [];
  const linesBySpeaker = new Map();
  for (const line of parsedLines) {
    const lineTargetText = directedTargetTextForLines([line.text]);
    if (lineTargetText.length > directedLineMaxChars) {
      errors.push(
        `Speaker ${line.speaker} Line ${line.index} の台詞が長すぎます。1行だけで${lineTargetText.length}文字です。${directedLineMaxChars}文字以内に分けてください。`,
      );
    }
    if (!linesBySpeaker.has(line.speaker)) {
      linesBySpeaker.set(line.speaker, []);
    }
    linesBySpeaker.get(line.speaker).push(line);
  }
  if (errors.length > 0) {
    return { ok: false, message: errors.join("\n") };
  }
  const chunkSummaries = [];
  for (const [speaker, lines] of linesBySpeaker.entries()) {
    const chunkCount = directedPreflightChunkCount(lines);
    if (chunkCount > 1) {
      chunkSummaries.push(`Speaker ${speaker}: ${chunkCount}チャンク`);
    }
  }
  if (chunkSummaries.length > 0) {
    return {
      ok: true,
      summary: `指定台詞を${chunkSummaries.join("、")}に分割して生成します。`,
    };
  }
  return { ok: true, summary: "" };
}

function parseDirectedPreflightLines(scriptText) {
  const parsed = [];
  const rawLines = String(scriptText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    parsed.push({
      index: parsed.length + 1,
      ...directedPreflightLineFromText(line),
    });
  }
  return parsed;
}

function directedPreflightLineFromText(line) {
  const speakerMatch = line.match(/^Speaker\s+([1-4])\s*:\s*(.*)$/i);
  if (speakerMatch) {
    return {
      speaker: speakerMatch[1],
      text: speakerMatch[2].trim(),
    };
  }
  const shortMatch = line.match(/^([1-4]|[A-Da-d]):?\s+(.+)$/);
  if (shortMatch) {
    return {
      speaker: slotFromShortTag(shortMatch[1]),
      text: shortMatch[2].trim(),
    };
  }
  return {
    speaker: "1",
    text: line.trim(),
  };
}

function directedPreflightChunkCount(lines) {
  let chunkCount = 0;
  let current = [];
  for (const line of lines) {
    const candidate = current.concat(line);
    if (
      current.length > 0 &&
      directedTargetTextForLines(candidate.map((item) => item.text)).length > directedTargetMaxChars
    ) {
      chunkCount += 1;
      current = [line];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) {
    chunkCount += 1;
  }
  return chunkCount;
}

function directedTargetTextForLines(texts) {
  const joinedSource = texts.join("\n");
  const separator = /[ぁ-んァ-ン一-龯、。]/.test(joinedSource) ? "。" : ".";
  const phrases = texts
    .map((text) => normalizeDirectedPreflightPhrase(text, separator))
    .filter(Boolean);
  const parts = [];
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index];
    parts.push(phrase);
    if (index < phrases.length - 1 && !endsWithDirectedSentencePunctuation(phrase)) {
      parts.push(separator);
    }
  }
  return ensureDirectedSentenceEnd(parts.join(""), separator);
}

function normalizeDirectedPreflightPhrase(text, separator) {
  let normalized = String(text || "").trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/\s+([、。，，,.!?！？])/g, "$1");
  normalized = normalized.replace(/([、。，，,.!?！？])\s+/g, "$1");
  if (separator === "。") {
    normalized = normalized.replace(/[、。，，,.]+/g, "。").replace(/。+/g, "。");
  }
  return normalized.trim();
}

function ensureDirectedSentenceEnd(text, separator) {
  const value = String(text || "").trim();
  if (!value || endsWithDirectedSentencePunctuation(value)) {
    return value;
  }
  return `${value}${separator}`;
}

function endsWithDirectedSentencePunctuation(text) {
  return /[。.!?！？…]$/.test(String(text || "").trim());
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
    detailItem("Sync Timeout", `${localStatus.timeout_seconds}s`),
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
  updateModelAvailability();
  updateLineByLineAutoState();
  saveVibeVoiceDraft();
  const directedPreflight = directedLineModeControl.checked
    ? validateDirectedLineModeScript(scriptInput.value)
    : { ok: true, summary: "" };
  if (!directedPreflight.ok) {
    message.dataset.state = "error";
    message.textContent = directedPreflight.message;
    return;
  }
  clearResult();
  setBusy(true, directedPreflight.summary || "生成中です。初回はモデルロードに時間がかかります。");
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
    body.set("line_by_line", effectiveLineByLineEnabled() ? "true" : "false");
    body.set("directed_line_mode", directedLineModeControl.checked ? "true" : "false");
    body.set("directed_retry_low_score", effectiveDirectedRetryLowScoreEnabled() ? "true" : "false");
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
    updateLineByLineAutoState();
    updateDirectedLineModeState();
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

async function handleReferenceUrlFetch() {
  const slot = String(referenceUrlSlotSelect?.value || "1");
  const url = String(referenceUrlInput?.value || "").trim();
  const durationSeconds = String(referenceUrlDurationInput?.value || "5").trim();
  const startSeconds = String(referenceUrlStartInput?.value || "").trim();
  if (!url) {
    setReferenceUrlStatus("URLを入力してください。", "error");
    return;
  }
  if (!durationSeconds) {
    setReferenceUrlStatus("取得秒数を入力してください。", "error");
    return;
  }
  setReferenceUrlBusy(true);
  setReferenceUrlStatus("URLから参照音声を取得中です。", "busy");
  try {
    const body = new FormData();
    body.set("url", url);
    body.set("duration_seconds", durationSeconds);
    if (startSeconds) {
      body.set("start_seconds", startSeconds);
    }
    const response = await fetch("/api/vibevoice/reference-audio-from-url", {
      method: "POST",
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `URL参照音声取得に失敗しました: ${response.status}`);
    }
    const audioBytes = base64ToBytes(payload.audio_base64 || "");
    if (audioBytes.length < 1) {
      throw new Error("URL参照音声が空でした。");
    }
    const blob = new Blob([audioBytes], { type: payload.audio_mime_type || "audio/wav" });
    const filename = payload.filename || `reference-url-speaker-${slot}.wav`;
    await saveVoiceBlob(slot, blob, filename);
    const input = voiceFileInputs.find((candidate) => voiceSlotFromInput(candidate) === slot);
    if (input) {
      input.value = "";
    }
    setReferenceUrlStatus(referenceUrlSuccessMessage(slot, payload), "ready");
    message.dataset.state = "ready";
    message.textContent = `Speaker ${slot} の参照音声をURLから保存しました。Speaker枠で再生確認できます。`;
  } catch (error) {
    setReferenceUrlStatus(String(error.message || error), "error");
    message.dataset.state = "error";
    message.textContent = `URL参照音声を取得できませんでした: ${error.message || error}`;
  } finally {
    setReferenceUrlBusy(false);
  }
}

function setReferenceUrlBusy(busy) {
  referenceUrlFetching = busy;
  updateReferenceUrlButtonState();
}

function updateReferenceUrlButtonState() {
  if (referenceUrlButton) {
    referenceUrlButton.disabled = generationBusy || referenceUrlFetching;
    referenceUrlButton.textContent = referenceUrlFetching ? "取得中..." : "取得";
  }
}

function setReferenceUrlStatus(text, state = "ready") {
  if (!referenceUrlStatus) {
    return;
  }
  referenceUrlStatus.dataset.state = state;
  referenceUrlStatus.textContent = text || "";
}

function referenceUrlSuccessMessage(slot, payload) {
  const start = Number(payload.start_seconds);
  const duration = Number(payload.duration_seconds);
  const parts = [`Speaker ${slot} に保存しました`];
  if (Number.isFinite(start)) {
    parts.push(`開始 ${formatSeconds(start)}`);
  }
  if (Number.isFinite(duration)) {
    parts.push(`${formatSeconds(duration)}取得`);
  }
  return `${parts.join(" / ")}。Speaker枠で再生確認できます。`;
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
  jobProgress.dataset.state = "running";
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
  renderProgressLog(payload.progress_log);
  renderProgressPercent(progressPercentFromPayload(payload));
  renderElapsed(payload.elapsed_ms);
}

function progressPercentFromPayload(payload) {
  const labels = [];
  const currentLabel = payload?.current_stage?.label;
  if (currentLabel) {
    labels.push(currentLabel);
  }
  if (Array.isArray(payload?.progress_log)) {
    for (const item of payload.progress_log.slice().reverse()) {
      if (item?.label) {
        labels.push(item.label);
      }
    }
  }
  for (const label of labels) {
    const percent = progressPercentFromLabel(label);
    if (Number.isFinite(percent)) {
      return Math.max(0, Math.min(100, percent));
    }
  }
  return null;
}

function progressPercentFromLabel(label) {
  const text = String(label || "");
  const lineByLineMatch = text.match(/行単位生成\s+\d+\/\d+\s+\((\d+(?:\.\d+)?)%/);
  const generationMatch = text.match(/生成中\s+\d+\/\d+\s+\((\d+(?:\.\d+)?)%/);
  const match = lineByLineMatch || generationMatch;
  return match ? Number(match[1]) : null;
}

function renderProgressPercent(percent, fallbackProgress = "indeterminate") {
  if (!progressBar || !progressFill) {
    return;
  }
  if (Number.isFinite(percent)) {
    const clamped = Math.max(0, Math.min(100, Number(percent)));
    jobProgress.dataset.progress = "determinate";
    progressBar.setAttribute("aria-valuenow", String(Math.round(clamped)));
    progressFill.style.inlineSize = `${clamped}%`;
    return;
  }
  jobProgress.dataset.progress = fallbackProgress;
  progressBar.removeAttribute("aria-valuenow");
  progressFill.style.inlineSize = "";
}

function renderProgressLog(items = []) {
  if (!progressLog) {
    return;
  }
  const rows = Array.isArray(items) ? items.slice(-12) : [];
  progressLog.textContent = rows.map((item) => progressLogLine(item)).filter(Boolean).join("\n");
}

function progressLogLine(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const label = String(item.label || "").trim();
  if (!label) {
    return "";
  }
  const stage = String(item.stage || "").trim();
  return stage ? `${stage}: ${label}` : label;
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
  if (keepTiming) {
    jobProgress.dataset.state = "complete";
    jobProgress.hidden = false;
  } else {
    jobProgress.dataset.state = "idle";
    timingLabel.textContent = "";
    renderProgressPercent(null, "idle");
    renderProgressLog([]);
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
  const preview = savedVoicePreviews.find((element) => element.dataset.savedVoicePreviewSlot === String(slot));
  if (!label && !preview) {
    return;
  }
  if (!record) {
    if (label) {
      label.textContent = "未保存";
    }
    renderSavedVoicePreview(slot, preview, null);
    return;
  }
  if (label) {
    label.textContent = `保存済み: ${record.name || `voice-${slot}`} (${formatBytes(record.size || record.blob?.size || 0)})`;
  }
  renderSavedVoicePreview(slot, preview, record);
}

function renderSavedVoicePreview(slot, preview, record) {
  revokeSavedVoicePreviewUrl(slot);
  if (!preview || !record?.blob) {
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute("src");
      preview.load();
    }
    return;
  }
  const url = URL.createObjectURL(record.blob);
  savedVoicePreviewUrls.set(String(slot), url);
  preview.src = url;
  preview.hidden = false;
  preview.load();
}

function revokeSavedVoicePreviewUrl(slot) {
  const key = String(slot);
  const url = savedVoicePreviewUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    savedVoicePreviewUrls.delete(key);
  }
}

function stopPreviewEventPropagation(event) {
  event.stopPropagation();
}

function voiceSlotFromInput(input) {
  return String(input?.name || "").replace("voice_file_", "");
}

function voiceRecordFromFile(slot, file) {
  return voiceRecordFromBlob(slot, file, file.name || `voice-${slot}`, file.type || "application/octet-stream", {
    lastModified: file.lastModified || Date.now(),
  });
}

function voiceRecordFromBlob(slot, blob, filename, type = "", metadata = {}) {
  return {
    slot: String(slot),
    name: filename || `voice-${slot}`,
    type: type || blob.type || "application/octet-stream",
    size: blob.size || 0,
    lastModified: metadata.lastModified || Date.now(),
    blob,
  };
}

function saveVoiceFile(slot, file) {
  return saveVoiceRecord(voiceRecordFromFile(slot, file));
}

async function saveVoiceBlob(slot, blob, filename) {
  const record = voiceRecordFromBlob(slot, blob, filename, blob.type || "audio/wav");
  await saveVoiceRecord(record);
  savedVoiceFilesBySlot.set(String(slot), record);
  renderSavedVoiceFile(String(slot), record);
}

function saveVoiceRecord(record) {
  return withSavedVoiceStore("readwrite", (store, resolve, reject) => {
    const request = store.put(record);
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
  const audioMimeType = payload.audio_mime_type || "audio/wav";
  const blob = new Blob([audioBytes], { type: audioMimeType });
  currentAudioUrl = URL.createObjectURL(blob);
  audio.src = currentAudioUrl;
  downloadLink.href = currentAudioUrl;
  downloadLink.download = `vibevoice-output.${extensionForMimeType(audioMimeType)}`;
  downloadLink.textContent = `${labelForMimeType(audioMimeType)}を保存`;
  normalizedScript.textContent = payload.normalized_script || "";
  const directedDiagnostics = payload.diagnostics?.directed_line_mode || {};
  diagnostics.textContent = JSON.stringify(
    {
      providers: payload.providers || {},
      timings_ms: payload.timings_ms || {},
      diagnostics: payload.diagnostics || {},
    },
    null,
    2,
  );
  updateCopyDiagnosticsButtonState();
  renderSpeakerScripts(directedDiagnostics.speaker_scripts || {});
  renderArtifacts(payload.artifacts || [], payload.diagnostics?.runpod_artifacts || null);
  resultPanel.hidden = false;
  audio.play().catch(() => {});
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("audio/mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) {
    return "m4a";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  if (normalized.includes("webm")) {
    return "webm";
  }
  return "audio";
}

function labelForMimeType(mimeType) {
  const extension = extensionForMimeType(mimeType);
  if (extension === "mp3") {
    return "MP3";
  }
  if (extension === "m4a") {
    return "M4A";
  }
  if (extension === "wav") {
    return "WAV";
  }
  return "音声";
}

function clearResult() {
  stopJobProgress();
  currentJobId = "";
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = "";
  }
  revokeArtifactAudioUrls();
  audio.removeAttribute("src");
  downloadLink.href = "#";
  normalizedScript.textContent = "";
  diagnostics.textContent = "";
  updateCopyDiagnosticsButtonState();
  speakerScriptsContainer.replaceChildren();
  artifactsContainer.replaceChildren();
  resultPanel.hidden = true;
}

async function copyDiagnosticsToClipboard() {
  const text = diagnostics.textContent || "";
  if (!text.trim()) {
    return;
  }
  try {
    await copyTextWithFallback(text);
    setCopyDiagnosticsButtonLabel("コピー済み");
  } catch (error) {
    setCopyDiagnosticsButtonLabel("失敗");
    message.dataset.state = "error";
    message.textContent = `診断をコピーできませんでした: ${error.message || error}`;
  }
}

function updateCopyDiagnosticsButtonState() {
  if (!copyDiagnosticsButton) {
    return;
  }
  copyDiagnosticsButton.disabled = !(diagnostics.textContent || "").trim();
}

function setCopyDiagnosticsButtonLabel(label) {
  if (!copyDiagnosticsButton) {
    return;
  }
  copyDiagnosticsButton.textContent = label;
  window.clearTimeout(copyDiagnosticsResetTimer);
  copyDiagnosticsResetTimer = window.setTimeout(() => {
    copyDiagnosticsButton.textContent = "コピー";
    updateCopyDiagnosticsButtonState();
  }, 1600);
}

async function copyTextWithFallback(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.insetBlockStart = "-1000px";
  textarea.style.inlineSize = "1px";
  textarea.style.blockSize = "1px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard API is unavailable");
  }
}

function renderSpeakerScripts(speakerScripts) {
  speakerScriptsContainer.replaceChildren();
  const entries = Object.entries(speakerScripts || {}).sort(([left], [right]) => Number(left) - Number(right));
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "vibevoice-speaker-scripts-empty";
    empty.textContent = "VV入力テキストはありません。";
    speakerScriptsContainer.append(empty);
    return;
  }
  for (const [speaker, textValue] of entries) {
    const item = document.createElement("article");
    item.className = "vibevoice-speaker-script";

    const title = document.createElement("h4");
    title.textContent = `Speaker ${speaker}`;

    const text = document.createElement("p");
    text.textContent = String(textValue || "");

    item.append(title, text);
    speakerScriptsContainer.append(item);
  }
}

function renderArtifacts(artifacts, runpodArtifactSummary = null) {
  revokeArtifactAudioUrls();
  artifactsContainer.replaceChildren();
  const items = Array.isArray(artifacts) ? artifacts : [];
  if (items.length === 0) {
    renderArtifactsEmpty(runpodArtifactSummary);
    return;
  }
  let renderedCount = 0;
  for (const artifact of items) {
    const audioBase64 = artifact?.audio_base64 || "";
    if (!audioBase64) {
      continue;
    }
    const item = document.createElement("article");
    item.className = "vibevoice-artifact";

    const title = document.createElement("h4");
    title.textContent = artifact.label || artifact.kind || "Audio";

    const meta = document.createElement("p");
    meta.className = "vibevoice-artifact-meta";
    meta.textContent = artifactMetaText(artifact);

    const player = document.createElement("audio");
    player.controls = true;
    const audioBytes = base64ToBytes(audioBase64);
    const blob = new Blob([audioBytes], { type: artifact.audio_mime_type || "audio/wav" });
    const url = URL.createObjectURL(blob);
    artifactAudioUrls.push(url);
    player.src = url;

    item.append(title, meta);
    if (artifact.text) {
      const text = document.createElement("p");
      text.className = "vibevoice-artifact-text";
      text.textContent = artifact.text;
      item.append(text);
    }
    if (artifact.matched_text) {
      const matchedText = document.createElement("p");
      matchedText.className = "vibevoice-artifact-text";
      matchedText.textContent = `ASR: ${artifact.matched_text}`;
      item.append(matchedText);
    }
    item.append(player);
    artifactsContainer.append(item);
    renderedCount += 1;
  }
  if (renderedCount === 0) {
    renderArtifactsEmpty(runpodArtifactSummary);
  }
}

function renderArtifactsEmpty(runpodArtifactSummary = null) {
  const empty = document.createElement("p");
  empty.className = "vibevoice-artifacts-empty";
  if (Number(runpodArtifactSummary?.available || 0) > 0 && Number(runpodArtifactSummary?.omitted || 0) > 0) {
    empty.textContent = `RunPodの返却サイズを抑えるため、中間音声 ${runpodArtifactSummary.omitted}/${runpodArtifactSummary.available} 件を省略しました。`;
  } else {
    empty.textContent = "中間音声はありません。";
  }
  artifactsContainer.append(empty);
}

function artifactMetaText(artifact) {
  const parts = [];
  if (artifact.kind) {
    parts.push(String(artifact.kind));
  }
  if (artifact.speaker) {
    parts.push(`Speaker ${artifact.speaker}`);
  }
  if (artifact.line_index) {
    parts.push(`Line ${artifact.line_index}`);
  }
  if (Number.isFinite(Number(artifact.duration_seconds))) {
    parts.push(`${Number(artifact.duration_seconds).toFixed(2)}s`);
  }
  if (Number.isFinite(Number(artifact.size_bytes))) {
    parts.push(formatBytes(artifact.size_bytes));
  }
  return parts.join(" / ");
}

function revokeArtifactAudioUrls() {
  for (const url of artifactAudioUrls) {
    URL.revokeObjectURL(url);
  }
  artifactAudioUrls = [];
}

function setBusy(busy, text) {
  generationBusy = busy;
  generateButton.disabled = busy;
  generateButton.textContent = busy ? "生成中..." : "生成";
  resetSettingsButton.disabled = busy;
  updateReferenceUrlButtonState();
  cancelButton.hidden = !busy;
  if (busy) {
    jobProgress.dataset.state = "running";
    renderProgressPercent(null);
    jobProgress.hidden = false;
  } else if (!timingLabel.textContent) {
    jobProgress.dataset.state = "idle";
    renderProgressPercent(null, "idle");
    renderProgressLog([]);
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

function formatSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds)) {
    return "";
  }
  if (Number.isInteger(seconds)) {
    return `${seconds}秒`;
  }
  return `${seconds.toFixed(1).replace(/\.0$/, "")}秒`;
}
