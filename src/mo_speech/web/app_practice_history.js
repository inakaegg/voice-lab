const recordingsList = document.querySelector("#practice-history-recordings");
const outputsList = document.querySelector("#practice-history-outputs");
const statusText = document.querySelector("#practice-history-status");
const historyPanels = document.querySelectorAll("[data-practice-history-panel]");
const settingsPanel = document.querySelector(".admin-config-group");

loadPracticeHistory();

async function loadPracticeHistory() {
  try {
    const response = await fetch("/api/practice-history");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || `history failed: ${response.status}`);
    }
    if (payload.settings?.enabled === false) {
      historyPanels.forEach((panel) => {
        panel.hidden = true;
      });
      settingsPanel.open = true;
      return;
    }
    historyPanels.forEach((panel) => {
      panel.hidden = false;
    });
    renderHistoryList(recordingsList, payload.recordings || []);
    renderHistoryList(outputsList, payload.outputs || []);
    statusText.textContent = `録音 ${payload.recordings?.length || 0}件 / お手本 ${payload.outputs?.length || 0}件`;
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderHistoryList(container, entries) {
  container.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "practice-history-empty";
    empty.textContent = "履歴はまだありません。";
    container.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const item = document.createElement("article");
    item.className = "practice-history-item";

    const title = document.createElement("h3");
    title.textContent = entry.label || entry.filename || "音声";

    const details = document.createElement("p");
    details.textContent = [entry.details, entry.created_at].flat().filter(Boolean).join(" / ");

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.dataset.voiceLabAudioLabel = entry.label || entry.filename || "音声履歴";
    audio.preload = "none";
    audio.src = entry.url;

    item.append(title, details, audio);
    const diagnostics = practiceDiagnosticsJson(entry);
    if (diagnostics) {
      item.append(createDiagnosticsDetails(diagnostics));
    }
    container.append(item);
    window.ensureVoiceLabAudioControl?.(audio, audio.dataset.voiceLabAudioLabel);
  });
}

function practiceDiagnosticsJson(entry) {
  const raw = entry?.metadata?.practice_diagnostics_json || entry?.metadata?.practice_diagnostics;
  if (!raw) {
    return "";
  }
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw, null, 2);
}

function createDiagnosticsDetails(text) {
  const details = document.createElement("details");
  details.className = "practice-history-diagnostics";

  const summary = document.createElement("summary");
  summary.textContent = "診断JSON";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "コピー";
  copyButton.addEventListener("click", async (event) => {
    event.preventDefault();
    await navigator.clipboard.writeText(text);
    copyButton.textContent = "コピー済み";
    setTimeout(() => {
      copyButton.textContent = "コピー";
    }, 1200);
  });

  const pre = document.createElement("pre");
  pre.textContent = text;

  details.append(summary, copyButton, pre);
  return details;
}
