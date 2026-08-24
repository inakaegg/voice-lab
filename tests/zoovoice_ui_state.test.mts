import assert from "node:assert/strict";
import test from "node:test";

import {
  controlsForZoovoiceState,
  initialZoovoiceState,
  isComposeReady,
  isTurnstileTokenFresh,
  zoovoiceReducer,
} from "../apps/web/src/zoovoice/state.ts";
import * as zoovoiceApi from "../apps/web/src/zoovoice/api.ts";
import { readFile } from "node:fs/promises";

test("zoovoice state distinguishes finalizing verification compose and success", () => {
  const ready = zoovoiceReducer(initialZoovoiceState, { type: "config_loaded" });
  const starting = zoovoiceReducer(ready, { type: "recording_starting" });
  const recording = zoovoiceReducer(ready, { type: "recording_started" });
  const finalizing = zoovoiceReducer(recording, { type: "recording_stopping" });
  const verifying = zoovoiceReducer(finalizing, { type: "verification_waiting" });
  const processing = zoovoiceReducer(verifying, { type: "compose_started" });
  const success = zoovoiceReducer(processing, { type: "compose_succeeded", fallback: false });

  assert.equal(ready.phase, "idle");
  assert.equal(starting.phase, "starting");
  assert.equal(recording.phase, "recording");
  assert.equal(finalizing.phase, "finalizing");
  assert.equal(verifying.phase, "verifying");
  assert.equal(processing.phase, "processing");
  assert.equal(success.phase, "success");
  assert.equal(success.message, "できあがりました。自動再生を開始します。");
  assert.equal(success.errorKind, "none");
});

test("starting a new recording clears an earlier result message", () => {
  const success = {
    phase: "success",
    message: "できあがりました。自動再生を開始します。",
    errorKind: "none",
  } as const;

  const next = zoovoiceReducer(success, { type: "recording_starting" });

  assert.deepEqual(next, { phase: "starting", message: "マイクを準備しています。", errorKind: "none" });
});

test("cancelling returns to idle and says the recording was not sent", () => {
  const next = zoovoiceReducer(initialZoovoiceState, { type: "recording_cancelled" });

  assert.deepEqual(next, {
    phase: "idle",
    message: "録音をキャンセルしました。音声は送信していません。",
    errorKind: "none",
  });
});

test("errors retain their kind and actionable Japanese message", () => {
  const next = zoovoiceReducer(initialZoovoiceState, {
    type: "failed",
    kind: "mic_denied",
    message: "マイクを使用できません。ブラウザの権限を確認してください。",
  });

  assert.deepEqual(next, {
    phase: "error",
    message: "マイクを使用できません。ブラウザの権限を確認してください。",
    errorKind: "mic_denied",
  });
});

test("error kinds determine orb slider and retry controls", () => {
  const rows = [
    { kind: "compose_retryable", orb: true, slider: true, retry: true },
    { kind: "verify_timeout", orb: true, slider: true, retry: true },
    { kind: "compose_terminal", orb: true, slider: true, retry: false },
    { kind: "mic_denied", orb: true, slider: true, retry: false },
    { kind: "setup_failed", orb: false, slider: false, retry: false },
  ] as const;

  for (const row of rows) {
    const state = { phase: "error", message: "error", errorKind: row.kind } as const;
    assert.deepEqual(
      controlsForZoovoiceState(state, { configEnabled: true, hasRecording: true }),
      { orbEnabled: row.orb, sliderEnabled: row.slider, retryVisible: row.retry },
      row.kind,
    );
  }
});

test("recording keeps the orb available for stop while settings stay fixed", () => {
  const state = { phase: "recording", message: "", errorKind: "none" } as const;

  assert.deepEqual(
    controlsForZoovoiceState(state, { configEnabled: true, hasRecording: false }),
    { orbEnabled: true, sliderEnabled: false, retryVisible: false },
  );
});

test("Turnstile token freshness rejects empty stale and boundary-age tokens", () => {
  const now = 1_000_000;
  assert.equal(isTurnstileTokenFresh("", now - 1_000, now), false);
  assert.equal(isTurnstileTokenFresh("token", now - 239_999, now), true);
  assert.equal(isTurnstileTokenFresh("token", now - 240_000, now), false);
  assert.equal(isComposeReady(false, "", 0, now), true);
  assert.equal(isComposeReady(true, "", now - 1_000, now), false);
  assert.equal(isComposeReady(true, "token", now - 1_000, now), true);
});

