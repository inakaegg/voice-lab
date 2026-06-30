import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../cloudflare/worker.mjs";

test("Cloudflare worker translates speech with OpenAI and stores a completed job", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response("Halo Jepang", { status: 200 });
    }
    if (url === "https://api.openai.com/v1/responses") {
      if (calls.filter((call) => call.url === url).length === 1) {
        return json({
          output_text: JSON.stringify({
            source_language: "id-ID",
            target_language: "ja-JP",
            translated_text: "こんにちは日本",
          }),
        });
      }
      return json({ output_text: "こんにちは日本" });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
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
  const polled = await (
    await handleRequest(new Request(`https://example.com/api/translate-speech-jobs/${payload.job_id}`), env)
  ).json();
  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(response.status, 200);
  assert.match(payload.job_id, /^cf-/);
  assert.equal(payload.status, "succeeded");
  assert.equal(payload.result.transcript, "Halo Jepang");
  assert.equal(payload.result.translated_text, "こんにちは日本");
  assert.equal(payload.result.transformed_text, "こんにちは日本");
  assert.equal(payload.result.target_language, "ja-JP");
  assert.equal(payload.result.audio_base64, Buffer.from([7, 8, 9]).toString("base64"));
  assert.deepEqual(polled, payload);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[2].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[3].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(history.recordings.length, 1);
  assert.equal(history.recordings[0].metadata.original_content_type, "audio/webm;codecs=opus");
  assert.equal(history.outputs.length, 1);
  assert.equal(history.outputs[0].metadata.endpoint, "translate-speech-jobs");
});

test("Cloudflare worker creates a pronunciation practice prompt", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response("コーヒーがほしいです", { status: 200 });
    }
    if (url === "https://api.openai.com/v1/responses" && calls.filter((call) => call.url === url).length === 1) {
      return json({
        output_text: JSON.stringify({
          source_language: "ja-JP",
          target_language: "zh-CN",
          translated_text: "我想要咖啡。",
        }),
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: "wǒ xiǎng yào kā fēi" });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([10, 11, 12]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["native"], { type: "audio/webm" }), "native.webm");
  form.append("target_language", "zh-CN");
  form.append("include_pinyin", "true");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/prompts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();
  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();
  const practiceHistory = await (await handleRequest(new Request("https://example.com/api/practice-history"), env)).json();

  assert.equal(response.status, 200);
  assert.equal(payload.transcript, "コーヒーがほしいです");
  assert.equal(payload.target_language, "zh-CN");
  assert.equal(payload.target_text, "我想要咖啡。");
  assert.equal(payload.audio_base64, Buffer.from([10, 11, 12]).toString("base64"));
  assert.equal(payload.display_text.primary_text, "我想要咖啡。");
  assert.equal(payload.display_text.pinyin_text, "wǒ xiǎng yào kā fēi");
  assert.equal(payload.display_text.pinyin_status, "ready");
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[2].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls[3].url, "https://api.openai.com/v1/responses");
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 0);
  assert.equal(practiceHistory.recordings[0].metadata.endpoint, "practice-prompts");
  assert.equal(practiceHistory.outputs[0].metadata.endpoint, "practice-prompts");
});

test("Cloudflare worker scores a pronunciation practice attempt", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, language: init.body?.get?.("language") || "" });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response("I want coffee", { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("target_language", "en-US");
  form.append("target_text", "I want a coffee.");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].language, "en");
  assert.equal(payload.recognized_text, "I want coffee");
  assert.equal(payload.grade, "ok");
  assert.ok(payload.similarity >= 0.85);
  assert.equal(payload.normalized_target, "iwantacoffee");
  assert.equal(payload.normalized_recognized, "iwantcoffee");
  assert.ok(Array.isArray(payload.diff));
  assert.ok(payload.diff.every((entry) => Number.isInteger(entry.recognized_start)));
});

test("Cloudflare worker forces Chinese practice attempts to Chinese ASR", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, language: init.body?.get?.("language") || "" });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response("你好，你最近怎麼樣?", { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好，你最近怎么样？");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].language, "zh");
  assert.equal(payload.grade, "ok");
  assert.equal(payload.similarity, 1);
  assert.equal(payload.normalized_target, payload.normalized_recognized);
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
  form.append("audio_effect_audio", new Blob(["moo"], { type: "audio/mpeg" }), "cow.mp3");
  form.append("audio_effect_enabled", "true");
  form.append("audio_effect_insert_mode", "silence_or_tail");
  form.append("audio_effect_max_insertions", "2");
  form.append("audio_effect_min_silence_ms", "450");

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
  assert.equal(calls[0].body.input.audio_effect_audio_mime_type, "audio/mpeg");
  assert.equal(calls[0].body.input.audio_effect_audio_base64, Buffer.from("moo").toString("base64"));
  assert.equal(calls[0].body.input.audio_effect_insert_mode, "silence_or_tail");
  assert.equal(calls[0].body.input.audio_effect_max_insertions, 2);
  assert.equal(calls[0].body.input.audio_effect_min_silence_ms, 450);
});

