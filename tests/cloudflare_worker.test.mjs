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
  form.append("audio", new Blob(["webm"], { type: "audio/webm;codecs=opus" }), "recording.webm");
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

test("Cloudflare worker strips audio MIME parameters for voice conversion files", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return json({ id: "job-vc", status: "IN_QUEUE" });
  });
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["source"], { type: "audio/webm;codecs=opus" }), "source.webm");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/webm;codecs=opus" }), "reference.webm");

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.job_id, "job-vc");
  assert.equal(calls[0].body.input.operation_mode, "voice_conversion");
  assert.equal(calls[0].body.input.source_audio_mime_type, "audio/webm");
  assert.equal(calls[0].body.input.reference_audio_mime_type, "audio/webm");
});

test("Cloudflare worker maps completed RunPod status to local job snapshot", async () => {
  const env = fakeEnv(
    async () =>
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
    { kv: fakeKv() },
  );

  const response = await handleRequest(
    new Request("https://example.com/api/translate-speech-jobs/job-translate"),
    env,
  );
  const payload = await response.json();
  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(payload.status, "succeeded");
  assert.equal(payload.current_stage.stage, "complete");
  assert.equal(payload.result.translated_text, "こんにちは");
  assert.equal(history.outputs.length, 1);
  assert.equal(history.outputs[0].filename, "job-translate-output.wav");
  assert.equal(history.outputs[0].metadata.endpoint, "translate-speech-jobs");
  assert.equal(history.outputs[0].tts_text, "こんにちは");
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

test("Cloudflare worker persists user settings in KV and generates joke variations", async () => {
  const calls = [];
  const env = fakeEnv(
    async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "https://api.openai.com/v1/responses") {
        return json({ output_text: JSON.stringify({ variants: [["A1"], ["B1"]] }) });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv: fakeKv() },
  );

  const saveResponse = await handleRequest(
    new Request("https://example.com/api/user-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_language: "ja-JP",
        joke_texts: ["A", "B"],
        joke_position: "after",
        joke_selection: "rotation",
        joke_variation_count: 1,
        theme: "pop",
      }),
    }),
    env,
  );
  const saved = await saveResponse.json();
  const getResponse = await handleRequest(new Request("https://example.com/api/user-settings"), env);
  const loaded = await getResponse.json();

  assert.equal(saveResponse.status, 200);
  assert.deepEqual(saved.joke_variants, ["A1", "B1"]);
  assert.deepEqual(saved.joke_pool, ["A", "B", "A1", "B1"]);
  assert.equal(saved.theme, "pop");
  assert.deepEqual(loaded.joke_pool, saved.joke_pool);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
});

test("Cloudflare worker saves joke TTS output to KV audio history", async () => {
  const env = fakeEnv(
    async (url) => {
      if (url === "https://api.openai.com/v1/responses") {
        return json({ output_text: "Lucu sekali." });
      }
      if (url === "https://api.openai.com/v1/audio/speech") {
        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv: fakeKv() },
  );

  const jokeResponse = await handleRequest(
    new Request("https://example.com/api/user-joke-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "これは冗談です。", target_language: "id-ID" }),
    }),
    env,
  );
  const historyResponse = await handleRequest(new Request("https://example.com/api/audio-history"), env);
  const history = await historyResponse.json();
  const entry = history.outputs[0];
  const audioResponse = await handleRequest(new Request(`https://example.com${entry.url}`), env);
  const audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
  const deleteResponse = await handleRequest(
    new Request(`https://example.com${entry.url}`, { method: "DELETE" }),
    env,
  );
  const afterDelete = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(jokeResponse.status, 200);
  assert.equal(history.settings.enabled, true);
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 1);
  assert.equal(entry.metadata.endpoint, "user-joke-output");
  assert.equal(entry.tts_text, "Lucu sekali.");
  assert.deepEqual([...audioBytes], [4, 5, 6]);
  assert.equal(audioResponse.headers.get("Content-Type"), "audio/wav");
  assert.deepEqual(await deleteResponse.json(), { deleted: true });
  assert.deepEqual(afterDelete.outputs, []);
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

function fakeEnv(fetchImpl, options = {}) {
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
    MO_SPEECH_KV: options.kv || null,
    __fetch: fetchImpl,
  };
}

function json(payload, init = {}) {
  return Response.json(payload, init);
}

function fakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
