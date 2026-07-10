const publicAccessRoots = [...document.querySelectorAll("[data-public-access-settings]")];
let currentPublicAccessSettings = null;

if (publicAccessRoots.length > 0) {
  for (const root of publicAccessRoots) {
    root.querySelector("[data-public-access-save]")?.addEventListener("click", () => savePublicAccessSettings(root));
  }
  loadPublicAccessSettings();
}

async function loadPublicAccessSettings() {
  try {
    setPublicAccessStatus("読み込み中です。");
    const response = await fetch("/api/public-access-settings");
    if (!response.ok) {
      throw new Error(response.status === 401 ? "管理ログインが必要です。" : `公開制限を取得できませんでした: ${response.status}`);
    }
    currentPublicAccessSettings = await response.json();
    for (const root of publicAccessRoots) {
      renderPublicAccessSettings(root, currentPublicAccessSettings);
    }
    setPublicAccessStatus("");
  } catch (error) {
    setPublicAccessStatus(publicAccessErrorMessage(error), "error");
  }
}

async function savePublicAccessSettings(root) {
  try {
    if (!currentPublicAccessSettings) {
      await loadPublicAccessSettings();
    }
    const next = clonePublicAccessSettings(currentPublicAccessSettings);
    collectPublicAccessSettings(root, next);
    setPublicAccessSaveButton(root, "保存中...", true);
    setPublicAccessStatus("保存中です。");
    const response = await fetch("/api/public-access-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `公開制限を保存できませんでした: ${response.status}`);
    }
    currentPublicAccessSettings = await response.json();
    for (const targetRoot of publicAccessRoots) {
      renderPublicAccessSettings(targetRoot, currentPublicAccessSettings);
    }
    const adminCount = Array.isArray(currentPublicAccessSettings.admin_google_emails)
      ? currentPublicAccessSettings.admin_google_emails.length
      : 0;
    setPublicAccessSaveButton(root, "保存済み", false);
    setPublicAccessStatus(`保存しました。quota対象外の管理者Googleメール: ${adminCount}件。`, "success");
    window.setTimeout(() => {
      setPublicAccessSaveButton(root, "保存", false, "保存済み");
    }, 2400);
  } catch (error) {
    setPublicAccessSaveButton(root, "保存", false);
    setPublicAccessStatus(publicAccessErrorMessage(error), "error");
  }
}

function renderPublicAccessSettings(root, settings) {
  const googleRequired = root.querySelector('[data-public-setting="google_login_required"]');
  if (googleRequired) {
    googleRequired.checked = Boolean(settings.google_login_required);
  }
  const adminEmails = root.querySelector('[data-public-setting="admin_google_emails"]');
  if (adminEmails) {
    adminEmails.value = Array.isArray(settings.admin_google_emails) ? settings.admin_google_emails.join("\n") : "";
  }
  const visibleFeatures = allowedPublicAccessFeatures(root);
  for (const section of root.querySelectorAll("[data-public-feature]")) {
    const feature = section.dataset.publicFeature;
    section.hidden = visibleFeatures.length > 0 && !visibleFeatures.includes(feature);
    const featureSettings = settings.features?.[feature] || {};
    for (const input of section.querySelectorAll("[data-public-feature-setting]")) {
      const key = input.dataset.publicFeatureSetting;
      input.value = featureSettings[key] ?? "";
    }
  }
}

function collectPublicAccessSettings(root, settings) {
  const googleRequired = root.querySelector('[data-public-setting="google_login_required"]');
  if (googleRequired) {
    settings.google_login_required = Boolean(googleRequired.checked);
  }
  const adminEmails = root.querySelector('[data-public-setting="admin_google_emails"]');
  if (adminEmails) {
    settings.admin_google_emails = adminEmails.value
      .split(/[\n,]+/)
      .map((email) => email.trim())
      .filter(Boolean);
  }
  settings.features = settings.features || {};
  for (const section of root.querySelectorAll("[data-public-feature]")) {
    if (section.hidden) {
      continue;
    }
    const feature = section.dataset.publicFeature;
    settings.features[feature] = settings.features[feature] || {};
    for (const input of section.querySelectorAll("[data-public-feature-setting]")) {
      const key = input.dataset.publicFeatureSetting;
      settings.features[feature][key] = Number.parseInt(input.value, 10);
    }
  }
}

function allowedPublicAccessFeatures(root) {
  return String(root.dataset.publicAccessFeatures || "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function setPublicAccessStatus(text, state = "") {
  for (const root of publicAccessRoots) {
    const status = root.querySelector("[data-public-access-status]");
    if (!status) {
      continue;
    }
    status.textContent = text;
    status.dataset.state = state;
  }
}

function setPublicAccessSaveButton(root, text, disabled, onlyIfText = "") {
  const button = root.querySelector("[data-public-access-save]");
  if (!button) {
    return;
  }
  if (onlyIfText && button.textContent !== onlyIfText) {
    return;
  }
  button.textContent = text;
  button.disabled = Boolean(disabled);
}

function clonePublicAccessSettings(settings) {
  if (typeof structuredClone === "function") {
    return structuredClone(settings);
  }
  return JSON.parse(JSON.stringify(settings));
}

function publicAccessErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
