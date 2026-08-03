import assert from "node:assert/strict";
import test from "node:test";

import {
  initialZoovoiceState,
  zoovoiceReducer,
} from "../apps/web/src/zoovoice/state.ts";
import * as zoovoiceApi from "../apps/web/src/zoovoice/api.ts";
import { readFile } from "node:fs/promises";

test("zoovoice state follows recording compose and success phases", () => {
  const ready = zoovoiceReducer(initialZoovoiceState, { type: "config_loaded" });
  const recording = zoovoiceReducer(ready, { type: "recording_started" });
  const recorded = zoovoiceReducer(recording, { type: "recording_stopped", turnstileRequired: true });
  const processing = zoovoiceReducer(recorded, { type: "compose_started" });
  const success = zoovoiceReducer(processing, { type: "compose_succeeded", fallback: false });

  assert.equal(ready.phase, "idle");
  assert.equal(recording.phase, "recording");
  assert.equal(recorded.phase, "recorded");
  assert.equal(processing.phase, "processing");
  assert.equal(success.phase, "success");
  assert.equal(success.message, "できあがりました。再生して確認できます。");
});

test("starting a new recording clears an earlier result message", () => {
  const success = {
    phase: "success",
    message: "できあがりました。再生して確認できます。",
  } as const;

  const next = zoovoiceReducer(success, { type: "recording_started" });

  assert.deepEqual(next, { phase: "recording", message: "" });
});

test("errors retain an actionable Japanese message", () => {
  const next = zoovoiceReducer(initialZoovoiceState, {
    type: "failed",
    message: "マイクを使用できません。ブラウザの権限を確認してください。",
  });

  assert.deepEqual(next, {
    phase: "error",
    message: "マイクを使用できません。ブラウザの権限を確認してください。",
  });
});

test("zoovoice exposes only the animal intensity setting", async () => {
  const source = await readFile("apps/web/src/zoovoice/main.tsx", "utf8");
  for (const removed of ["<select", "にわとり牧場", "feel lucky", "<details", "SlotSelect", "Arrangement"]) {
    assert.doesNotMatch(source, new RegExp(removed, "i"));
  }
  assert.equal(source.match(/アニマル度/g)?.length, 1);
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
        evidence_term: "猫",
        selection_strategy: "direct",
        fallback_reason: null,
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
      "single-use-turnstile-token",
    );
    assert.equal(submittedForm?.get("turnstile_token"), "single-use-turnstile-token");
    assert.equal(submittedForm?.get("settings"), JSON.stringify({ intensity: 40 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
