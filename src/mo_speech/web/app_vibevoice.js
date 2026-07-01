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
const scriptInput = document.querySelector("#vibevoice-script");
const scriptFileInput = document.querySelector("#vibevoice-script-file");

let currentAudioUrl = "";

form.addEventListener("submit", handleGenerate);
scriptFileInput.addEventListener("change", handleScriptFileChange);
loadStatus();

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

async function handleGenerate(event) {
  event.preventDefault();
  clearResult();
  setBusy(true, "生成中です。初回はモデルロードに時間がかかります。");
  try {
    const body = new FormData(form);
    body.set("do_sample", form.elements.do_sample.checked ? "true" : "false");
    body.set("line_by_line", form.elements.line_by_line.checked ? "true" : "false");
    const response = await fetch("/api/vibevoice/generate", {
      method: "POST",
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `generation failed: ${response.status}`);
    }
    renderResult(payload);
    setBusy(false, "生成しました。");
  } catch (error) {
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
    message.dataset.state = "ready";
    message.textContent = `${file.name} を台本へ読み込みました。`;
  } catch (error) {
    message.dataset.state = "error";
    message.textContent = `テキストファイルを読み込めませんでした: ${error.message || error}`;
  }
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
