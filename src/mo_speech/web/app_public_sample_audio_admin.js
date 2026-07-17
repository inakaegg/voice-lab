const publicSampleAdminRoots = [...document.querySelectorAll("[data-public-samples-admin]")];
let currentPublicSampleAudios = null;

if (publicSampleAdminRoots.length > 0) {
  for (const root of publicSampleAdminRoots) {
    root.querySelector("[data-public-samples-save]")?.addEventListener("click", () => savePublicSampleAudios(root));
    for (const featureSection of root.querySelectorAll("[data-public-sample-admin-feature]")) {
      featureSection.querySelector("[data-public-sample-delete]")?.addEventListener("click", () => deletePublicSample(featureSection));
      featureSection.querySelector("[data-public-sample-file]")?.addEventListener("change", () => previewPublicSampleFile(featureSection));
    }
  }
  loadPublicSampleAudios();
}

async function loadPublicSampleAudios() {
  try {
    setPublicSampleAdminStatus("読み込み中です。");
    const response = await fetch("/api/public-sample-audios", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`サンプル音声を取得できませんでした: ${response.status}`);
    }
    currentPublicSampleAudios = await response.json();
    for (const root of publicSampleAdminRoots) {
      renderPublicSampleAdmin(root, currentPublicSampleAudios);
    }
    setPublicSampleAdminStatus("");
  } catch (error) {
    setPublicSampleAdminStatus(publicSampleErrorMessage(error), "error");
  }
}

async function savePublicSampleAudios(root) {
  setPublicSampleActionButton(root.querySelector("[data-public-samples-save]"), "保存中…", true);
  try {
    if (!currentPublicSampleAudios) {
      await loadPublicSampleAudios();
    }
    const next = cloneJson(currentPublicSampleAudios || { features: {} });
    next.features = next.features || {};
    for (const section of root.querySelectorAll("[data-public-sample-admin-feature]")) {
      if (section.hidden) {
        continue;
      }
      const feature = section.dataset.publicSampleAdminFeature;
      const language = section.dataset.publicSampleLanguage || "";
      if (language) {
        next.features[feature] = next.features[feature]?.samples ? next.features[feature] : { samples: {} };
        next.features[feature].samples[language] = await collectPublicSampleFeature(section);
      } else {
        next.features[feature] = await collectPublicSampleFeature(section);
      }
    }
    setPublicSampleAdminStatus("保存中です。", "loading");
    const response = await fetch("/api/public-sample-audios", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `サンプル音声を保存できませんでした: ${response.status}`);
    }
    currentPublicSampleAudios = await response.json();
    for (const targetRoot of publicSampleAdminRoots) {
      renderPublicSampleAdmin(targetRoot, currentPublicSampleAudios);
    }
    setPublicSampleActionButton(root.querySelector("[data-public-samples-save]"), "保存済み", false);
    setPublicSampleAdminStatus(
      isSkitVoiceSampleAdmin(root)
        ? "研究用サンプルとして保存しました。一般画面には表示されません。"
        : "保存しました。ユーザー画面へ反映されています。",
      "success",
    );
    window.setTimeout(() => {
      setPublicSampleActionButton(root.querySelector("[data-public-samples-save]"), "保存", false, "保存済み");
    }, 2400);
  } catch (error) {
    setPublicSampleActionButton(root.querySelector("[data-public-samples-save]"), "再試行", false);
    setPublicSampleAdminStatus(publicSampleErrorMessage(error), "error");
  }
}

function renderPublicSampleAdmin(root, samples) {
  const visibleFeatures = allowedPublicSampleFeatures(root);
  for (const section of root.querySelectorAll("[data-public-sample-admin-feature]")) {
    const feature = section.dataset.publicSampleAdminFeature;
    section.hidden = visibleFeatures.length > 0 && !visibleFeatures.includes(feature);
    const language = section.dataset.publicSampleLanguage || "";
    const featureValue = samples?.features?.[feature] || null;
    const sample = language ? featureValue?.samples?.[language] || null : featureValue;
    const titleInput = section.querySelector("[data-public-sample-title]");
    if (titleInput) {
      titleInput.value = sample?.title || "";
    }
    const descriptionInput = section.querySelector("[data-public-sample-description]");
    if (descriptionInput) {
      descriptionInput.value = sample?.description || "";
    }
    section.querySelector("[data-public-sample-file]").value = "";
    section.dataset.publicSampleAudioBase64 = sample?.audio_base64 || "";
    section.dataset.publicSampleAudioMimeType = sample?.audio_mime_type || "";
    section.dataset.publicSampleFilename = sample?.filename || "";
    renderPublicSamplePreview(section, sample);
  }
}

async function collectPublicSampleFeature(section) {
  const audioBase64 = section.dataset.publicSampleAudioBase64 || "";
  if (!audioBase64) {
    return null;
  }
  return {
    title: section.querySelector("[data-public-sample-title]")?.value || publicSampleLanguageLabel(section),
    description: section.querySelector("[data-public-sample-description]")?.value || "",
    filename: section.dataset.publicSampleFilename || "",
    audio_mime_type: section.dataset.publicSampleAudioMimeType || "audio/wav",
    audio_base64: audioBase64,
  };
}

