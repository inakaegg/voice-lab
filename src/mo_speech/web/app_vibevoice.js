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

let currentAudioUrl = "";

form.addEventListener("submit", handleGenerate);
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
  runtimeStatus.dataset.state = status.available ? "ready" : "missing";
  runtimeStatus.textContent = status.available ? "利用できます" : "モデルまたはCLIが見つかりません";
  runtimeDetails.replaceChildren(
    detailItem("CLI", status.cli_exists ? status.cli_path : `${status.cli_path} (missing)`),
    detailItem(
      "Module",
      status.comfyui_vibevoice_exists
        ? status.comfyui_vibevoice_path
        : `${status.comfyui_vibevoice_path} (missing)`,
    ),
    detailItem("Model", status.model_cache_found ? status.model_cache_path : "missing"),
    detailItem("Tokenizer", status.tokenizer_found ? status.tokenizer_path : "missing"),
    detailItem("Timeout", `${status.timeout_seconds}s`),
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
