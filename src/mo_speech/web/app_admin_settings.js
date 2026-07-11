const userJokeTextInput = document.querySelector("#user_joke_text");
const userJokePositionSelect = document.querySelector("#user_joke_position");
const userJokeSelectionSelect = document.querySelector("#user_joke_selection");
const userJokeVariationCountInput = document.querySelector("#user_joke_variation_count");
const userJokeVariantsPreview = document.querySelector("#user_joke_variants_preview");
const userJokeVariantsEmpty = document.querySelector("#user_joke_variants_empty");
const userJokePoolPreview = document.querySelector("#user_joke_pool_preview");
const userJokePoolEmpty = document.querySelector("#user_joke_pool_empty");
const userEffectAudioFilesInput = document.querySelector("#user_effect_audio_files");
const userEffectAudioPreview = document.querySelector("#user_effect_audio_preview");
const userEffectAudioEmpty = document.querySelector("#user_effect_audio_empty");
const userEffectSelectionSelect = document.querySelector("#user_effect_selection");
const userEffectInsertModeSelect = document.querySelector("#user_effect_insert_mode");
const userEffectMaxInsertionsInput = document.querySelector("#user_effect_max_insertions");
const userEffectMinSilenceMsInput = document.querySelector("#user_effect_min_silence_ms");
const userThemeSelect = document.querySelector("#user_theme");
const userSettingsSaveButton = document.querySelector("#user-settings-save");
const userSettingsStatus = document.querySelector("#user-settings-status");
const userSettingsSaveLabel = userSettingsSaveButton?.textContent || "ユーザー画面設定を保存";

let adminEffectAudios = [];

if (userSettingsSaveButton) {
  userSettingsSaveButton.addEventListener("click", saveUserSettings);
  userEffectAudioFilesInput?.addEventListener("change", handleAdminEffectAudioFiles);
  loadAdminUserSettings();
}

async function loadAdminUserSettings() {
  try {
    const response = await fetch("/api/user-settings");
    if (!response.ok) {
      throw new Error("ユーザー画面設定を読み込めませんでした");
    }
    const settings = await response.json();
    userJokeTextInput.value = Array.isArray(settings.joke_texts)
      ? settings.joke_texts.join("\n")
      : settings.joke_text || "";
    userJokePositionSelect.value = settings.joke_position || "after";
    userJokeSelectionSelect.value = settings.joke_selection || "rotation";
    userJokeVariationCountInput.value = String(settings.joke_variation_count || 0);
    adminEffectAudios = normalizeAdminEffectAudios(settings.effect_audios || []);
    userEffectSelectionSelect.value = settings.effect_selection || "rotation";
    userEffectInsertModeSelect.value = settings.effect_insert_mode || "silence_or_tail";
    userEffectMaxInsertionsInput.value = String(settings.effect_max_insertions || 1);
    userEffectMinSilenceMsInput.value = String(settings.effect_min_silence_ms || 300);
    userThemeSelect.value = settings.theme || "blue";
    renderAdminJokePreview(settings);
    renderAdminEffectAudioPreview();
    renderUserSettingsStatus("ユーザー画面設定を読み込みました");
  } catch (error) {
    renderUserSettingsStatus(error.message || "ユーザー画面設定を読み込めませんでした");
  }
}

async function saveUserSettings() {
  userSettingsSaveButton.disabled = true;
  userSettingsSaveButton.textContent = "保存中…";
  userSettingsSaveButton.dataset.state = "loading";
  renderUserSettingsStatus("保存中です。");
  try {
    const response = await fetch("/api/user-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        joke_text: userJokeTextInput.value,
        joke_texts: splitAdminJokeTexts(userJokeTextInput.value),
        joke_position: userJokePositionSelect.value,
        joke_selection: userJokeSelectionSelect.value,
        joke_variation_count: Number(userJokeVariationCountInput.value || 0),
        effect_audios: adminEffectAudios,
        effect_selection: userEffectSelectionSelect.value,
        effect_insert_mode: userEffectInsertModeSelect.value,
        effect_max_insertions: Number(userEffectMaxInsertionsInput.value || 1),
        effect_min_silence_ms: Number(userEffectMinSilenceMsInput.value || 300),
        theme: userThemeSelect.value,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "ユーザー画面設定を保存できませんでした");
    }
    const settings = await response.json();
    adminEffectAudios = normalizeAdminEffectAudios(settings.effect_audios || []);
    renderAdminJokePreview(settings);
    renderAdminEffectAudioPreview();
    renderUserSettingsStatus(
      `保存しました（元 ${settings.joke_texts?.length || 0}件 / 生成 ${settings.joke_variants?.length || 0}件 / 合計 ${settings.joke_pool?.length || 0}件 / 効果音 ${settings.effect_audios?.length || 0}件）`,
    );
    userSettingsSaveButton.textContent = "保存済み";
    userSettingsSaveButton.dataset.state = "success";
    window.setTimeout(() => {
      if (userSettingsSaveButton.textContent === "保存済み") {
        userSettingsSaveButton.textContent = userSettingsSaveLabel;
        userSettingsSaveButton.dataset.state = "";
      }
    }, 2400);
  } catch (error) {
    renderUserSettingsStatus(error.message || "ユーザー画面設定を保存できませんでした");
    userSettingsSaveButton.textContent = "再試行";
    userSettingsSaveButton.dataset.state = "error";
  } finally {
    userSettingsSaveButton.disabled = false;
  }
}

