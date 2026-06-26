function syncSeedVcSettingsDefaults() {
  const settings = seedVcSettingsForSelectedBackend();
  if (!settings) {
    return;
  }
  setInputValue(seedVcDiffusionStepsInput, settings.diffusion_steps);
  setInputValue(seedVcReferenceMaxSecondsInput, settings.reference_max_seconds);
  setCheckedValue(seedVcReferenceAutoSelectInput, settings.reference_auto_select);
  setInputValue(seedVcLengthAdjustInput, settings.length_adjust);
  setInputValue(seedVcInferenceCfgRateInput, settings.inference_cfg_rate);
  syncSeedVcPresetSelection();
}

function syncSeedVcSettingsVisibility() {
  if (!seedVcSettingsPanel) {
    return;
  }
  const selected = [...voiceBackendSelect.options].find((option) => option.value === voiceBackendSelect.value);
  const translationUsesSeedVc =
    operationModeSelect.value === "translation" && selectedVoiceMode() === "convert";
  const voiceConversionUsesSeedVc =
    operationModeSelect.value === "voice_conversion" &&
    voiceBackendSelect.value === "seed-vc" &&
    !Boolean(selected?.disabled);
  seedVcSettingsPanel.hidden =
    !translationUsesSeedVc && !voiceConversionUsesSeedVc;
}

function seedVcSettingsForSelectedBackend() {
  const selected = voiceConversionBackends.find((backend) => backend.id === "seed-vc");
  return selected?.settings?.seed_vc || null;
}

function appendSeedVcSettings(formData, voiceBackend) {
  if (voiceBackend !== "seed-vc") {
    return;
  }
  appendNumberSetting(formData, "seed_vc_diffusion_steps", seedVcDiffusionStepsInput.value);
  appendNumberSetting(formData, "seed_vc_reference_max_seconds", seedVcReferenceMaxSecondsInput.value);
  formData.append("seed_vc_reference_auto_select", seedVcReferenceAutoSelectInput.checked ? "true" : "false");
  appendNumberSetting(formData, "seed_vc_length_adjust", seedVcLengthAdjustInput.value);
  appendNumberSetting(formData, "seed_vc_inference_cfg_rate", seedVcInferenceCfgRateInput.value);
}

function applySeedVcPreset() {
  const preset = seedVcPresets[seedVcPresetSelect.value];
  if (!preset) {
    return;
  }
  setInputValue(seedVcDiffusionStepsInput, preset.diffusion_steps);
  setInputValue(seedVcReferenceMaxSecondsInput, preset.reference_max_seconds);
  setInputValue(seedVcLengthAdjustInput, preset.length_adjust);
  setInputValue(seedVcInferenceCfgRateInput, preset.inference_cfg_rate);
}

function syncSeedVcPresetSelection() {
  const current = currentSeedVcSettings();
  const matched = Object.entries(seedVcPresets).find(([, preset]) => sameSeedVcSettings(current, preset));
  seedVcPresetSelect.value = matched ? matched[0] : "custom";
}

function currentSeedVcSettings() {
  return {
    diffusion_steps: Number(seedVcDiffusionStepsInput.value),
    reference_max_seconds: Number(seedVcReferenceMaxSecondsInput.value),
    length_adjust: Number(seedVcLengthAdjustInput.value),
    inference_cfg_rate: Number(seedVcInferenceCfgRateInput.value),
  };
}

function sameSeedVcSettings(left, right) {
  return (
    numbersEqual(left.diffusion_steps, right.diffusion_steps) &&
    numbersEqual(left.reference_max_seconds, right.reference_max_seconds) &&
    numbersEqual(left.length_adjust, right.length_adjust) &&
    numbersEqual(left.inference_cfg_rate, right.inference_cfg_rate)
  );
}

function numbersEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.0001;
}

function appendNumberSetting(formData, name, value) {
  if (value !== "") {
    formData.append(name, value);
  }
}

function setInputValue(input, value) {
  if (!input || value === undefined || value === null) {
    return;
  }
  input.value = String(value);
}

function setCheckedValue(input, value) {
  if (!input || value === undefined || value === null) {
    return;
  }
  input.checked = Boolean(value);
}
