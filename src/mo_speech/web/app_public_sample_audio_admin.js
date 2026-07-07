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
    setPublicSampleAdminStatus(errorMessage(error), "error");
  }
}

async function savePublicSampleAudios(root) {
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
      next.features[feature] = await collectPublicSampleFeature(section);
    }
    setPublicSampleAdminStatus("保存中です。");
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
    setPublicSampleAdminStatus("保存しました。");
  } catch (error) {
    setPublicSampleAdminStatus(errorMessage(error), "error");
  }
}

function renderPublicSampleAdmin(root, samples) {
  const visibleFeatures = allowedPublicSampleFeatures(root);
  for (const section of root.querySelectorAll("[data-public-sample-admin-feature]")) {
    const feature = section.dataset.publicSampleAdminFeature;
    section.hidden = visibleFeatures.length > 0 && !visibleFeatures.includes(feature);
    const sample = samples?.features?.[feature] || null;
    section.querySelector("[data-public-sample-title]").value = sample?.title || "";
    section.querySelector("[data-public-sample-description]").value = sample?.description || "";
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
    title: section.querySelector("[data-public-sample-title]")?.value || "",
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
    if (!section.querySelector("[data-public-sample-title]")?.value) {
      section.querySelector("[data-public-sample-title]").value = file.name.replace(/\.[^.]+$/, "");
    }
    renderPublicSamplePreview(section, {
      title: section.querySelector("[data-public-sample-title]")?.value || "サンプル音声",
      description: section.querySelector("[data-public-sample-description]")?.value || "",
      filename: section.dataset.publicSampleFilename,
      audio_mime_type: section.dataset.publicSampleAudioMimeType,
      audio_base64: audioBase64,
    });
  } catch (error) {
    setPublicSampleAdminStatus(errorMessage(error), "error");
  }
}

async function deletePublicSample(section) {
  const feature = section.dataset.publicSampleAdminFeature;
  const savedSample = currentPublicSampleAudios?.features?.[feature] || null;
  if (!savedSample) {
    clearPublicSampleSection(section);
    setPublicSampleAdminStatus("未保存の選択を取り消しました。");
    return;
  }
  if (!window.confirm("保存済みのサンプル音声を削除しますか？")) {
    return;
  }
  try {
    setPublicSampleAdminStatus("削除中です。");
    const response = await fetch(`/api/public-sample-audios/${encodeURIComponent(feature)}`, {
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
    setPublicSampleAdminStatus("削除しました。");
  } catch (error) {
    setPublicSampleAdminStatus(errorMessage(error), "error");
  }
}

function clearPublicSampleSection(section) {
  section.dataset.publicSampleAudioBase64 = "";
  section.dataset.publicSampleAudioMimeType = "";
  section.dataset.publicSampleFilename = "";
  section.querySelector("[data-public-sample-file]").value = "";
  renderPublicSamplePreview(section, null);
}

function renderPublicSamplePreview(section, sample) {
  const preview = section.querySelector("[data-public-sample-preview]");
  const details = section.querySelector("[data-public-sample-details]");
  if (!preview || !details) {
    return;
  }
  if (!sample?.audio_base64) {
    preview.hidden = true;
    preview.removeAttribute("src");
    details.textContent = "未設定";
    return;
  }
  preview.hidden = false;
  preview.src = `data:${sample.audio_mime_type || "audio/wav"};base64,${sample.audio_base64}`;
  details.textContent = `${sample.filename || "sample"} / ${sample.audio_mime_type || "audio"} / ${formatBytes(sample.size_bytes || base64ByteLength(sample.audio_base64))}`;
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
