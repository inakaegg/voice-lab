import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../cloudflare/worker.mjs";

test("Cloudflare worker maps translate form data to RunPod async job", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return json({ id: "job-translate", status: "IN_QUEUE" });
  });
  const form = new FormData();
  form.append("audio", new Blob(["webm"], { type: "audio/webm" }), "recording.webm");
  form.append("source_language", "auto");
  form.append("target_language", "user-auto");
  form.append("voice_mode", "default");
  form.append("text_transform", "user_effects");
  form.append("text_transform_options", JSON.stringify({ variation: true }));

  const response = await handleRequest(
    new Request("https://example.com/api/translate-speech-jobs", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.job_id, "job-translate");
  assert.equal(payload.status, "queued");
  assert.equal(calls[0].url, "https://api.runpod.ai/v2/endpoint/run");
  assert.equal(calls[0].init.headers.Authorization, "Bearer runpod-secret");
  assert.equal(calls[0].body.input.operation_mode, "translation");
  assert.equal(calls[0].body.input.translation_backend, "openai");
  assert.equal(calls[0].body.input.audio_mime_type, "audio/webm");
  assert.equal(calls[0].body.input.audio_base64, Buffer.from("webm").toString("base64"));
  assert.deepEqual(calls[0].body.input.text_transform_options, { variation: true });
});

test("Cloudflare worker maps completed RunPod status to local job snapshot", async () => {
  const env = fakeEnv(async () =>
    json({
      id: "job-translate",
      status: "COMPLETED",
      output: {
        transcript: "Halo",
        translated_text: "こんにちは",
        audio_mime_type: "audio/wav",
        audio_base64: "AAAA",
      },
    }),
  );

  const response = await handleRequest(
    new Request("https://example.com/api/translate-speech-jobs/job-translate"),
    env,
  );
  const payload = await response.json();

  assert.equal(payload.status, "succeeded");
  assert.equal(payload.current_stage.stage, "complete");
  assert.equal(payload.result.translated_text, "こんにちは");
});

test("Cloudflare worker creates user text output with OpenAI text transform and TTS", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: "めっちゃこんにちは" });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const response = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Halo",
        translated_text: "こんにちは",
        target_language: "ja-JP",
        text_transform_options: { osaka_dialect: true },
      }),
    }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.transformed_text, "めっちゃこんにちは");
  assert.equal(payload.audio_mime_type, "audio/wav");
  assert.equal(payload.audio_base64, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(calls[0].body.model, "gpt-5.5");
  assert.equal(calls[1].body.response_format, "wav");
});

test("Cloudflare worker reports RunPod runtime availability and warm health", async () => {
  const env = fakeEnv(async () => json({ workers: [{ state: "IDLE" }] }));

  const response = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const payload = await response.json();
  const runpod = payload.translation_backends.find((backend) => backend.id === "runpod_serverless");

  assert.equal(runpod.available, true);
  assert.equal(runpod.settings.health.warm, true);
  assert.equal(payload.voice_conversion_backends[0].settings.seed_vc.model_resident, true);
});

function fakeEnv(fetchImpl) {
  return {
    RUNPOD_ENDPOINT_ID: "endpoint",
    RUNPOD_API_KEY: "runpod-secret",
    RUNPOD_API_BASE_URL: "https://api.runpod.ai/v2",
    RUNPOD_SERVERLESS_TRANSLATION_BACKEND: "openai",
    OPENAI_API_KEY: "openai-secret",
    OPENAI_TRANSLATION_MODEL: "gpt-5.5",
    OPENAI_TEXT_TRANSFORM_MODEL: "gpt-5.5",
    OPENAI_TEXT_DISPLAY_MODEL: "gpt-5.5",
    OPENAI_TTS_MODEL: "gpt-4o-mini-tts",
    OPENAI_TTS_VOICE: "coral",
    OPENAI_TTS_RESPONSE_FORMAT: "wav",
    __fetch: fetchImpl,
  };
}

function json(payload, init = {}) {
  return Response.json(payload, init);
}
