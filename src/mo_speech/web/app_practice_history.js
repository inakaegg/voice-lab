const recordingsList = document.querySelector("#practice-history-recordings");
const outputsList = document.querySelector("#practice-history-outputs");
const statusText = document.querySelector("#practice-history-status");

loadPracticeHistory();

async function loadPracticeHistory() {
  try {
    const response = await fetch("/api/practice-history");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || `history failed: ${response.status}`);
    }
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
    audio.preload = "none";
    audio.src = entry.url;

    item.append(title, details, audio);
    container.append(item);
  });
}
