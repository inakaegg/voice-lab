import assert from "node:assert/strict";
import test from "node:test";

import worker from "../cloudflare/src/index.ts";
import {
  handleRequest,
  runtimeResponse,
} from "../cloudflare/worker.mjs";

async function responseSnapshot(response) {
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort()),
    body: await response.text(),
  };
}

test("Hono entry delegates routes that have not migrated to the legacy handler", async () => {
  const expectedEnv = {
    ASSETS: {
      async fetch(request) {
        return new Response(`legacy:${new URL(request.url).pathname}`, {
          status: 207,
          headers: { "X-Legacy": "delegated" },
        });
      },
    },
  };
  const actualEnv = {
    ASSETS: {
      async fetch(request) {
        return new Response(`legacy:${new URL(request.url).pathname}`, {
          status: 207,
          headers: { "X-Legacy": "delegated" },
        });
      },
    },
  };
  const request = new Request("https://example.com/speakloop");

  const expected = await handleRequest(request.clone(), expectedEnv, {});
  const actual = await worker.fetch(request, actualEnv, {});

  assert.deepEqual(
    await responseSnapshot(actual),
    await responseSnapshot(expected),
  );
});

test("Hono runtime route preserves the legacy status headers and body", async () => {
  const expected = await runtimeResponse({});
  const actual = await worker.fetch(
    new Request("https://example.com/api/runtime"),
    {},
    {},
  );

  assert.deepEqual(
    await responseSnapshot(actual),
    await responseSnapshot(expected),
  );
});

test("Hono runtime route preserves the legacy error response", async () => {
  const env = {
    RUNPOD_ENDPOINT_ID: "endpoint",
    RUNPOD_API_KEY: "secret",
    RUNPOD_RUNTIME_HEALTH_CHECK: "0",
    MO_SPEECH_KV: {
      async get() {
        throw new Error("KV unavailable");
      },
    },
  };

  const expected = await runtimeResponse(env);
  const actual = await worker.fetch(
    new Request("https://example.com/api/runtime"),
    env,
    {},
  );

  assert.deepEqual(
    await responseSnapshot(actual),
    await responseSnapshot(expected),
  );
  assert.equal(actual.status, 500);
});

test("Hono runtime route delegates non-GET methods to the legacy handler", async () => {
  const request = new Request("https://example.com/api/runtime", {
    method: "HEAD",
  });
  const expected = await handleRequest(request.clone(), {}, {});
  const actual = await worker.fetch(request, {}, {});

  assert.deepEqual(
    await responseSnapshot(actual),
    await responseSnapshot(expected),
  );
  assert.equal(actual.status, 404);
});

test("Hono entry delegates scheduled retention to the legacy implementation", async () => {
  await assert.doesNotReject(
    worker.scheduled(
      { scheduledTime: Date.parse("2026-07-23T03:17:00.000Z") },
      {},
      {},
    ),
  );
});
