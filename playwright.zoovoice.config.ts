import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl || "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/zoovoice.spec.ts", "**/zoovoice-real-backend.spec.ts", "**/portal-zoovoice.spec.ts", "**/language-switch.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  outputDir: "tmp/playwright/zoovoice-test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "tmp/playwright/zoovoice-report", open: "never" }],
  ],
  use: {
    baseURL,
    // 既存specは日本語の文言で要素を特定する。表示言語の初期値は navigator.language を見るため、
    // 実行環境のロケールに左右されないよう ja-JP へ固定する。英語表示は language-switch.spec.ts が
    // spec単位でロケールを上書きして確かめる。
    locale: "ja-JP",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "intermediate", use: { viewport: { width: 1024, height: 768 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command:
          "npm run build:web && npx wrangler dev --local --ip 127.0.0.1 --port 4173 --persist-to tmp/playwright-wrangler --var ZOOVOICE_ENABLED:1",
        url: "http://127.0.0.1:4173/",
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
        env: process.env,
      },
});
