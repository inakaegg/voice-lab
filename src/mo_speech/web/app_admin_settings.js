const userTargetLanguageSelect = document.querySelector("#user_target_language");
const userJokeTextInput = document.querySelector("#user_joke_text");
const userJokePositionSelect = document.querySelector("#user_joke_position");
const userJokeSelectionSelect = document.querySelector("#user_joke_selection");
const userJokeVariationCountInput = document.querySelector("#user_joke_variation_count");
const userJokeVariantsPreview = document.querySelector("#user_joke_variants_preview");
const userJokeVariantsEmpty = document.querySelector("#user_joke_variants_empty");
const userJokePoolPreview = document.querySelector("#user_joke_pool_preview");
const userJokePoolEmpty = document.querySelector("#user_joke_pool_empty");
const userThemeSelect = document.querySelector("#user_theme");
const userSettingsSaveButton = document.querySelector("#user-settings-save");
const userSettingsStatus = document.querySelector("#user-settings-status");

if (userSettingsSaveButton) {
  userSettingsSaveButton.addEventListener("click", saveUserSettings);
  loadAdminUserSettings();
}

async function loadAdminUserSettings() {
  try {
    const response = await fetch("/api/user-settings");
    if (!response.ok) {
      throw new Error("ユーザー画面設定を読み込めませんでした");
    }
    const settings = await response.json();
    userTargetLanguageSelect.value = settings.target_language || "ja-JP";
    userJokeTextInput.value = Array.isArray(settings.joke_texts)
      ? settings.joke_texts.join("\n")
      : settings.joke_text || "";
    userJokePositionSelect.value = settings.joke_position || "after";
    userJokeSelectionSelect.value = settings.joke_selection || "rotation";
    userJokeVariationCountInput.value = String(settings.joke_variation_count || 0);
    userThemeSelect.value = settings.theme || "blue";
    renderAdminJokePreview(settings);
    renderUserSettingsStatus("ユーザー画面設定を読み込みました");
  } catch (error) {
    renderUserSettingsStatus(error.message || "ユーザー画面設定を読み込めませんでした");
  }
}

async function saveUserSettings() {
  userSettingsSaveButton.disabled = true;
  renderUserSettingsStatus("保存中");
  try {
    const response = await fetch("/api/user-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_language: userTargetLanguageSelect.value,
        joke_text: userJokeTextInput.value,
        joke_texts: splitAdminJokeTexts(userJokeTextInput.value),
        joke_position: userJokePositionSelect.value,
        joke_selection: userJokeSelectionSelect.value,
        joke_variation_count: Number(userJokeVariationCountInput.value || 0),
        theme: userThemeSelect.value,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "ユーザー画面設定を保存できませんでした");
    }
    const settings = await response.json();
    renderAdminJokePreview(settings);
    renderUserSettingsStatus(
      `保存しました（元 ${settings.joke_texts?.length || 0}件 / 生成 ${settings.joke_variants?.length || 0}件 / 合計 ${settings.joke_pool?.length || 0}件）`,
    );
  } catch (error) {
    renderUserSettingsStatus(error.message || "ユーザー画面設定を保存できませんでした");
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
