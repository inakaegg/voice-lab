(function initializeSampleAudioControls(global) {
  function ensureVoiceLabAudioControl(audio, label = "音声") {
    if (!(audio instanceof HTMLAudioElement)) {
      return null;
    }
    let control = audio.parentElement?.querySelector(":scope > [data-sample-audio-control]");
    if (!control) {
      control = createControl(audio);
      audio.insertAdjacentElement("afterend", control);
    }
    audio.controls = false;
    audio.hidden = true;
    audio.dataset.sampleAudioNative = "true";
    updateLabels(control, label);
    resetControl(audio, control);
    control.hidden = false;
    return control;
  }

  function hideVoiceLabAudioControl(audio) {
    const control = audio?.parentElement?.querySelector(":scope > [data-sample-audio-control]");
    if (control) {
      control.hidden = true;
      setPlaying(control, false);
    }
  }

  function createControl(audio) {
    const control = document.createElement("div");
    control.className = "sample-audio-control";
    control.dataset.sampleAudioControl = "true";

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "sample-audio-play-button";
    playButton.innerHTML = '<svg class="sample-audio-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg><svg class="sample-audio-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "sample-audio-seek";
    seek.min = "0";
    seek.max = "0";
    seek.step = "0.01";
    seek.value = "0";

    const time = document.createElement("output");
    time.className = "sample-audio-time";
    time.textContent = "0:00";

    control.append(playButton, seek, time);
    playButton.addEventListener("click", async () => {
      if (audio.paused) {
        for (const other of document.querySelectorAll("audio")) {
          if (other !== audio && !other.paused) other.pause();
        }
        try {
          await audio.play();
        } catch (_error) {
          setPlaying(control, false);
        }
      } else {
        audio.pause();
      }
    });
    seek.addEventListener("input", () => {
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(Number(seek.value), audio.duration);
        updateProgress(audio, control);
      }
    });
    audio.addEventListener("play", () => setPlaying(control, true));
    audio.addEventListener("pause", () => setPlaying(control, false));
    audio.addEventListener("ended", () => {
      setPlaying(control, false);
      updateProgress(audio, control);
    });
    audio.addEventListener("timeupdate", () => updateProgress(audio, control));
    audio.addEventListener("loadedmetadata", () => updateProgress(audio, control));
    audio.addEventListener("durationchange", () => updateProgress(audio, control));
    return control;
  }

  function updateLabels(control, label) {
    const playButton = control.querySelector(".sample-audio-play-button");
    const seek = control.querySelector(".sample-audio-seek");
    control.dataset.audioLabel = label;
    playButton?.setAttribute("aria-label", `${label}を再生`);
    seek?.setAttribute("aria-label", `${label}の再生位置`);
  }

  function resetControl(audio, control) {
    setPlaying(control, false);
    const seek = control.querySelector(".sample-audio-seek");
    if (seek) seek.value = "0";
    updateProgress(audio, control);
  }

  function setPlaying(control, playing) {
    control.dataset.state = playing ? "playing" : "paused";
    const button = control.querySelector(".sample-audio-play-button");
    if (button) {
      button.setAttribute("aria-label", `${control.dataset.audioLabel || "サンプル音声"}を${playing ? "一時停止" : "再生"}`);
      button.setAttribute("aria-pressed", String(playing));
    }
  }

  function updateProgress(audio, control) {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const seek = control.querySelector(".sample-audio-seek");
    const time = control.querySelector(".sample-audio-time");
    if (seek) {
      seek.max = String(duration);
      seek.value = String(Math.min(currentTime, duration || currentTime));
      seek.style.setProperty("--sample-audio-progress", `${duration > 0 ? (currentTime / duration) * 100 : 0}%`);
    }
    if (time) time.textContent = duration > 0 ? `${formatTime(currentTime)} / ${formatTime(duration)}` : formatTime(currentTime);
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  global.ensureVoiceLabAudioControl = ensureVoiceLabAudioControl;
  global.hideVoiceLabAudioControl = hideVoiceLabAudioControl;
  global.ensureSampleAudioControl = ensureVoiceLabAudioControl;
})(window);
