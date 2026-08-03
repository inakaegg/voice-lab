import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl || "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/zoovoice.spec.ts", "**/zoovoice-real-backend.spec.ts"],
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