test("zoovoice exposes only the supported user settings", async () => {
  const source = await readFile("apps/web/src/zoovoice/main.tsx", "utf8");
  for (const removed of ["<select", "にわとり牧場", "feel lucky", "<details", "SlotSelect", "Arrangement"]) {
    assert.doesNotMatch(source, new RegExp(removed, "i"));
  }
  assert.equal(source.match(/アニマル度/g)?.length, 1);
  assert.equal(source.match(/動物の数/g)?.length, 2);
});

test("zoovoice public config distinguishes local and Turnstile gateways", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    enabled: true,
    turnstile_required: true,
    turnstile_site_key: "public-site-key",
    audio_max_bytes: 10_000_000,
    origin_timeout_seconds: 90,
  });
  try {
    assert.deepEqual(await zoovoiceApi.fetchZoovoiceConfig(), {
      enabled: true,
      turnstile_required: true,
      turnstile_site_key: "public-site-key",
      audio_max_bytes: 10_000_000,
      origin_timeout_seconds: 90,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zoovoice compose sends the current single-use Turnstile token", async () => {
  const originalFetch = globalThis.fetch;
  let submittedForm: FormData | null = null;
  globalThis.fetch = async (_input, init) => {
    submittedForm = init?.body as FormData;
    return Response.json({
      audio: { format: "wav", base64: "UklGRg==" },
      meta: {
        transcript: "猫が眠っています",
        selected_animal: { id: "cat", label_ja: "猫" },
        selected_animals: [{ id: "cat", label_ja: "猫", reason: "猫が出てくるため" }],
        association_reason: "猫が出てくるため",
        insertions: [],
        input_duration_seconds: 1,
        output_duration_seconds: 1,
      },
    });
  };
  try {
    await zoovoiceApi.composeRecording(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      40,
      1,
      "single-use-turnstile-token",
    );
    assert.equal(submittedForm?.get("turnstile_token"), "single-use-turnstile-token");
    assert.equal(
      submittedForm?.get("settings"),
      JSON.stringify({ intensity: 40, animal_count: 1 }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zoovoice compose preserves the association reason", async () => {
  const originalFetch = globalThis.fetch;
  const reason: zoovoiceApi.ComposeResponse["meta"]["association_reason"] = "「ぞうきん」の語呂合わせでゾウを連想";
  globalThis.fetch = async () => Response.json({
    audio: { format: "wav", base64: "UklGRg==" },
    meta: {
      transcript: "ぞうきんを絞る",
      selected_animal: { id: "elephant", label_ja: "象" },
      selected_animals: [{ id: "elephant", label_ja: "象", reason }],
      association_reason: reason,
      insertions: [],
      input_duration_seconds: 1,
      output_duration_seconds: 1,
    },
  });
  try {
    const response = await zoovoiceApi.composeRecording(new Blob(["audio"]), 50, 1);
    assert.equal(response.meta.association_reason, reason);
    assert.equal(response.meta.selected_animals[0]?.reason, reason);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zoovoice result names only the animals whose calls were inserted", () => {
  const meta = (insertions: zoovoiceApi.ComposeResponse["meta"]["insertions"]) => ({
    transcript: "屋根で何かが鳴いた",
    selected_animal: { id: "cat", label_ja: "猫" },
    selected_animals: [
      { id: "cat", label_ja: "猫", reason: "猫が出てくるため" },
      { id: "dog", label_ja: "犬", reason: "犬も連想したため" },
    ],
    association_reason: "猫が出てくるため",
    insertions,
    input_duration_seconds: 4,
    output_duration_seconds: 6,
  });

  // アニマル度0や短い録音では末尾の1本だけになり、鳴るのは1種目だけになる。
  assert.deepEqual(
    zoovoiceApi.insertedAnimalLabels(
      meta([{ slot: "ending", species: "cat", at_seconds: 4, duration_seconds: 2.5 }]),
    ),
    ["猫"],
  );
  assert.deepEqual(
    zoovoiceApi.insertedAnimalLabels(
      meta([
        { slot: "word", species: "dog", at_seconds: 1.2, duration_seconds: 0.8 },
        { slot: "ending", species: "cat", at_seconds: 4, duration_seconds: 2.5 },
      ]),
    ),
    ["猫", "犬"],
  );
});

test("zoovoice API errors retain gateway code message and HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: { code: "zoovoice_quota_exceeded", message: "本日の利用上限に達しました。" },
  }, { status: 429 });
  try {
    await assert.rejects(
      zoovoiceApi.composeRecording(new Blob(["audio"]), 50, "token"),
      (error: unknown) => {
        assert.ok(error instanceof zoovoiceApi.ZoovoiceApiError);
        assert.equal(error.code, "zoovoice_quota_exceeded");
        assert.equal(error.status, 429);
        assert.equal(error.message, "本日の利用上限に達しました。");
        assert.equal(zoovoiceApi.isRetryableZoovoiceError(error), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-JSON HTTP 5xx remains retryable while unknown JSON codes fail closed", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("upstream unavailable", { status: 502 });
    await assert.rejects(
      zoovoiceApi.composeRecording(new Blob(["audio"]), 50, "token"),
      (error: unknown) => {
        assert.ok(error instanceof zoovoiceApi.ZoovoiceApiError);
        assert.equal(error.code, "zoovoice_http_unavailable");
        assert.equal(zoovoiceApi.isRetryableZoovoiceError(error), true);
        return true;
      },
    );

    globalThis.fetch = async () => Response.json({
      error: { code: "zoovoice_future_error", message: "unknown" },
    }, { status: 502 });
    await assert.rejects(
      zoovoiceApi.composeRecording(new Blob(["audio"]), 50, "token"),
      (error: unknown) => {
        assert.ok(error instanceof zoovoiceApi.ZoovoiceApiError);
        assert.equal(zoovoiceApi.isRetryableZoovoiceError(error), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway error codes use an explicit retry allowlist and fail closed", () => {
  const retryable = new Set([
    "association_unavailable",
    "zoovoice_backend_unavailable",
    "zoovoice_gateway_error",
    "zoovoice_origin_timeout",
  ]);
  // Cloud Run由来のコードはWorkerがそのまま中継するため、gatewayのコードと同じ表で扱う。
  const knownGatewayCodes = [
    "asr_empty",
    "association_failed",
    "association_unavailable",
    "zoovoice_audio_too_large",
    "zoovoice_backend_unavailable",
    "zoovoice_budget_unavailable",
    "zoovoice_catalog_unavailable",
    "zoovoice_disabled",
    "zoovoice_gateway_error",
    "zoovoice_invalid_origin_response",
    "zoovoice_invalid_request",
    "zoovoice_invalid_settings",
    "zoovoice_method_not_allowed",
    "zoovoice_origin_auth_failed",
    "zoovoice_origin_rejected",
    "zoovoice_origin_timeout",
    "zoovoice_quota_exceeded",
    "zoovoice_settings_too_large",
    "zoovoice_turnstile_failed",
    "zoovoice_turnstile_unavailable",
    "zoovoice_usage_counters",
  ];

  for (const code of knownGatewayCodes) {
    assert.equal(
      zoovoiceApi.isRetryableZoovoiceError(new zoovoiceApi.ZoovoiceApiError(code, 500, code)),
      retryable.has(code),
      code,
    );
  }
  assert.equal(
    zoovoiceApi.isRetryableZoovoiceError(new zoovoiceApi.ZoovoiceApiError("future_unknown_code", 503, "unknown")),
    false,
  );
});

test("zoovoice compose sends the selected animal count", async () => {
  const originalFetch = globalThis.fetch;
  let submittedForm: FormData | null = null;
  globalThis.fetch = async (_input, init) => {
    submittedForm = init?.body as FormData;
    return Response.json({
      audio: { format: "wav", base64: "UklGRg==" },
      meta: {
        transcript: "夜の屋根で鳴いていた",
        selected_animal: { id: "cat", label_ja: "猫" },
        selected_animals: [
          { id: "cat", label_ja: "猫", reason: "夜の屋根といえば猫" },
          { id: "owl", label_ja: "フクロウ", reason: "夜に鳴く鳥だから" },
        ],
        association_reason: "夜の屋根といえば猫",
        insertions: [],
        input_duration_seconds: 1,
        output_duration_seconds: 1,
      },
    });
  };
  try {
    const response = await zoovoiceApi.composeRecording(new Blob(["audio"]), 60, 2);
    assert.equal(
      submittedForm?.get("settings"),
      JSON.stringify({ intensity: 60, animal_count: 2 }),
    );
    assert.equal(response.meta.selected_animals.length, 2);
    // 1件目は selected_animal と同じものになる。
    assert.equal(response.meta.selected_animals[0]?.id, response.meta.selected_animal.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
