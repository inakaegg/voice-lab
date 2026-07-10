import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl || "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: process.env.PLAYWRIGHT_VISUAL_REVIEW ? [] : ["**/visual-review.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  outputDir: "tmp/playwright/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "tmp/playwright/report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "intermediate", use: { viewport: { width: 1024, height: 768 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
  webServer: externalBaseUrl ? undefined : {
    command: "python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONPATH: "src",
      MO_PROVIDER_MODE: "fake",
      MO_AUDIO_HISTORY_ENABLED: "0",
      MO_PRELOAD_MODELS: "0",
      MO_PRELOAD_VOICE_CONVERSION: "0",
      MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START: "0",
      MO_USER_SETTINGS_PATH: "tmp/playwright-user-settings.json",
      MO_VIBEVOICE_DEBUG_RESULT_DIR: "off",
    },
  },
});