test("Cloudflare worker saves voice conversion source audio to KV history", async () => {
  const env = fakeEnv(
    async () => json({ id: "job-vc", status: "IN_QUEUE" }),
    { kv: fakeKv() },
  );
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["source"], { type: "audio/webm;codecs=opus" }), "source.webm");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/webm;codecs=opus" }), "reference.webm");

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", body: form }),
    env,
  );
  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(response.status, 200);
  assert.equal(history.recordings.length, 1);
  assert.equal(history.recordings[0].filename, "job-vc-source.webm");
  assert.equal(history.recordings[0].metadata.endpoint, "voice-conversion-jobs");
  assert.equal(history.recordings[0].metadata.content_type, "audio/webm;codecs=opus");
});

test("Cloudflare worker maps completed RunPod voice conversion status to local job snapshot", async () => {
  const env = fakeEnv(
    async () =>
      json({
        id: "job-vc",
        status: "COMPLETED",
        output: {
          audio_mime_type: "audio/wav",
          audio_base64: "AAAA",
        },
      }),
    { kv: fakeKv() },
  );

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs/job-vc"),
    env,
  );
  const payload = await response.json();
  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(payload.status, "succeeded");
  assert.equal(payload.current_stage.stage, "complete");
  assert.equal(payload.result.audio_base64, "AAAA");
  assert.equal(history.outputs.length, 1);
  assert.equal(history.outputs[0].filename, "job-vc-output.wav");
  assert.equal(history.outputs[0].metadata.endpoint, "voice-conversion-jobs");
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
        effect_audios: [
          {
            id: "cow",
            name: "cow.wav",
            audio_mime_type: "audio/wav",
            audio_base64: Buffer.from("moo").toString("base64"),
          },
        ],
        effect_selection: "random",
        effect_insert_mode: "tail",
        effect_max_insertions: 2,
        effect_min_silence_ms: 450,
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
  assert.equal(saved.effect_audios[0].id, "cow");
  assert.equal(saved.effect_selection, "random");
  assert.equal(saved.effect_insert_mode, "tail");
  assert.equal(saved.effect_max_insertions, 2);
  assert.equal(saved.effect_min_silence_ms, 450);
  assert.equal(saved.theme, "pop");
  assert.deepEqual(loaded.joke_pool, saved.joke_pool);
  assert.deepEqual(loaded.effect_audios, saved.effect_audios);
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

test("Cloudflare worker can expose one hundred audio history entries per kind", async () => {
  const env = fakeEnv(async () => json({ ok: true }), { kv: fakeKv() });
  env.CLOUDFLARE_AUDIO_HISTORY_LIMIT = "100";

  const history = await (await handleRequest(new Request("https://example.com/api/audio-history"), env)).json();

  assert.equal(history.settings.limit, 100);
});

test("Cloudflare worker reports RunPod runtime availability and warm health", async () => {
  const env = fakeEnv(async () => json({ workers: [{ state: "IDLE" }] }));

  const response = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const payload = await response.json();
  const openai = payload.translation_backends.find((backend) => backend.id === "openai");
  const runpod = payload.translation_backends.find((backend) => backend.id === "runpod_serverless");
  const seedVc = payload.voice_conversion_backends[0];

  assert.equal(openai.available, true);
  assert.equal(openai.providers.asr, "openai-asr-gpt-4o-transcribe");
  assert.equal(openai.settings.request_mode, "completed_job");
  assert.equal(runpod.available, false);
  assert.equal(runpod.settings.health.warm, true);
  assert.equal(seedVc.available, true);
  assert.equal(seedVc.settings.seed_vc.model_resident, false);
  assert.equal(seedVc.settings.warmup.ready, false);
  assert.equal(seedVc.settings.warmup.auto_on_user_page_load, false);
  assert.equal(seedVc.settings.health.warm, true);
});

test("Cloudflare worker only enables user-page warmup when explicitly opted in", async () => {
  const env = fakeEnv(async () => json({ workers: [{ state: "IDLE" }] }));
  env.RUNPOD_AUTO_WARMUP_ON_USER_LOAD = "1";

  const response = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const payload = await response.json();
  const seedVc = payload.voice_conversion_backends[0];

  assert.equal(seedVc.settings.warmup.auto_on_user_page_load, true);
});

test("Cloudflare worker marks Seed-VC ready only after warmup job succeeds", async () => {
  const kv = fakeKv();
  const calls = [];
  const env = fakeEnv(
    async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/run")) {
        return json({ id: "warm-job", status: "IN_QUEUE" });
      }
      if (url.endsWith("/status/warm-job")) {
        return json({
          id: "warm-job",
          status: "COMPLETED",
          output: {
            warm: true,
            providers: { voice_conversion: "seed-vc" },
            serverless_timings_ms: { voice_conversion_service_load: 123.4 },
          },
        });
      }
      if (url.endsWith("/health")) {
        return json({ workers: [{ state: "IDLE" }] });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv },
  );

  const warmupResponse = await handleRequest(new Request("https://example.com/api/warmup", { method: "POST" }), env);
  const warmupJob = await warmupResponse.json();
  const statusResponse = await handleRequest(new Request("https://example.com/api/warmup/warm-job"), env);
  const statusJob = await statusResponse.json();
  const runtimeResponse = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const runtime = await runtimeResponse.json();
  const seedVc = runtime.voice_conversion_backends[0];

  assert.equal(warmupJob.status, "queued");
  assert.equal(statusJob.status, "succeeded");
  assert.equal(calls[0].body.input.preload_voice_conversion, true);
  assert.equal(seedVc.settings.seed_vc.model_resident, true);
  assert.equal(seedVc.settings.warmup.ready, true);
  assert.equal(seedVc.settings.warmup.job_id, "warm-job");
});

