import type { Page } from "@playwright/test";

type UiFixtureOptions = {
  historyState?: "empty" | "long" | "error" | "disabled";
};

const accessSettings = {
  google_login_required: false,
  admin_google_emails: ["portfolio-owner@example.com"],
  features: {
    fun: { daily_limit: 10, total_limit: 100, audio_max_bytes: 8_000_000, text_max_chars: 500 },
    voice_conversion: { daily_limit: 10, total_limit: 100, audio_max_bytes: 8_000_000 },
    speakloop: { daily_limit: 10, total_limit: 100, audio_max_bytes: 8_000_000, text_max_chars: 500 },
    skitvoice: { daily_limit: 10, total_limit: 100, audio_max_bytes: 8_000_000, script_max_chars: 2_000 },
  },
};

export async function installUiApiFixtures(page: Page, options: UiFixtureOptions = {}) {
  let publicSamples: Record<string, unknown> = {
    features: { fun: null, voice_conversion: null, speakloop: null, skitvoice: { samples: {} } },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path === "/api/public-session") return json({ google_login_required: false, google_login_configured: true, authenticated: false });
    if (path === "/api/public-access-settings") return json(accessSettings);
    if (path === "/api/public-sample-audios") {
      if (request.method() === "PUT") {
        await new Promise((resolve) => setTimeout(resolve, 120));
        publicSamples = request.postDataJSON();
      }
      return json(publicSamples);
    }
    if (path === "/api/practice-history") {
      if (options.historyState === "disabled") return json({ settings: { enabled: false }, recordings: [], outputs: [] });
      if (options.historyState === "error") return json({ detail: "履歴fixtureの読み込みに失敗しました" }, 500);
      if (options.historyState === "long") {
        const longLabel = "長い日本語タイトルとファイル名を含む発音練習履歴_".repeat(6);
        const diagnostics = {
          recognized_text: "とても長い認識結果です。".repeat(30),
          phrase_matches: Array.from({ length: 12 }, (_, index) => ({ index, text: `比較区間${index}`.repeat(5), score: 0.95 })),
        };
        return json({
          recordings: [{ label: longLabel, filename: `${longLabel}.wav`, url: "/fixtures/recording.wav", details: ["録音", longLabel], created_at: "2026-07-10T10:00:00Z", metadata: { practice_diagnostics: diagnostics } }],
          outputs: [{ label: `お手本_${longLabel}`, filename: `model_${longLabel}.wav`, url: "/fixtures/model.wav", details: ["お手本", longLabel], created_at: "2026-07-10T10:00:00Z" }],
        });
      }
      return json({ recordings: [], outputs: [] });
    }
    if (path === "/api/audio-history") {
      if (options.historyState === "disabled") return json({ settings: { enabled: false }, recordings: [], outputs: [] });
      if (options.historyState === "error") return json({ detail: "音声履歴fixtureの読み込みに失敗しました" }, 500);
      if (options.historyState === "long") {
        const longLabel = "長い音声履歴ファイル名と詳細情報_".repeat(8);
        const entry = {
          kind: "outputs",
          filename: `${longLabel}.wav`,
          label: longLabel,
          url: "/fixtures/history.wav",
          media_type: "audio/wav",
          size_bytes: 123456,
          created_at: "2026-07-10T10:00:00Z",
          details: [longLabel, "非常に長い診断情報".repeat(12)],
          tts_text: "長い読み上げテキストです。".repeat(20),
        };
        return json({
          recordings: [{ ...entry, kind: "recordings", filename: `input_${entry.filename}` }],
          outputs: [entry],
          settings: { enabled: true, resolved_root: `/tmp/${longLabel}`, limit: 100, env_var: "MO_AUDIO_HISTORY_DIR" },
        });
      }
      return json({ recordings: [], outputs: [], settings: { enabled: false } });
    }
    if (path === "/api/user-settings") return json({ theme: "blue", joke_text: "", joke_pool: [], effect_audio_files: [] });
    if (path === "/api/runtime") return json({ provider_mode: "fake", providers: ["fake"], voice_conversion_backends: [], runpod_serverless: { available: false } });
    if (path === "/api/vibevoice/status") return json({ available: true, backends: { local: { available: true }, runpod_serverless: { available: false } } });
    return route.continue();
  });
}

export async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth + 1 || dimensions.bodyScrollWidth > dimensions.clientWidth + 1) {
    throw new Error(`horizontal overflow: ${JSON.stringify(dimensions)}`);
  }
}

export async function assertVisibleControlsInsideViewport(page: Page) {
  const outside = await page.locator("a, button, input, select, textarea, summary").evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 40) || element.tagName, left: rect.left, right: rect.right };
    })
    .filter((item) => item.left < -1 || item.right > window.innerWidth + 1));
  if (outside.length) throw new Error(`controls outside viewport: ${JSON.stringify(outside)}`);
}
