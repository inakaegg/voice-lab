const publicSampleAudioSections = [...document.querySelectorAll("[data-public-sample-feature]")];

if (publicSampleAudioSections.length > 0) {
  loadPublicSampleAudio();
}

async function loadPublicSampleAudio() {
  try {
    const response = await fetch("/api/public-sample-audios", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    for (const section of publicSampleAudioSections) {
      const featureValue = payload?.features?.[section.dataset.publicSampleFeature] || null;
      const sample = section.dataset.publicSampleLanguage
        ? featureValue?.samples?.[section.dataset.publicSampleLanguage] || null
        : featureValue;
      renderPublicSampleAudio(section, sample);
    }
  } catch (_error) {
    for (const section of publicSampleAudioSections) {
      section.hidden = true;
    }
  }
}

function renderPublicSampleAudio(section, sample) {
  const audio = section.querySelector("[data-public-sample-audio]");
  if (!sample?.audio_base64 || !audio) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const title = section.querySelector("[data-public-sample-title]");
  const description = section.querySelector("[data-public-sample-description]");
  if (title && section.dataset.publicSampleFixedTitle !== "true") {
    title.textContent = sample.title || "サンプル音声";
  }
  if (description) {
    description.textContent = sample.description || "";
    description.hidden = !sample.description;
  }
  audio.src = `data:${sample.audio_mime_type || "audio/wav"};base64,${sample.audio_base64}`;
}