function renderUserSettingsStatus(message) {
  userSettingsStatus.textContent = message;
}

function splitAdminJokeTexts(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderAdminJokePreview(settings) {
  renderJokeList(userJokeVariantsPreview, userJokeVariantsEmpty, settings.joke_variants || []);
  renderJokeList(userJokePoolPreview, userJokePoolEmpty, settings.joke_pool || []);
}

function renderJokeList(listElement, emptyElement, jokes) {
  const normalizedJokes = Array.isArray(jokes)
    ? jokes.map((item) => String(item).trim()).filter(Boolean)
    : [];
  listElement.replaceChildren();
  normalizedJokes.forEach((joke) => {
    const item = document.createElement("li");
    item.textContent = joke;
    listElement.appendChild(item);
  });
  emptyElement.hidden = normalizedJokes.length > 0;
  listElement.hidden = normalizedJokes.length === 0;
}

async function handleAdminEffectAudioFiles(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }
  renderUserSettingsStatus("効果音を読み込み中");
  try {
    const loaded = [];
    for (const file of files) {
      loaded.push(await effectAudioFromFile(file));
    }
    adminEffectAudios = [...adminEffectAudios, ...loaded].slice(0, 20);
    renderAdminEffectAudioPreview();
    renderUserSettingsStatus(`効果音 ${loaded.length}件を追加しました`);
  } catch (error) {
    renderUserSettingsStatus(error.message || "効果音を読み込めませんでした");
  } finally {
    event.target.value = "";
  }
}

async function effectAudioFromFile(file) {
  const maxBytes = 1_500_000;
  if (file.size > maxBytes) {
    throw new Error(`${file.name} が大きすぎます。短い効果音を指定してください。`);
  }
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `effect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name || "effect.wav",
    audio_mime_type: normalizeAdminAudioMime(file.type || file.name),
    audio_base64: arrayBufferToBase64(await file.arrayBuffer()),
  };
}

function renderAdminEffectAudioPreview() {
  userEffectAudioPreview.replaceChildren();
  adminEffectAudios.forEach((effectAudio) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${effectAudio.name} (${effectAudio.audio_mime_type})`;
    const player = document.createElement("audio");
    player.controls = true;
    player.src = `data:${effectAudio.audio_mime_type};base64,${effectAudio.audio_base64}`;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "secondary-button";
    removeButton.textContent = "削除";
    removeButton.addEventListener("click", () => {
      adminEffectAudios = adminEffectAudios.filter((itemAudio) => itemAudio.id !== effectAudio.id);
      renderAdminEffectAudioPreview();
    });
    item.append(name, player, removeButton);
    userEffectAudioPreview.appendChild(item);
  });
  userEffectAudioEmpty.hidden = adminEffectAudios.length > 0;
  userEffectAudioPreview.hidden = adminEffectAudios.length === 0;
}

function normalizeAdminEffectAudios(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => ({
      id: String(item.id || `effect-${index + 1}`),
      name: String(item.name || `effect-${index + 1}.wav`),
      audio_mime_type: normalizeAdminAudioMime(item.audio_mime_type || item.name || ""),
      audio_base64: String(item.audio_base64 || "").trim(),
    }))
    .filter((item) => item.audio_base64);
}

function normalizeAdminAudioMime(value) {
  const normalized = String(value || "").split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("audio/")) {
    return normalized;
  }
  const lower = String(value || "").toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "audio/wav";
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