async function previewPublicSampleFile(section) {
  try {
    const file = section.querySelector("[data-public-sample-file]")?.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > 1_800_000) {
      throw new Error("サンプル音声は1.8MB以内にしてください。");
    }
    const audioBase64 = await fileToBase64(file);
    section.dataset.publicSampleAudioBase64 = audioBase64;
    section.dataset.publicSampleAudioMimeType = file.type || "audio/wav";
    section.dataset.publicSampleFilename = file.name || "sample.wav";
    const titleInput = section.querySelector("[data-public-sample-title]");
    if (titleInput && !titleInput.value) {
      titleInput.value = file.name.replace(/\.[^.]+$/, "");
    }
    renderPublicSamplePreview(section, {
      title: titleInput?.value || publicSampleLanguageLabel(section),
      description: section.querySelector("[data-public-sample-description]")?.value || "",
      filename: section.dataset.publicSampleFilename,
      audio_mime_type: section.dataset.publicSampleAudioMimeType,
      audio_base64: audioBase64,
    });
    setPublicSampleAdminStatus(
      isSkitVoiceSampleAdmin(section.closest("[data-public-samples-admin]"))
        ? "ファイルを選択しました。保存後も一般画面には表示されません。"
        : "ファイルを選択しました。保存するとユーザー画面へ反映されます。",
      "ready",
    );
  } catch (error) {
    setPublicSampleAdminStatus(publicSampleErrorMessage(error), "error");
  }
}

async function deletePublicSample(section) {
  const feature = section.dataset.publicSampleAdminFeature;
  const language = section.dataset.publicSampleLanguage || "";
  const featureValue = currentPublicSampleAudios?.features?.[feature] || null;
  const savedSample = language ? featureValue?.samples?.[language] || null : featureValue;
  if (!savedSample) {
    clearPublicSampleSection(section);
    setPublicSampleAdminStatus("未保存の選択を取り消しました。");
    return;
  }
  if (!window.confirm("保存済みのサンプル音声を削除しますか？")) {
    return;
  }
  try {
    const deleteButton = section.querySelector("[data-public-sample-delete]");
    setPublicSampleActionButton(deleteButton, "削除中…", true);
    setPublicSampleAdminStatus("削除中です。", "loading");
    const languageQuery = language ? `?language=${encodeURIComponent(language)}` : "";
    const response = await fetch(`/api/public-sample-audios/${encodeURIComponent(feature)}${languageQuery}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `サンプル音声を削除できませんでした: ${response.status}`);
    }
    currentPublicSampleAudios = await response.json();
    for (const targetRoot of publicSampleAdminRoots) {
      renderPublicSampleAdmin(targetRoot, currentPublicSampleAudios);
    }
    setPublicSampleActionButton(deleteButton, "削除済み", false);
    setPublicSampleAdminStatus(
      isSkitVoiceSampleAdmin(section.closest("[data-public-samples-admin]"))
        ? "研究用サンプルを削除しました。"
        : "削除しました。ユーザー画面からも非表示になりました。",
      "success",
    );
    window.setTimeout(() => {
      setPublicSampleActionButton(deleteButton, "保存済みを削除", false, "削除済み");
    }, 2400);
  } catch (error) {
    setPublicSampleActionButton(section.querySelector("[data-public-sample-delete]"), "再試行", false);
    setPublicSampleAdminStatus(publicSampleErrorMessage(error), "error");
  }
}

function clearPublicSampleSection(section) {
  section.dataset.publicSampleAudioBase64 = "";
  section.dataset.publicSampleAudioMimeType = "";
  section.dataset.publicSampleFilename = "";
  section.querySelector("[data-public-sample-file]").value = "";
  renderPublicSamplePreview(section, null);
}

function isSkitVoiceSampleAdmin(root) {
  return Boolean(root?.dataset.publicSamplesFeatures?.split(",").map((value) => value.trim()).includes("skitvoice"));
}

function renderPublicSamplePreview(section, sample) {
  const preview = section.querySelector("[data-public-sample-preview]");
  const details = section.querySelector("[data-public-sample-details]");
  if (!preview) {
    return;
  }
  if (!sample?.audio_base64) {
    preview.hidden = true;
    preview.removeAttribute("src");
    if (details) {
      details.textContent = "未設定";
    }
    return;
  }
  preview.hidden = false;
  preview.src = `data:${sample.audio_mime_type || "audio/wav"};base64,${sample.audio_base64}`;
  if (preview.hasAttribute("data-sample-audio-custom")) {
    window.ensureSampleAudioControl?.(preview, `${publicSampleLanguageLabel(section)}サンプル`);
  }
  if (details) {
    details.textContent = `${sample.audio_mime_type || "audio"} / ${formatBytes(sample.size_bytes || base64ByteLength(sample.audio_base64))}`;
  }
}

function publicSampleLanguageLabel(section) {
  return { "en-US": "英語", "zh-CN": "中国語", "ja-JP": "日本語" }[section.dataset.publicSampleLanguage] || "サンプル音声";
}

function allowedPublicSampleFeatures(root) {
  return String(root.dataset.publicSamplesFeatures || "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function setPublicSampleAdminStatus(text, state = "") {
  for (const root of publicSampleAdminRoots) {
    const status = root.querySelector("[data-public-samples-status]");
    if (!status) {
      continue;
    }
    status.textContent = text;
    status.dataset.state = state;
  }
}

function setPublicSampleActionButton(button, text, disabled, onlyIfText = "") {
  if (!button || (onlyIfText && button.textContent !== onlyIfText)) {
    return;
  }
  button.textContent = text;
  button.disabled = Boolean(disabled);
  button.dataset.state = text === "保存済み" || text === "削除済み" ? "success" : disabled ? "loading" : "";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("ファイルを読めませんでした。")));
    reader.readAsDataURL(file);
  });
}

function base64ByteLength(base64) {
  const value = String(base64 || "").replace(/\s/g, "");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value > 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)}MB`;
  }
  if (value > 1024) {
    return `${Math.round(value / 1024)}KB`;
  }
  return `${value}B`;
}

function cloneJson(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function publicSampleErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
