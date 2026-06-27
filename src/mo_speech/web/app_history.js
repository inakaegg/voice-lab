async function loadAudioHistory() {
  try {
    const response = await fetch("/api/audio-history");
    if (!response.ok) {
      throw new Error("audio history request failed");
    }
    const payload = await response.json();
    renderAudioHistorySettings(payload.settings || {});
    renderAudioHistoryList(historyRecordings, payload.recordings || []);
    renderAudioHistoryList(historyOutputs, payload.outputs || []);
  } catch {
    historyStorage.textContent = "保存先を取得できませんでした。";
    historyRecordings.textContent = "履歴を取得できませんでした。";
    historyOutputs.textContent = "履歴を取得できませんでした。";
  }
}

function renderAudioHistorySettings(settings) {
  if (!settings.enabled) {
    historyStorage.textContent = "音声履歴は無効です。MO_AUDIO_HISTORY_ENABLED=1 で有効化できます。";
    return;
  }
  const root = settings.resolved_root || settings.root || "tmp/audio-history";
  const recordingsDir = settings.recordings_dir || `${root}/recordings`;
  const outputsDir = settings.outputs_dir || `${root}/outputs`;
  historyStorage.textContent = `保存先: ${root} / 入力: ${recordingsDir} / 出力: ${outputsDir} / 上限: 各${settings.limit || 100}件 / 変更: ${settings.env_var || "MO_AUDIO_HISTORY_DIR"}`;
}

function renderAudioHistoryList(container, entries) {
  container.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-meta";
    empty.textContent = "まだありません";
    container.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    if (entry.media_type) {
      const source = document.createElement("source");
      source.src = entry.url;
      source.type = entry.media_type;
      audio.append(source);
    } else {
      audio.src = entry.url;
    }
    const title = document.createElement("strong");
    title.className = "history-title";
    title.textContent = entry.label || entry.filename || "音声履歴";
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const details = Array.isArray(entry.details) ? entry.details.filter(Boolean).join(" / ") : entry.metadata?.endpoint || entry.kind;
    const createdAt = entry.created_at || "";
    meta.textContent = `${details} / ${formatBytes(Number(entry.size_bytes || 0))} / ${createdAt}`;
    const actions = document.createElement("div");
    actions.className = "history-actions";
    const useAsInput = document.createElement("button");
    useAsInput.type = "button";
    useAsInput.className = "secondary-button";
    useAsInput.textContent = "入力に使う";
    useAsInput.addEventListener("click", () => useHistoryAudioAsInput(entry));
    const useAsReference = document.createElement("button");
    useAsReference.type = "button";
    useAsReference.className = "secondary-button";
    useAsReference.textContent = "VC参照に使う";
    useAsReference.addEventListener("click", () => useHistoryAudioAsReference(entry));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "history-delete-button";
    deleteButton.title = "削除";
    deleteButton.setAttribute("aria-label", `${entry.label || entry.filename || "音声履歴"}を削除`);
    deleteButton.append(createTrashIcon());
    deleteButton.addEventListener("click", () => deleteHistoryAudio(entry));
    actions.append(useAsInput, useAsReference);
    item.append(title, audio);
    if (entry.tts_text) {
      const text = document.createElement("p");
      text.className = "history-text";
      text.textContent = entry.tts_text;
      item.append(text);
      const useTextForTts = document.createElement("button");
      useTextForTts.type = "button";
      useTextForTts.className = "secondary-button";
      useTextForTts.textContent = "テキストを読み上げに使う";
      useTextForTts.addEventListener("click", () => useHistoryTextForTts(entry));
      actions.append(useTextForTts);
    }
    actions.append(deleteButton);
    item.append(meta);
    if (entry.playable_hint) {
      const warning = document.createElement("p");
      warning.className = "history-warning";
      warning.textContent = entry.playable_hint;
      item.append(warning);
    }
    item.append(actions);
    container.append(item);
  });
}

async function deleteHistoryAudio(entry) {
  const label = entry.label || entry.filename || "この音声履歴";
  if (!window.confirm(`${label}を削除しますか？`)) {
    return;
  }
  try {
    const response = await fetch(entry.url, { method: "DELETE" });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.detail || "履歴音声を削除できませんでした");
    }
    if (inputHistorySource?.kind === entry.kind && inputHistorySource?.filename === entry.filename) {
      inputHistorySource = null;
    }
    setStatus("履歴音声を削除しました");
    await loadAudioHistory();
  } catch (error) {
    renderError(error.message || "履歴音声を削除できませんでした");
  }
}

function createTrashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v6m4-6v6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "2");
  svg.append(path);
  return svg;
}

async function useHistoryAudioAsInput(entry) {
  try {
    const { blob, filename } = await fetchHistoryAudioBlob(entry);
    useAudioBlobAsInput(
      blob,
      filename,
      "履歴音声を入力に設定しました",
      {
        kind: entry.kind,
        filename: entry.filename,
      },
      "履歴から入力",
    );
  } catch (error) {
    renderError(error.message || "履歴音声を入力に設定できませんでした");
  }
}

async function useHistoryAudioAsReference(entry) {
  try {
    const { blob, filename } = await fetchHistoryAudioBlob(entry);
    useAudioBlobAsReference(blob, filename, "履歴音声をVC参照に設定しました", "履歴からVC参照");
  } catch (error) {
    renderError(error.message || "履歴音声をVC参照に設定できませんでした");
  }
}

async function fetchHistoryAudioBlob(entry) {
  const response = await fetch(entry.url);
  if (!response.ok) {
    throw new Error("履歴音声を取得できませんでした");
  }
  const blob = await response.blob();
  const filename = entry.filename || entry.metadata?.filename || `history.${extensionForMimeType(blob.type || "audio/wav")}`;
  return { blob, filename };
}

function useAudioBlobAsInput(blob, filename, message, historySource = null, selectionLabel = "入力に設定") {
  audioInput.value = "";
  recordedBlob = blob;
  recordedChunks = [];
  recordedFileName = filename || `input.${extensionForMimeType(blob.type || "audio/wav")}`;
  inputHistorySource = historySource;
  renderInputAudioPreview(blob, recordedFileName);
  setInputAudioSelectionStatus(selectionLabel, blob, recordedFileName);
  recordingLabel.textContent = "入力に設定済み";
  setStatus(message || "入力音声を設定しました");
}

function useAudioBlobAsReference(blob, filename, message, selectionLabel = "VC参照に設定") {
  referenceAudioInput.value = "";
  referenceAudioBlob = blob;
  referenceAudioFileName = filename || `reference.${extensionForMimeType(blob.type || "audio/wav")}`;
  setReferenceAudioSelectionStatus(selectionLabel, blob, referenceAudioFileName);
  if (operationModeSelect.value !== "voice_conversion") {
    operationModeSelect.value = "voice_conversion";
    syncOperationMode();
  }
  setStatus(message || "VC参照音声を設定しました");
}

function useHistoryTextForTts(entry) {
  const text = entry.tts_text || entry.text_preview || "";
  if (!text) {
    renderError("再利用できるTTSテキストがありません");
    return;
  }
  operationModeSelect.value = "text_tts";
  ttsTextInput.value = text;
  syncOperationMode();
  const targetLanguage = entry.metadata?.target_language || "";
  if (targetLanguage && targetLanguage !== "auto") {
    ensureTtsLanguage(targetLanguage);
  }
  setStatus("履歴テキストを読み上げ入力に設定しました");
}

function useTextResultForTts(source) {
  const mapping = {
    transcript: {
      selector: "#transcript",
      language: selectedSourceLanguage(),
    },
    translated: {
      selector: "#translated-text",
      language: form.target_language.value,
    },
    transformed: {
      selector: "#transformed-text",
      language: form.target_language.value,
    },
  };
  const item = mapping[source];
  if (!item) {
    return;
  }
  const text = document.querySelector(item.selector)?.textContent?.trim() || "";
  if (!text || text === "未実行") {
    renderError("再利用できるテキストがありません");
    return;
  }
  operationModeSelect.value = "text_tts";
  ttsTextInput.value = text;
  syncOperationMode();
  if (item.language && item.language !== "auto") {
    ensureTtsLanguage(item.language);
  }
  setStatus("テキストを読み上げ入力に設定しました");
}

function ensureTtsLanguage(language) {
  if ([...ttsTargetLanguageSelect.options].some((option) => option.value === language)) {
    ttsTargetLanguageSelect.value = language;
    return;
  }
  const openaiOption = [...ttsBackendSelect.options].find((option) => option.value === "openai" && !option.disabled);
  if (!openaiOption) {
    return;
  }
  ttsBackendSelect.value = "openai";
  syncTtsBackendAvailability();
  if ([...ttsTargetLanguageSelect.options].some((option) => option.value === language)) {
    ttsTargetLanguageSelect.value = language;
  }
}
