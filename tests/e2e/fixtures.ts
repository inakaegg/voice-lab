import type { Page } from "@playwright/test";

type UiFixtureOptions = {
  historyState?: "empty" | "long" | "error" | "disabled" | "practice-preview";
  practiceUiMode?: "local" | "cloudflare";
  practicePreviewModelAudio?: boolean;
  practicePreviewRecompute?: boolean;
  practicePreviewModelAudioMissing?: boolean;
  practicePreviewModelAudioDelayMs?: number;
  practicePreviewRecomputeUnavailableAtMaxPadding?: boolean;
  practicePreviewSavedPaddingMissing?: boolean;
  practicePreviewRecomputeDelayMs?: number;
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

// 無音WAVを組み立てて返す。音声を配信しないと、読み込み失敗のまま比較再生できると
// 判定していても気づけない。長さは比較区間より十分長くしてクリップを避ける。
function silentWav(seconds = 3): Buffer {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

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
    if (path === "/api/audio-history/outputs/practice-preview-model.wav") {
      if (options.practicePreviewModelAudioDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.practicePreviewModelAudioDelayMs));
      }
      if (options.practicePreviewModelAudioMissing) {
        return json({ detail: "not found" }, 404);
      }
      return route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
    }
    if (path === "/api/audio-history/recordings/practice-preview.wav") {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
    }
    if (path.endsWith("/recomputed-comparison")) {
      if (options.practicePreviewRecompute === false) {
        return json({
          available: false,
          unavailable_reason: "位置番号を持つ比較結果が保存されていないため、再計算できません。",
          comparison_alignment: {},
          model_comparison_alignment: {},
        });
      }
      const padding = Number(new URL(route.request().url()).searchParams.get("playback_padding_seconds") || 0);
      if (options.practicePreviewRecomputeUnavailableAtMaxPadding && padding >= 0.5) {
        return json({
          available: false,
          unavailable_reason: "位置番号を持つ比較結果が保存されていないため、再計算できません。",
          comparison_alignment: {},
          model_comparison_alignment: {},
        });
      }
      // 余白が小さいほど遅く返す。古い要求の応答が新しい応答より後に届く状況を再現する。
      const delayMs = options.practicePreviewRecomputeDelayMs ?? Math.round((0.5 - padding) * 400);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const shift = (phrases: Array<{ index: number; audio_start: number; audio_end: number }>) => ({
        available: true,
        complete: true,
        all_phrases_playable: true,
        target_phrase_count: phrases.length,
        playable_phrase_count: phrases.length,
        phrases: phrases.map((phrase) => ({
          ...phrase,
          available: true,
          audio_start: Math.max(0, phrase.audio_start - padding),
          audio_end: phrase.audio_end + padding,
        })),
      });
      return json({
        available: true,
        unavailable_reason: "",
        playback_padding_seconds: padding,
        saved_playback_padding_seconds: options.practicePreviewSavedPaddingMissing ? null : 0.1,
        comparison_alignment: shift([
          { index: 0, audio_start: 0.5, audio_end: 1.2 },
          { index: 1, audio_start: 1.2, audio_end: 2.0 },
          { index: 2, audio_start: 2.0, audio_end: 2.4 },
        ]),
        model_comparison_alignment: shift([
          { index: 0, audio_start: 0.4, audio_end: 1.1 },
          { index: 1, audio_start: 1.1, audio_end: 1.8 },
          { index: 2, audio_start: 1.8, audio_end: 2.2 },
        ]),
        reference_audio_duration: 3.0,
        attempt_audio_duration: 3.0,
      });
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
      if (options.historyState === "practice-preview") {
        return json({
          settings: { enabled: true },
          recordings: [{
            label: "中国語の復唱",
            filename: "practice-preview.wav",
            url: "/api/audio-history/recordings/practice-preview.wav",
            model_audio_url: options.practicePreviewModelAudio === false
              ? ""
              : "/api/audio-history/outputs/practice-preview-model.wav",
            model_audio_media_type: options.practicePreviewModelAudio === false ? "" : "audio/wav",
            text_preview: "银行周末也营业吗？",
            created_at: "20260720T101500000000Z",
            metadata: {
              endpoint: "practice-attempts",
              recording_intent: "attempt",
              practice_job_status: "succeeded",
              practice_diagnostics: {
                recording_kind: "attempt",
                target_language: "zh-CN",
                target_text: "银行周末也营业吗？",
                recognized_text: "银杏周末也营业吗？",
                outcome: "evaluated",
                playback_padding_seconds: options.practicePreviewSavedPaddingMissing ? null : 0.1,
                overall_score: 82,
                overall_comment: "最初の単語をもう一度確認しましょう。",
                comparison_target_pinyin: ["yin2", "hang2", "zhou1", "mo4", "ye3", "ying2", "ye4", "ma5"],
                comparison_recognized_pinyin: ["yin2", "xing4", "zhou1", "mo4", "ye3", "ying2", "ye4", "ma5"],
                llm_comparison: {
                  overall_score: 82,
                  overall_comment: "最初の単語をもう一度確認しましょう。",
                  phrases: [{ target_text: "银行", score: 62, comment: "「行」の発音を確認してください。" }],
                },
                comparison_alignment: {
                  available: true,
                  complete: true,
                  all_phrases_playable: true,
                  target_phrase_count: 2,
                  playable_phrase_count: 2,
                  phrases: [
                    { index: 0, available: true, audio_start: 0, audio_end: 1.2 },
                    { index: 1, available: true, audio_start: 1.2, audio_end: 2.4 },
                  ],
                },
                model_comparison_alignment: {
                  available: true,
                  complete: true,
                  all_phrases_playable: true,
                  target_phrase_count: 2,
                  playable_phrase_count: 2,
                  phrases: [
                    { index: 0, available: true, audio_start: 0, audio_end: 1.1 },
                    { index: 1, available: true, audio_start: 1.1, audio_end: 2.2 },
                  ],
                },
              },
            },
          }],
          outputs: [],
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
    if (path === "/api/runtime") {
      const local = options.practiceUiMode !== "cloudflare";
      return json({
        provider_mode: local ? "fake" : "cloudflare",
        providers: ["fake"],
        voice_conversion_backends: [],
        runpod_serverless: { available: false },
        ui_capabilities: {
          practice_developer_settings: local,
          practice_history_preview: local,
        },
      });
    }
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
