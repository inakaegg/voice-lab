import { expect, test } from "@playwright/test";

import { installUiApiFixtures } from "./fixtures";

test.describe("SpeakLoop display language", () => {
  test.use({ locale: "en-US" });

  test.beforeEach(async ({ page }) => {
    await installUiApiFixtures(page);
  });

  test("an English browser gets English, and switching back survives a reload", async ({ page }) => {
    await page.goto("/speakloop");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(/practice with your own words/);
    await expect(page.getByRole("heading", { name: "Say what you mean" })).toBeVisible();
    await expect(page.getByText("Built with")).toBeVisible();

    // この画面はvanilla JS層を持つので、切り替えるとページを読み直す。
    await page.getByLabel("Display settings").click();
    await page.getByRole("radio", { name: "日本語" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page).toHaveTitle(/言いたいことで発音練習/);
    await expect(page.getByRole("heading", { name: "言いたいことを話す" })).toBeVisible();

    // 選択はlocalStorageに残るので、英語ブラウザで開き直しても日本語のままになる。
    await page.goto("/speakloop");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByText("使用技術")).toBeVisible();
  });

  // 属性が「実際の録音で」立つところまでを通す。ブラウザ依存のfake mediaフラグは使わず、
  // 既存specと同じく MediaRecorder と getUserMedia を差し替えるので全projectで動く。
  test("a real recording raises the busy flag and blocks the switch", async ({ page }) => {
    await page.addInitScript(() => {
      class FakeMediaRecorder extends EventTarget {
        static isTypeSupported() { return true; }
        state = "inactive";
        mimeType = "audio/webm";
        start() { this.state = "recording"; }
        stop() {
          this.state = "inactive";
          const event = new Event("dataavailable") as Event & { data: Blob };
          event.data = new Blob(["fake recording"], { type: this.mimeType });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder });
      Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });
      Object.defineProperty(window, "webkitAudioContext", { value: undefined, configurable: true });
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
        configurable: true,
      });
    });
    await page.goto("/speakloop");

    const body = page.locator("body");
    await expect(body).not.toHaveAttribute("data-practice-busy", "1");

    await page.getByRole("button", { name: "Record what you want to say" }).click();

    await expect(body).toHaveAttribute("data-practice-busy", "1");

    await page.getByLabel("Display settings").click();
    await expect(page.getByRole("radio", { name: "日本語" })).toBeDisabled();
    await expect(page.getByRole("radio", { name: "Light" })).toBeEnabled();
  });

  // 上のテストが「録音で印が立つ」ところを見るのに対し、こちらは印が消えたときに
  // UIが戻ることまでを見る。処理中の解除はAPI応答に依存するので、印を直接動かして確かめる。
  test("the switch is blocked while the practice flow is busy", async ({ page }) => {
    await page.goto("/speakloop");
    await page.getByLabel("Display settings").click();
    const japanese = page.getByRole("radio", { name: "日本語" });
    await expect(japanese).toBeEnabled();

    await page.evaluate(() => { document.body.dataset.practiceBusy = "1"; });

    // 止めるのは表示言語だけ。配色はページを読み直さないので進行中でも変えられる。
    await expect(japanese).toBeDisabled();
    await expect(page.getByRole("radio", { name: "Light" })).toBeEnabled();
    await expect(
      page.getByText("The display language cannot change while recording or processing"),
    ).toBeVisible();

    await page.evaluate(() => { delete document.body.dataset.practiceBusy; });
    await expect(japanese).toBeEnabled();
  });
});
