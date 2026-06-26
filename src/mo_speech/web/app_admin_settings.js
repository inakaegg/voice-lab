const userTargetLanguageSelect = document.querySelector("#user_target_language");
const userJokeTextInput = document.querySelector("#user_joke_text");
const userJokePositionSelect = document.querySelector("#user_joke_position");
const userJokeSelectionSelect = document.querySelector("#user_joke_selection");
const userJokeVariationCountInput = document.querySelector("#user_joke_variation_count");
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
    renderUserSettingsStatus(`保存しました（ジョーク候補 ${settings.joke_pool?.length || 0}件）`);
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