test("Cloudflare worker stores Seed-VC ready state when warmup run completes immediately", async () => {
  const kv = fakeKv();
  const env = fakeEnv(
    async (url) => {
      if (url.endsWith("/run")) {
        return json({
          id: "warm-job",
          status: "COMPLETED",
          output: {
            warm: true,
            providers: { voice_conversion: "seed-vc" },
          },
        });
      }
      if (url.endsWith("/health")) {
        return json({ workers: [{ state: "IDLE" }] });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv },
  );

  const warmupResponse = await handleRequest(new Request("https://example.com/api/warmup", { method: "POST" }), env);
  const warmupJob = await warmupResponse.json();
  const runtimeResponse = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const runtime = await runtimeResponse.json();
  const seedVc = runtime.voice_conversion_backends[0];

  assert.equal(warmupJob.status, "succeeded");
  assert.equal(seedVc.settings.seed_vc.model_resident, true);
  assert.equal(seedVc.settings.warmup.ready, true);
  assert.equal(seedVc.settings.warmup.source, "warmup");
});

test("Cloudflare worker stores Seed-VC ready state when voice conversion run completes immediately", async () => {
  const kv = fakeKv();
  const env = fakeEnv(
    async (url) => {
      if (url.endsWith("/run")) {
        return json({
          id: "vc-job",
          status: "COMPLETED",
          output: {
            audio_mime_type: "audio/wav",
            audio_base64: "AAAA",
          },
        });
      }
      if (url.endsWith("/health")) {
        return json({ workers: [{ state: "IDLE" }] });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv },
  );
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["source"], { type: "audio/webm" }), "source.webm");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/webm" }), "reference.webm");

  const vcResponse = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", body: form }),
    env,
  );
  const vcJob = await vcResponse.json();
  const runtimeResponse = await handleRequest(new Request("https://example.com/api/runtime"), env);
  const runtime = await runtimeResponse.json();
  const seedVc = runtime.voice_conversion_backends[0];

  assert.equal(vcJob.status, "succeeded");
  assert.equal(seedVc.settings.seed_vc.model_resident, true);
  assert.equal(seedVc.settings.warmup.ready, true);
  assert.equal(seedVc.settings.warmup.source, "voice_conversion");
});

test("Cloudflare worker scopes Seed-VC ready state by RunPod endpoint", async () => {
  const kv = fakeKv();
  const fetchImpl = async (url) => {
    if (url.endsWith("/status/warm-job")) {
      return json({
        id: "warm-job",
        status: "COMPLETED",
        output: {
          warm: true,
          providers: { voice_conversion: "seed-vc" },
        },
      });
    }
    if (url.endsWith("/health")) {
      return json({ workers: [{ state: "IDLE" }] });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const firstEnv = fakeEnv(fetchImpl, { kv });
  firstEnv.RUNPOD_ENDPOINT_ID = "endpoint-a";
  const secondEnv = fakeEnv(fetchImpl, { kv });
  secondEnv.RUNPOD_ENDPOINT_ID = "endpoint-b";

  await handleRequest(new Request("https://example.com/api/warmup/warm-job"), firstEnv);
  const firstRuntime = await (await handleRequest(new Request("https://example.com/api/runtime"), firstEnv)).json();
  const secondRuntime = await (await handleRequest(new Request("https://example.com/api/runtime"), secondEnv)).json();

  assert.equal(firstRuntime.voice_conversion_backends[0].settings.warmup.ready, true);
  assert.equal(secondRuntime.voice_conversion_backends[0].settings.warmup.ready, false);
  assert.equal(secondRuntime.voice_conversion_backends[0].settings.seed_vc.model_resident, false);
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

function parseJsonBody(body) {
  if (typeof body !== "string") {
    return null;
  }
  return JSON.parse(body);
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
