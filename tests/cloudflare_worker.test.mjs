import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import workerEntrypoint from "../cloudflare/src/index.ts";
import { handleRequest, runPublicDataRetention, validatePracticeLlmResult } from "../cloudflare/worker.mjs";
import { clearZoovoiceIdTokenCacheForTests } from "../cloudflare/zoovoice-gateway.mjs";
import { resolveCreditClient } from "../cloudflare/credit-client.mjs";
import { CREDIT_RESERVATION_SQL } from "../cloudflare/worker.mjs";

test("Cloudflare worker routes only the current public app pages", async () => {
  const requestedPaths = [];
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = {
    async fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      return new Response("asset", { status: 200 });
    },
  };
  env.ZOOVOICE_ENABLED = "1";

  await handleRequest(new Request("https://example.com/"), env);
  await handleRequest(new Request("https://example.com/speakloop"), env);
  await handleRequest(new Request("https://example.com/zoovoice"), env);
  await handleRequest(new Request("https://example.com/privacy"), env);
  await handleRequest(new Request("https://example.com/privacy/"), env);

  assert.deepEqual(requestedPaths, [
    "/react/portal.html",
    "/react/speakloop.html",
    "/react/zoovoice.html",
    "/react/privacy.html",
    "/react/privacy.html",
  ]);
});

test("Cloudflare worker hides Zoovoice pages while the feature is disabled", async () => {
  const requestedPaths = [];
  const env = fakeEnv(async () => {
    throw new Error("disabled Zoovoice page must not call an external service");
  });
  env.ZOOVOICE_ENABLED = "0";
  env.ASSETS = {
    async fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      return new Response("unexpected asset", { status: 200 });
    },
  };

  for (const path of ["/zoovoice", "/zoovoice/", "/react/zoovoice.html"]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(requestedPaths, []);
});

test("Cloudflare worker exposes only public Zoovoice gateway configuration", async () => {
  const env = await zoovoiceEnv(async () => {
    throw new Error("config must not call an external service");
  });
  useOfficialLocalTurnstileCredentials(env);

  const response = await handleRequest(new Request("https://example.com/api/zoovoice/config"), env);

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    enabled: true,
    turnstile_required: true,
    turnstile_site_key: "1x00000000000000000000AA",
    audio_max_bytes: 10_000_000,
    origin_timeout_seconds: 90,
  });
  assert.doesNotMatch(body, /secret|private_key/i);
});

test("Cloudflare worker reports Zoovoice disabled when the flag is absent", async () => {
  const env = await zoovoiceEnv(async () => {
    throw new Error("config must not call an external service");
  });
  delete env.ZOOVOICE_ENABLED;
  useOfficialLocalTurnstileCredentials(env);

  const response = await handleRequest(new Request("https://example.com/api/zoovoice/config"), env);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, false);
});

test("Cloudflare worker does not call Zoovoice services while the feature is disabled", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    throw new Error("disabled feature must not call an external service");
  });
  env.ZOOVOICE_ENABLED = "0";

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "zoovoice_disabled");
  assert.deepEqual(calls, []);
});

test("Cloudflare worker rejects oversized Zoovoice audio before external calls", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    throw new Error("oversized input must not call an external service");
  });

  const response = await handleRequest(
    zoovoiceComposeRequest({ audio: new Uint8Array(10_000_001) }),
    env,
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "zoovoice_audio_too_large");
  assert.deepEqual(calls, []);
});

test("Cloudflare worker stops an oversized Zoovoice upload that declares no Content-Length", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    throw new Error("oversized input must not call an external service");
  });

  // Content-Lengthを付けずに上限超えを流し込む。本文を読み切る前に打ち切る必要がある。
  const megabyte = new Uint8Array(1_000_000);
  let emitted = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (emitted >= 12) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(megabyte);
    },
  });
  const request = new Request("http://127.0.0.1:8787/api/zoovoice/compose", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=zoovoice-test" },
    body,
    duplex: "half",
  });

  const response = await handleRequest(request, env);

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "zoovoice_audio_too_large");
  assert.ok(emitted < 12, `body must be abandoned before it is fully read (read ${emitted}MB)`);
  assert.deepEqual(calls, []);
});

test("Cloudflare worker passes valid Zoovoice sound credits through and rejects malformed ones", async () => {
  const withCredits = async (credits) => {
    const origin = validZoovoiceOriginResponse();
    if (credits === undefined) delete origin.meta.sound_credits;
    else origin.meta.sound_credits = credits;
    const env = await zoovoiceEnv(async (url) => {
      if (String(url).includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      return json(origin);
    }, { db: fakeZoovoiceBudgetD1() });
    env.ZOOVOICE_LOCAL_DEV = "1";
    env.ZOOVOICE_ORIGIN_MODE = "local-origin";
    env.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
    return await handleRequest(zoovoiceComposeRequest(), env);
  };

  const valid = await withCredits([{ license: "CC BY 4.0", creator: "dobroide", source_url: "https://freesound.org/people/dobroide/sounds/17353" }]);
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).meta.sound_credits, [
    { license: "CC BY 4.0", creator: "dobroide", source_url: "https://freesound.org/people/dobroide/sounds/17353" },
  ]);

  // 項目が無い応答は旧いorigin imageとして通す。形が壊れているものは通さない。
  assert.equal((await withCredits(undefined)).status, 200);
  for (const malformed of [
    "CC0 1.0",
    [{ creator: "someone" }],
    [{ license: "CC BY 4.0", source_url: "javascript:alert(1)" }],
    [{ license: "CC BY 4.0", source_url: "http://example.com/x" }],
  ]) {
    const response = await withCredits(malformed);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "zoovoice_invalid_origin_response");
  }
});

test("Cloudflare worker rejects invalid Zoovoice Turnstile action before quota and origin", async () => {
  const calls = [];
  const db = fakeZoovoiceBudgetD1();
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    return json({ success: true, action: "different-action", hostname: "example.com" });
  }, { db });

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "zoovoice_turnstile_failed");
  assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  assert.equal(db.__row, null);
});

test("Cloudflare worker fails closed when the Zoovoice D1 budget is unavailable", async () => {
  const calls = [];
  const db = fakeZoovoiceBudgetD1({ error: new Error("D1 unavailable") });
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    if (String(url).includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    throw new Error("origin must not be called when D1 is unavailable");
  }, { db });

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "zoovoice_budget_unavailable");
  assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
});

test("Cloudflare worker blocks Zoovoice at the daily budget before the origin call", async () => {
  const calls = [];
  const db = fakeZoovoiceBudgetD1({
    row: {
      feature: "zoovoice",
      usage_date: new Date().toISOString().slice(0, 10),
      daily_count: 100,
      usage_month: new Date().toISOString().slice(0, 7),
      monthly_count: 100,
    },
  });
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    if (String(url).includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    throw new Error("origin must not be called after quota rejection");
  }, { db });

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "zoovoice_quota_exceeded");
  assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  assert.equal(db.__row.daily_count, 100);
});

test("Cloudflare worker blocks Zoovoice at the monthly budget before the origin call", async () => {
  const calls = [];
  const db = fakeZoovoiceBudgetD1({
    row: {
      feature: "zoovoice",
      usage_date: "2026-08-01",
      daily_count: 1,
      usage_month: new Date().toISOString().slice(0, 7),
      monthly_count: 1_200,
    },
  });
  const env = await zoovoiceEnv(async (url) => {
    calls.push(String(url));
    if (String(url).includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    throw new Error("origin must not be called after monthly quota rejection");
  }, { db });

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "zoovoice_quota_exceeded");
  assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  assert.equal(db.__row.monthly_count, 1_200);
});

test("Cloudflare worker allows an unauthenticated Zoovoice origin only for local Wrangler and a loopback HTTP origin", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("siteverify")) {
      return json({ success: true });
    }
    assert.equal(target, "http://127.0.0.1:8090/compose");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return json(validZoovoiceOriginResponse());
  });
  env.ZOOVOICE_LOCAL_DEV = "1";
  env.ZOOVOICE_ORIGIN_MODE = "local-origin";
  env.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
  useOfficialLocalTurnstileCredentials(env);

  const response = await handleRequest(zoovoiceComposeRequest({
    url: "http://127.0.0.1:8787/api/zoovoice/compose",
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    "http://127.0.0.1:8090/compose",
  ]);
});

test("Cloudflare worker accepts incomplete Turnstile metadata only for the official local test credentials", async () => {
  const localEnv = await zoovoiceEnv(async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) return json({ success: true });
    if (target === "http://127.0.0.1:8090/compose") {
      return json(validZoovoiceOriginResponse());
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  localEnv.ZOOVOICE_LOCAL_DEV = "1";
  localEnv.ZOOVOICE_ORIGIN_MODE = "local-origin";
  localEnv.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
  useOfficialLocalTurnstileCredentials(localEnv);

  const localResponse = await handleRequest(zoovoiceComposeRequest({
    url: "http://localhost:8787/api/zoovoice/compose",
  }), localEnv);
  assert.equal(localResponse.status, 200);

  const nonLocalEnv = await zoovoiceEnv(async (url) => {
    if (String(url).includes("siteverify")) return json({ success: true });
    throw new Error("origin must not be called");
  });
  nonLocalEnv.ZOOVOICE_LOCAL_DEV = "1";
  nonLocalEnv.ZOOVOICE_ORIGIN_MODE = "local-origin";
  nonLocalEnv.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
  useOfficialLocalTurnstileCredentials(nonLocalEnv);

  const nonLocalResponse = await handleRequest(zoovoiceComposeRequest({
    url: "https://example.com/api/zoovoice/compose",
  }), nonLocalEnv);
  assert.equal(nonLocalResponse.status, 403);
  assert.equal((await nonLocalResponse.json()).error.code, "zoovoice_turnstile_failed");
});

test("Cloudflare worker uses a supplied short-lived ID token only for local Cloud Run smoke", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("siteverify")) return json({ success: true });
    if (target === "https://zoovoice.example.run.app/compose") {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer impersonated-id-token");
      const form = await new Response(init.body).formData();
      assert.equal(form.get("turnstile_token"), null);
      assert.equal(form.get("settings"), JSON.stringify({
        intensity: 40,
      }));
      assert.equal((await form.get("audio").arrayBuffer()).byteLength, 3);
      return json(validZoovoiceOriginResponse());
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  env.ZOOVOICE_LOCAL_DEV = "1";
  env.ZOOVOICE_ORIGIN_MODE = "cloud-run-smoke";
  env.ZOOVOICE_GCP_ID_TOKEN = "impersonated-id-token";
  useOfficialLocalTurnstileCredentials(env);

  const response = await handleRequest(zoovoiceComposeRequest({
    url: "http://127.0.0.1:8787/api/zoovoice/compose",
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    "https://zoovoice.example.run.app/compose",
  ]);
});

test("Cloudflare worker exchanges a signed JWT and authenticates a production Cloud Run request", async () => {
  clearZoovoiceIdTokenCacheForTests();
  const nowSeconds = 1_786_000_000;
  const serviceAccount = await testServiceAccountKey();
  const idToken = testIdToken({ exp: nowSeconds + 3_600 });
  const calls = [];
  const env = await productionZoovoiceEnv(async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    if (target === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("Content-Type"), "application/x-www-form-urlencoded");
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = body.get("assertion");
      assert.equal(assertion.split(".").length, 3);
      const [encodedHeader, encodedPayload, encodedSignature] = assertion.split(".");
      assert.equal(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        serviceAccount.__publicKey,
        decodeBase64UrlBytes(encodedSignature),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      ), true);
      const claims = decodeJwtPart(encodedPayload);
      assert.deepEqual(claims, {
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: "https://oauth2.googleapis.com/token",
        target_audience: "https://zoovoice.example.run.app",
        iat: nowSeconds - 60,
        exp: nowSeconds + 3_540,
      });
      return json({ id_token: idToken });
    }
    if (target === "https://zoovoice.example.run.app/compose") {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${idToken}`);
      return json(validZoovoiceOriginResponse());
    }
    throw new Error(`unexpected fetch: ${target}`);
  }, { nowSeconds, serviceAccount });

  const response = await handleRequest(zoovoiceComposeRequest({
    url: "https://example.com/api/zoovoice/compose",
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    "https://oauth2.googleapis.com/token",
    "https://zoovoice.example.run.app/compose",
  ]);
});

test("Cloudflare worker caches an ID token until its 300 second refresh window", async () => {
  clearZoovoiceIdTokenCacheForTests();
  let nowSeconds = 1_786_000_000;
  const serviceAccount = await testServiceAccountKey();
  let tokenExchangeCount = 0;
  const env = await productionZoovoiceEnv(async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    if (target === "https://oauth2.googleapis.com/token") {
      tokenExchangeCount += 1;
      return json({ id_token: testIdToken({ exp: nowSeconds + 3_600, nonce: tokenExchangeCount }) });
    }
    if (target === "https://zoovoice.example.run.app/compose") return json(validZoovoiceOriginResponse());
    throw new Error(`unexpected fetch: ${target}`);
  }, { nowSeconds, serviceAccount });
  env.__ZOOVOICE_NOW = () => nowSeconds * 1_000;

  for (let index = 0; index < 2; index += 1) {
    const response = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);
    assert.equal(response.status, 200);
  }
  assert.equal(tokenExchangeCount, 1);

  nowSeconds += 3_300;
  const refreshed = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);
  assert.equal(refreshed.status, 200);
  assert.equal(tokenExchangeCount, 2);
});

test("Cloudflare worker retries a failed production token exchange without caching it", async () => {
  clearZoovoiceIdTokenCacheForTests();
  const nowSeconds = 1_786_000_000;
  const serviceAccount = await testServiceAccountKey();
  let tokenExchangeCount = 0;
  const env = await productionZoovoiceEnv(async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    if (target === "https://oauth2.googleapis.com/token") {
      tokenExchangeCount += 1;
      if (tokenExchangeCount === 1) return json({ error: "temporarily_unavailable" }, { status: 503 });
      return json({ id_token: testIdToken({ exp: nowSeconds + 3_600 }) });
    }
    if (target === "https://zoovoice.example.run.app/compose") return json(validZoovoiceOriginResponse());
    throw new Error(`unexpected fetch: ${target}`);
  }, { nowSeconds, serviceAccount });

  const first = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);
  const second = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);

  assert.equal(first.status, 502);
  assert.equal((await first.json()).error.code, "zoovoice_origin_auth_failed");
  assert.equal(second.status, 200);
  assert.equal(tokenExchangeCount, 2);
});

test("Cloudflare worker fails closed for invalid production origin authentication inputs", async () => {
  const validServiceAccount = await testServiceAccountKey();
  const cases = [
    { name: "local dev flag", mutate: (env) => { env.ZOOVOICE_LOCAL_DEV = "1"; } },
    { name: "loopback request", requestUrl: "http://127.0.0.1:8787/api/zoovoice/compose" },
    { name: "non Cloud Run origin", mutate: (env) => { env.ZOOVOICE_CLOUD_RUN_URL = "https://example.com"; } },
    { name: "origin path", mutate: (env) => { env.ZOOVOICE_CLOUD_RUN_URL = "https://zoovoice.example.run.app/path"; } },
    { name: "missing secret", mutate: (env) => { delete env.ZOOVOICE_GCP_SA_KEY; } },
    { name: "invalid secret json", mutate: (env) => { env.ZOOVOICE_GCP_SA_KEY = "not-json"; } },
    { name: "invalid private key", mutate: (env) => { env.ZOOVOICE_GCP_SA_KEY = JSON.stringify({ client_email: "invoker@example.invalid", private_key: "not-a-key" }); } },
  ];

  for (const item of cases) {
    clearZoovoiceIdTokenCacheForTests();
    const calls = [];
    const env = await productionZoovoiceEnv(async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: new URL(item.requestUrl || "https://example.com").hostname });
      }
      throw new Error("authentication failure must not reach Cloud Run");
    }, { nowSeconds: 1_786_000_000, serviceAccount: validServiceAccount });
    if (item.requestUrl) env.ZOOVOICE_TURNSTILE_EXPECTED_HOSTNAME = new URL(item.requestUrl).hostname;
    item.mutate?.(env);

    const response = await handleRequest(zoovoiceComposeRequest({
      url: item.requestUrl || "https://example.com/api/zoovoice/compose",
    }), env);
    const body = await response.text();

    assert.equal(response.status, 502, item.name);
    assert.equal(JSON.parse(body).error.code, "zoovoice_origin_auth_failed", item.name);
    assert.doesNotMatch(body, /PRIVATE KEY|not-a-key|invoker@example\.invalid/, item.name);
    assert.equal(calls.some((target) => target.endsWith("/compose")), false, item.name);
  }
});

test("Cloudflare worker fails closed for invalid token endpoint and ID token responses", async () => {
  const serviceAccount = await testServiceAccountKey();
  const nowSeconds = 1_786_000_000;
  const cases = [
    { name: "fetch exception", tokenResult: () => { throw new Error("network failed with secret material"); } },
    { name: "non-2xx", tokenResult: () => json({ error: "invalid_grant" }, { status: 401 }) },
    { name: "non-json", tokenResult: () => new Response("not-json", { status: 200 }) },
    { name: "non-string token", tokenResult: () => json({ id_token: 123 }) },
    { name: "invalid token payload", tokenResult: () => json({ id_token: "not.a-valid-payload.signature" }) },
    { name: "missing exp", tokenResult: () => json({ id_token: testIdToken({}) }) },
  ];

  for (const item of cases) {
    clearZoovoiceIdTokenCacheForTests();
    let assertion = "";
    const env = await productionZoovoiceEnv(async (url, init = {}) => {
      const target = String(url);
      if (target.includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      if (target === "https://oauth2.googleapis.com/token") {
        assertion = new URLSearchParams(String(init.body)).get("assertion") || "";
        return item.tokenResult();
      }
      throw new Error("invalid token response must not reach Cloud Run");
    }, { nowSeconds, serviceAccount });

    const response = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);
    const body = await response.text();
    assert.equal(response.status, 502, item.name);
    assert.equal(JSON.parse(body).error.code, "zoovoice_origin_auth_failed", item.name);
    assert.equal(body.includes(assertion), false, item.name);
    assert.equal(body.includes(serviceAccount.private_key), false, item.name);
  }
});

test("Cloudflare worker never logs production service account or token material", async () => {
  clearZoovoiceIdTokenCacheForTests();
  const serviceAccount = await testServiceAccountKey();
  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.map(String).join(" "));
  try {
    const env = await productionZoovoiceEnv(async (url) => {
      if (String(url).includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      throw new Error(`upstream failure ${serviceAccount.private_key}`);
    }, { nowSeconds: 1_786_000_000, serviceAccount });
    env.ZOOVOICE_LOG_SAMPLE_RATE = "1";

    const response = await handleRequest(zoovoiceComposeRequest({ url: "https://example.com/api/zoovoice/compose" }), env);

    assert.equal(response.status, 502);
    const combined = `${await response.text()}\n${logs.join("\n")}`;
    assert.equal(combined.includes(serviceAccount.private_key), false);
    assert.doesNotMatch(combined, /eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9/);
  } finally {
    console.log = originalLog;
  }
});

test("Cloudflare worker rejects local Zoovoice modes on a production hostname before quota and origin", async () => {
  for (const mode of ["local-origin", "cloud-run-smoke", "", "unexpected"]) {
    const calls = [];
    const db = fakeZoovoiceBudgetD1();
    const env = await zoovoiceEnv(async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      throw new Error(`origin must not be called in mode ${mode}`);
    }, { db });
    env.ZOOVOICE_LOCAL_DEV = "1";
    env.ZOOVOICE_ORIGIN_MODE = mode;
    env.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
    env.ZOOVOICE_GCP_ID_TOKEN = "must-not-be-used";

    const response = await handleRequest(zoovoiceComposeRequest({
      url: "https://example.com/api/zoovoice/compose",
    }), env);

    assert.equal(response.status, 502, `mode ${mode || "unset"}`);
    assert.equal((await response.json()).error.code, "zoovoice_origin_auth_failed");
    assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
    assert.equal(db.__row, null);
  }
});

test("Cloudflare worker rejects unsafe local Zoovoice origins before quota and origin fetch", async () => {
  for (const origin of [
    "",
    "http://192.0.2.1:8090",
    "https://127.0.0.1:8090",
    "http://127.0.0.1:8090/path",
    "http://user:password@127.0.0.1:8090",
    "http://127.0.0.1:8090?mode=unsafe",
  ]) {
    const calls = [];
    const db = fakeZoovoiceBudgetD1();
    const env = await zoovoiceEnv(async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("siteverify")) return json({ success: true });
      throw new Error("origin must not be called");
    }, { db });
    env.ZOOVOICE_LOCAL_DEV = "1";
    env.ZOOVOICE_ORIGIN_MODE = "local-origin";
    env.ZOOVOICE_LOCAL_ORIGIN = origin;
    useOfficialLocalTurnstileCredentials(env);

    const response = await handleRequest(zoovoiceComposeRequest(), env);

    assert.equal(response.status, 502, origin || "empty origin");
    assert.equal((await response.json()).error.code, "zoovoice_origin_auth_failed");
    assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
    assert.equal(db.__row, null);
  }
});

test("Cloudflare worker never reaches Zoovoice origin when the local smoke token is missing", async () => {
  const calls = [];
  const db = fakeZoovoiceBudgetD1();
  const env = await zoovoiceEnv(async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    throw new Error("origin must not be called without a local smoke token");
  }, { db });
  delete env.ZOOVOICE_GCP_ID_TOKEN;

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "zoovoice_origin_auth_failed");
  assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  assert.equal(db.__row, null);
});

test("Cloudflare worker rejects invalid Cloud Run smoke origins before quota and origin fetch", async () => {
  for (const origin of [
    "",
    "http://zoovoice.example.run.app",
    "https://zoovoice.example.run.app/path",
    "https://user:password@zoovoice.example.run.app",
    "https://zoovoice.example.run.app?mode=unsafe",
  ]) {
    const calls = [];
    const db = fakeZoovoiceBudgetD1();
    const env = await zoovoiceEnv(async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      throw new Error("origin must not be called");
    }, { db });
    env.ZOOVOICE_CLOUD_RUN_URL = origin;

    const response = await handleRequest(zoovoiceComposeRequest(), env);

    assert.equal(response.status, 502, origin || "empty origin");
    assert.equal((await response.json()).error.code, "zoovoice_origin_auth_failed");
    assert.deepEqual(calls, ["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
    assert.equal(db.__row, null);
  }
});

test("Cloudflare worker aborts a slow Zoovoice origin within its internal timeout", async () => {
  const calls = [];
  const env = await zoovoiceEnv(async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    if (target === "https://zoovoice.example.run.app/compose") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  env.ZOOVOICE_ORIGIN_TIMEOUT_MS = "1";

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "zoovoice_origin_timeout");
  assert.deepEqual(calls, [
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    "https://zoovoice.example.run.app/compose",
  ]);
});

test("Cloudflare worker rejects malformed successful responses from Zoovoice origin", async () => {
  const env = await zoovoiceEnv(async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
    }
    if (target === "https://zoovoice.example.run.app/compose") {
      return json({ audio: { format: "mp3", base64: "" }, meta: null });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });

  const response = await handleRequest(zoovoiceComposeRequest(), env);

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "zoovoice_invalid_origin_response");
});

test("Cloudflare worker accepts Zoovoice metadata for a far-fetched association", async () => {
  const punPayload = validZoovoiceOriginResponse();
  punPayload.meta.selected_animal = { id: "elephant", label_ja: "象" };
  punPayload.meta.selected_animals = [
    { id: "elephant", label_ja: "象", reason: "「ぞうきん」の語呂合わせでゾウを連想" },
  ];
  punPayload.meta.association_reason = "「ぞうきん」の語呂合わせでゾウを連想";
  punPayload.meta.insertions = [{ slot: "ending", species: "elephant", at_seconds: 1, duration_seconds: 2.5 }];
  const env = await zoovoiceEnv(async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) return json({ success: true });
    if (target === "http://127.0.0.1:8090/compose") return json(punPayload);
    throw new Error(`unexpected fetch: ${target}`);
  });
  env.ZOOVOICE_LOCAL_DEV = "1";
  env.ZOOVOICE_ORIGIN_MODE = "local-origin";
  env.ZOOVOICE_LOCAL_ORIGIN = "http://127.0.0.1:8090";
  useOfficialLocalTurnstileCredentials(env);

  const response = await handleRequest(zoovoiceComposeRequest({
    url: "http://127.0.0.1:8787/api/zoovoice/compose",
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).meta, punPayload.meta);
});

test("Cloudflare worker accepts only intensity settings before Turnstile, budget, and origin", async () => {
  for (const settings of [
    {},
    { intensity: 40.5 },
    { intensity: -1 },
    { intensity: 101 },
    { intensity: 40, extra: true },
    { intensity: 40, arrangement: { opening: "cat", gaps: null, ending: null } },
  ]) {
    const calls = [];
    const db = fakeZoovoiceBudgetD1();
    const env = await zoovoiceEnv(async (url) => {
      calls.push(String(url));
      throw new Error("invalid settings must not call an external service");
    }, { db });
    const response = await handleRequest(zoovoiceComposeRequest({ settings }), env);
    assert.equal(response.status, 400, JSON.stringify(settings));
    assert.equal((await response.json()).error.code, "zoovoice_invalid_settings");
    assert.deepEqual(calls, []);
    assert.equal(db.__row, null);
  }
});

test("Cloudflare worker validates every Zoovoice success metadata field", async () => {
  const invalidPayloads = [
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, transcript: "" } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, transcript: "長".repeat(20_001) } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, selected_animal: { id: "", label_ja: "猫" } } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, association_reason: 3 } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, association_reason: "" } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, association_reason: "長".repeat(401) } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, insertions: [{ slot: "middle", species: "cat", at_seconds: 1, duration_seconds: 0.8 }] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, insertions: [{ slot: "word", species: "cat", at_seconds: 1 }] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, insertions: [{ slot: "word", species: "dog", at_seconds: 1, duration_seconds: 0.8 }] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, selected_animals: [] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, selected_animals: [{ id: "dog", label_ja: "犬", reason: "犬だから" }] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, selected_animals: [{ id: "cat", label_ja: "猫" }] } },
    { ...validZoovoiceOriginResponse(), meta: { ...validZoovoiceOriginResponse().meta, input_duration_seconds: "1" } },
  ];
  for (const payload of invalidPayloads) {
    const env = await zoovoiceEnv(async (url) => {
      if (String(url).includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      return json(payload);
    });
    const response = await handleRequest(zoovoiceComposeRequest(), env);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "zoovoice_invalid_origin_response");
  }
});

test("Cloudflare worker accepts the densest arrangement the origin can produce", async () => {
  // originは入力上限60秒・アニマル度100で文中30本＋末尾1本まで作る。
  // gatewayの上限がこれを下回ると、正当な応答がquota消費後に502になる。
  const insertionsOf = (count) =>
    Array.from({ length: count }, (_, index) => ({
      slot: index === count - 1 ? "ending" : "word",
      species: "cat",
      at_seconds: index * 2,
      duration_seconds: index === count - 1 ? 2.5 : 0.8,
    }));

  for (const [count, expectedStatus] of [[31, 200], [32, 502]]) {
    const base = validZoovoiceOriginResponse();
    const payload = {
      ...base,
      meta: { ...base.meta, insertions: insertionsOf(count), input_duration_seconds: 60, output_duration_seconds: 90 },
    };
    const env = await zoovoiceEnv(async (url) => {
      if (String(url).includes("siteverify")) {
        return json({ success: true, action: "zoovoice-compose", hostname: "example.com" });
      }
      return json(payload);
    });
    const response = await handleRequest(zoovoiceComposeRequest(), env);
    assert.equal(response.status, expectedStatus, `insertions=${count}`);
    if (expectedStatus === 502) {
      assert.equal((await response.json()).error.code, "zoovoice_invalid_origin_response");
    }
  }
});

test("Cloudflare worker serves Zoovoice animals from the running origin catalog", async () => {
  const requested = [];
  const env = await zoovoiceEnv(async (url) => {
    requested.push(String(url));
    return json({ animals: [{ id: "cat", label_ja: "猫", variants: 2 }] });
  });
  env.ASSETS = {
    async fetch() {
      throw new Error("animals must not be read from a build-time asset");
    },
  };

  const response = await handleRequest(new Request("http://127.0.0.1:8787/api/zoovoice/animals"), env);

  assert.deepEqual(requested, ["https://zoovoice.example.run.app/animals"]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    animals: [{ id: "cat", label_ja: "猫", variants: 2 }],
  });
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300");
});

test("Cloudflare worker rejects a malformed Zoovoice animals catalog", async () => {
  const env = await zoovoiceEnv(async () => json({ animals: [{ id: "cat" }] }));

  const response = await handleRequest(new Request("http://127.0.0.1:8787/api/zoovoice/animals"), env);

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "zoovoice_invalid_origin_response");
});

test("Cloudflare playback padding stops before neighboring speech", () => {
  const words = [
    { text: "前", start: 0, end: 0.45 },
    { text: "対象", start: 0.8, end: 1.2 },
    { text: "次", start: 1.25, end: 1.6 },
  ];
  const result = validatePracticeLlmResult({
    schema_version: 1,
    overall_score: 100,
    overall_comment: "ok",
    phrases: [{
      phrase_index: 0,
      target_text: "対象",
      score: 100,
      comment: "ok",
      reference: { status: "assigned", word_start_index: 1, word_end_index: 2 },
      attempt: { status: "assigned", word_start_index: 1, word_end_index: 2 },
    }],
  }, {
    target_text: "対象",
    padding_seconds: 0.3,
    reference_audio_duration: 2,
    attempt_audio_duration: 2,
    reference_asr: { words },
    attempt_asr: { words },
  });

  assert.equal(result.phrases[0].reference.playback_start, 0.5);
  assert.equal(result.phrases[0].reference.playback_end, 1.25);
});

test("Cloudflare worker deletes expired daily quota and audit data without resetting total quota", async () => {
  const db = fakeD1();
  db.__tables.daily.set("old", { usage_count: 1, updated_at: "2026-07-14T00:00:00.000Z" });
  db.__tables.daily.set("current", { usage_count: 1, updated_at: "2026-07-16T12:00:00.000Z" });
  db.__tables.total.set("total", { usage_count: 8, updated_at: "2026-01-01T00:00:00.000Z" });
  db.__tables.audit.push(
    { id: "old", occurred_at: "2026-04-01T00:00:00.000Z" },
    { id: "current", occurred_at: "2026-07-16T12:00:00.000Z" },
  );

  await runPublicDataRetention({ MO_SPEECH_DB: db }, new Date("2026-07-17T00:00:00.000Z"));

  assert.deepEqual([...db.__tables.daily.keys()], ["current"]);
  assert.deepEqual(db.__tables.audit.map((event) => event.id), ["current"]);
  assert.equal(db.__tables.total.get("total").usage_count, 8);
});

test("Cloudflare worker expires old KV audit fallback data without deleting total quota", async () => {
  const kv = fakeKv();
  await kv.put("public-audit-log", JSON.stringify([
    { id: "old", created_at: "2026-04-01T00:00:00.000Z", action: "old" },
    { id: "current", created_at: "2026-07-16T12:00:00.000Z", action: "current" },
  ]));
  await kv.put("public-usage:speakloop:hash:total", "8");

  await runPublicDataRetention({ MO_SPEECH_KV: kv }, new Date("2026-07-17T00:00:00.000Z"));

  const events = JSON.parse(await kv.get("public-audit-log"));
  assert.deepEqual(events.map((event) => event.id), ["current"]);
  assert.equal(await kv.get("public-usage:speakloop:hash:total"), "8");
});

test("Cloudflare worker returns 404 for retired application routes", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = { fetch: async () => new Response("unexpected asset", { status: 200 }) };

  for (const path of [
    "/fun",
    "/fun/",
    "/user",
    "/skitvoice",
    "/skitvoice/admin",
    "/vibevoice",
    "/vibevoice/simple",
    "/vibevoice/admin",
    "/seed-vc",
    "/user.html",
    "/vibevoice.html",
    "/vibevoice_simple.html",
    "/seed_vc.html",
    "/static/user.html",
    "/static/app_user.js",
    "/static/app_realtime.js",
    "/static/vibevoice_simple.html",
    "/static/seed_vc.html",
  ]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("Cloudflare worker serves the current public sample admin asset", async () => {
  const requestedPaths = [];
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = {
    async fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      return new Response("asset", { status: 200 });
    },
  };

  const response = await handleRequest(
    new Request("https://example.com/static/app_public_sample_audio_admin.js"),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requestedPaths, ["/app_public_sample_audio_admin.js"]);
});

test("Cloudflare worker returns 404 for retired legacy translation APIs", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });

  for (const [method, path] of [
    ["GET", "/api/user-settings"],
    ["PUT", "/api/user-settings"],
    ["POST", "/api/user-display-text"],
    ["POST", "/api/user-text-output"],
    ["POST", "/api/user-joke-output"],
    ["POST", "/api/translate-speech"],
    ["POST", "/api/translate-speech-jobs"],
    ["GET", "/api/translate-speech-jobs/retired"],
    ["POST", "/api/openai-realtime-translation-session"],
  ]) {
    const response = await handleRequest(new Request(`https://example.com${path}`, { method }), env);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("Cloudflare worker does not retain legacy practice UI aliases", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = { fetch: async (request) => new Response(new URL(request.url).pathname, { status: 404 }) };

  for (const path of ["/practice", "/practice/", "/practice/admin", "/practice/admin/", "/static/practice.html"]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), path === "/static/practice.html" ? "/practice.html" : path);
  }
});

test("Cloudflare worker protects directly addressed admin HTML assets", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = { fetch: async () => new Response("asset") };

  for (const path of ["/static/index.html", "/static/practice_admin.html"]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), `/auth/google/login?next=${encodeURIComponent(path)}`);
  }
});

test("Cloudflare worker protects admin pages with an allowlisted Google session", async () => {
  const requestedPaths = [];
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = {
    async fetch(request) {
      requestedPaths.push(new URL(request.url).pathname);
      return new Response("asset", { status: 200 });
    },
  };

  const blocked = await handleRequest(new Request("https://example.com/speakloop/admin"), env);
  const cookie = await adminCookie(env, "/speakloop/admin");
  const allowed = await handleRequest(new Request("https://example.com/speakloop/admin", { headers: { cookie } }), env);

  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/auth/google/login?next=%2Fspeakloop%2Fadmin");
  assert.match(cookie, /mo_public_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(allowed.status, 200);
  assert.deepEqual(requestedPaths, ["/practice_admin.html"]);
});

test("Cloudflare worker protects admin APIs with the same allowlisted Google session", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });
  const cookie = await adminCookie(env);

  const blockedSettings = await handleRequest(
    new Request("https://example.com/api/public-access-settings"),
    env,
  );
  const allowedSettings = await handleRequest(
    new Request("https://example.com/api/public-access-settings", { headers: { cookie } }),
    env,
  );
  const blockedHistory = await handleRequest(new Request("https://example.com/api/audio-history"), env);
  const allowedHistory = await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie } }), env);

  assert.equal(blockedSettings.status, 401);
  assert.deepEqual(await blockedSettings.json(), { detail: "admin authentication required" });
  assert.equal(allowedSettings.status, 200);
  assert.equal(blockedHistory.status, 401);
  assert.equal(allowedHistory.status, 200);
});

test("Cloudflare worker rejects a signed-in Google account that is not an admin", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const cookie = await publicCookie(env, "/admin");

  const page = await handleRequest(new Request("https://example.com/admin", { headers: { cookie } }), env);
  const api = await handleRequest(new Request("https://example.com/api/public-access-settings", { headers: { cookie } }), env);

  assert.equal(page.status, 403);
  assert.match(await page.text(), /管理画面へのアクセス権がありません/);
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { detail: "admin access is forbidden" });
});

test("Cloudflare worker no longer exposes password-admin auth routes or cookies", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = { fetch: async () => new Response("Not Found", { status: 404 }) };

  for (const path of ["/admin/login", "/admin/logout"]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /mo_admin_session/);
  }
});

test("Cloudflare worker signs in public users with Google OAuth", async () => {
  const kv = fakeKv();
  const env = publicAuthEnv(async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const body = String(init.body);
      assert.match(body, /code=oauth-code/);
      assert.match(body, /client_id=google-client-id/);
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      assert.equal(init.headers.Authorization, "Bearer google-access-token");
      return json({ email: "viewer@example.com", email_verified: true, name: "Viewer" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });

  const login = await handleRequest(new Request("https://example.com/auth/google/login?next=%2Fspeakloop"), env);
  const loginLocation = new URL(login.headers.get("location"));
  const state = loginLocation.searchParams.get("state");
  const stateCookie = login.headers.get("set-cookie");
  const callback = await handleRequest(
    new Request(`https://example.com/auth/google/callback?code=oauth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: stateCookie },
    }),
    env,
  );
  const sessionCookie = callback.headers.get("set-cookie");
  const session = await (
    await handleRequest(new Request("https://example.com/api/public-session", { headers: { cookie: sessionCookie } }), env)
  ).json();

  assert.equal(login.status, 302);
  assert.equal(loginLocation.origin, "https://accounts.google.com");
  assert.equal(loginLocation.pathname, "/o/oauth2/v2/auth");
  assert.equal(loginLocation.searchParams.get("client_id"), "google-client-id");
  assert.equal(loginLocation.searchParams.get("scope"), "openid email profile");
  assert.match(stateCookie, /mo_google_oauth_state=/);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/speakloop");
  assert.match(sessionCookie, /mo_public_session=/);
  const sessionPayload = publicSessionPayload(sessionCookie);
  assert.equal(sessionPayload.email, "viewer@example.com");
  assert.equal(sessionPayload.name, undefined);
  assert.equal(sessionPayload.picture, undefined);
  assert.equal(session.google_login_required, true);
  assert.equal(session.authenticated, true);
  assert.equal(session.email, "viewer@example.com");
  assert.equal(session.is_admin, false);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "google_login_success");
  assert.equal(audit[0].email, undefined);
  assert.equal(audit[0].email_hash, await publicIdentityHashForTest("viewer@example.com"));
  assert.equal(audit[0].path, "/auth/google/callback");
  assert.equal(audit[0].next, "/speakloop");
});

test("Cloudflare worker exchanges a valid Google ID token for a native session", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  const fixture = await googleIdTokenFixture();
  const env = publicAuthEnv(async (url) => {
    throw new Error(`native session exchange must not call an external service: ${url}`);
  }, { kv, db, adminGoogleEmails: "admin@example.com" });
  env.__googleJwks = fixture.jwks;
  const googleExpiresAt = Math.floor(Date.now() / 1000) + 1800;
  const idToken = await signGoogleIdToken({ exp: googleExpiresAt, email: "Viewer@Example.com" });

  const response = await handleRequest(nativeSessionRequest(idToken), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Object.keys(body).sort(), ["expires_at", "session_token", "token_type"]);
  assert.equal(body.token_type, "Bearer");
  assert.equal(typeof body.session_token, "string");
  assert.ok(body.session_token.length > 40);
  assert.ok(body.expires_at <= googleExpiresAt);
  assert.ok(body.expires_at <= Math.floor(Date.now() / 1000) + 3600);
  assert.equal(signedSessionPayload(body.session_token).email, "viewer@example.com");
  assert.equal(signedSessionPayload(body.session_token).exp, body.expires_at);

  const sessionResponse = await handleRequest(
    new Request("https://example.com/api/public-session", {
      headers: { Authorization: `Bearer ${body.session_token}` },
    }),
    env,
  );
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.email, "viewer@example.com");
  assert.equal(session.is_admin, false);

  const emailHash = await publicIdentityHashForTest("viewer@example.com");
  assert.equal(db.__tables.users.get(emailHash).email, "viewer@example.com");
  assert.match(db.__tables.users.get(emailHash).last_login_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(db.__tables.audit.length, 1);
  assert.equal(db.__tables.audit[0].action, "google_native_login_success");
  assert.equal(db.__tables.audit[0].actor_email_hash, emailHash);
  assert.equal(db.__tables.audit[0].path, "/api/native-session");
  const persisted = JSON.stringify({
    kv: [...kv.__store.entries()],
    db: {
      users: [...db.__tables.users.entries()],
      daily: [...db.__tables.daily.entries()],
      total: [...db.__tables.total.entries()],
      audit: db.__tables.audit,
    },
  });
  assert.doesNotMatch(persisted, new RegExp(escapeRegExp(idToken)));
  assert.doesNotMatch(persisted, new RegExp(escapeRegExp(body.session_token)));
});

test("Cloudflare worker rejects the native session invalid Google ID token matrix without credential disclosure", async () => {
  const fixture = await googleIdTokenFixture();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ["malformed", "not-a-jwt"],
    ["wrong algorithm", await signGoogleIdToken({}, { algorithm: "HS256" })],
    ["invalid signature", await signGoogleIdToken({}, { privateKey: fixture.otherPrivateKey })],
    ["unknown kid", await signGoogleIdToken({}, { kid: "unknown-google-key" })],
    ["wrong issuer", await signGoogleIdToken({ iss: "https://issuer.example.com" })],
    ["wrong audience", await signGoogleIdToken({ aud: "another-client-id" })],
    ["multiple audiences", await signGoogleIdToken({ aud: ["google-client-id", "another-client-id"] })],
    ["expired", await signGoogleIdToken({ exp: now - 1 })],
    ["future nbf", await signGoogleIdToken({ nbf: now + 300 })],
    ["missing expiration", await signGoogleIdToken({ exp: undefined })],
    ["missing subject", await signGoogleIdToken({ sub: undefined })],
    ["blank subject", await signGoogleIdToken({ sub: " " })],
    ["missing email", await signGoogleIdToken({ email: undefined })],
    ["blank email", await signGoogleIdToken({ email: " " })],
    ["unverified email", await signGoogleIdToken({ email_verified: false })],
    ["non-boolean verified email", await signGoogleIdToken({ email_verified: "true" })],
  ];
  const env = publicAuthEnv(async (url) => {
    throw new Error(`invalid token verification must not call runtime fetch: ${url}`);
  }, { kv: fakeKv() });
  env.__googleJwks = fixture.jwks;
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    for (const [label, idToken] of cases) {
      const response = await handleRequest(nativeSessionRequest(idToken), env);
      const responseBody = await response.text();
      assert.equal(response.status, 401, label);
      assert.deepEqual(JSON.parse(responseBody), { detail: "invalid Google ID token" }, label);
      assert.equal(response.headers.get("Cache-Control"), "no-store", label);
      assert.equal(responseBody.includes(idToken), false, label);
      assert.equal(logged.some((entry) => entry.includes(idToken)), false, label);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("Cloudflare worker accepts the legacy Google ID token issuer", async () => {
  const fixture = await googleIdTokenFixture();
  const env = publicAuthEnv(async (url) => {
    throw new Error(`legacy issuer verification must not call runtime fetch: ${url}`);
  }, { kv: fakeKv() });
  env.__googleJwks = fixture.jwks;

  const response = await handleRequest(
    nativeSessionRequest(await signGoogleIdToken({ iss: "accounts.google.com" })),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).token_type, "Bearer");
});

test("Cloudflare worker fails closed when Google JWKS verification is unavailable", async () => {
  const idToken = await signGoogleIdToken();
  const env = publicAuthEnv(async () => {
    throw new Error("native session exchange must not use runtime fetch injection");
  }, { kv: fakeKv() });
  env.__googleJwks = async () => {
    throw new Error("simulated JWKS outage");
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  let response;
  try {
    response = await handleRequest(nativeSessionRequest(idToken), env);
  } finally {
    console.error = originalConsoleError;
  }
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), { detail: "Google token verification is unavailable" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.includes(idToken), false);
  assert.equal(logged.some((entry) => entry.includes(idToken)), false);
});

test("Cloudflare worker rejects oversized native session credentials before verification", async () => {
  let verificationCalls = 0;
  const env = publicAuthEnv(async () => {
    throw new Error("oversized credentials must not call an external service");
  }, { kv: fakeKv() });
  env.__googleJwks = async () => {
    verificationCalls += 1;
    throw new Error("oversized credentials must not reach JWT verification");
  };
  const marker = "oversized-google-id-token-marker";
  const response = await handleRequest(nativeSessionRequest(marker.repeat(700)), env);
  const body = await response.text();

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(verificationCalls, 0);
  assert.equal(body.includes(marker), false);

  const tokenLimitResponse = await handleRequest(nativeSessionRequest("x".repeat(16 * 1024 + 1)), env);
  assert.equal(tokenLimitResponse.status, 413);
  assert.equal(tokenLimitResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(verificationCalls, 0);
});

test("Cloudflare worker gives Bearer sessions precedence while preserving cookie and CORS behavior", async () => {
  const fixture = await googleIdTokenFixture();
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    throw new Error(`unexpected external request: ${url}`);
  }, { kv: fakeKv() });
  env.__googleJwks = fixture.jwks;
  const exchange = await handleRequest(nativeSessionRequest(await signGoogleIdToken()), env);
  const { session_token: sessionToken } = await exchange.json();
  const cookie = await publicCookie(env);

  const bearerSession = await (
    await handleRequest(new Request("https://example.com/api/public-session", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    }), env)
  ).json();
  const cookieSession = await (
    await handleRequest(new Request("https://example.com/api/public-session", { headers: { cookie } }), env)
  ).json();
  const invalidBearerWithCookie = await (
    await handleRequest(new Request("https://example.com/api/public-session", {
      headers: { Authorization: "Bearer invalid-native-session", cookie },
    }), env)
  ).json();
  const malformedAuthorizationWithCookie = await (
    await handleRequest(new Request("https://example.com/api/public-session", {
      headers: { Authorization: "Basic ignored", cookie },
    }), env)
  ).json();
  const now = Math.floor(Date.now() / 1000);
  const expiredBearer = await signPublicSessionTokenForTest({
    email: "viewer@example.com",
    iat: now - 3601,
    exp: now - 1,
  });
  const expiredBearerSession = await (
    await handleRequest(new Request("https://example.com/api/public-session", {
      headers: { Authorization: `Bearer ${expiredBearer}` },
    }), env)
  ).json();
  const preflight = await handleRequest(new Request("https://example.com/api/native-session", { method: "OPTIONS" }), env);

  assert.equal(bearerSession.authenticated, true);
  assert.equal(bearerSession.email, "viewer@example.com");
  assert.equal(cookieSession.authenticated, true);
  assert.equal(cookieSession.email, "viewer@example.com");
  assert.equal(invalidBearerWithCookie.authenticated, false);
  assert.equal(malformedAuthorizationWithCookie.authenticated, false);
  assert.equal(expiredBearerSession.authenticated, false);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") || "", /(?:^|,\s*)Authorization(?:,|$)/i);
});

test("Cloudflare worker applies native Bearer identity to quota admin and polling boundaries", async () => {
  const fixture = await googleIdTokenFixture();
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    admin_google_emails: ["admin@example.com"],
    features: { speakloop: { daily_limit: 5, total_limit: 5, audio_max_bytes: 8000000, text_max_chars: 800 } },
  }));
  const env = publicAuthEnv(async (url) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") return json({ text: "今日は何をしますか" });
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: JSON.stringify({ source_language: "ja-JP", target_language: "en-US", translated_text: "What are you doing today?" }) });
    }
    if (url === "https://api.openai.com/v1/audio/speech") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url === "https://api.runpod.ai/v2/endpoint/status/native-poll-job") {
      return json({ id: "native-poll-job", status: "IN_PROGRESS", output: { stage: "voice_conversion" } });
    }
    throw new Error(`unexpected external request: ${url}`);
  }, { kv, db, adminGoogleEmails: "admin@example.com" });
  env.__googleJwks = fixture.jwks;
  const viewerExchange = await handleRequest(nativeSessionRequest(await signGoogleIdToken()), env);
  const viewerToken = (await viewerExchange.json()).session_token;

  const form = new FormData();
  form.append("audio", new Blob(["prompt"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "en-US");
  form.append("recording_intent", "prompt");
  const generated = await handleRequest(new Request("https://example.com/api/practice/recordings", {
    method: "POST",
    headers: { Authorization: `Bearer ${viewerToken}` },
    body: form,
  }), env);
  const polled = await handleRequest(new Request("https://example.com/api/practice/voice-jobs/native-poll-job", {
    headers: { Authorization: `Bearer ${viewerToken}` },
  }), env);

  assert.equal(generated.status, 200);
  assert.equal(polled.status, 200);
  const viewerHash = await publicIdentityHashForTest("viewer@example.com");
  assert.equal(db.__tables.total.get(`${viewerHash}:speakloop`).usage_count, 1);

  const adminExchange = await handleRequest(nativeSessionRequest(await signGoogleIdToken({
    sub: "google-admin-subject",
    email: "admin@example.com",
  })), env);
  const adminToken = (await adminExchange.json()).session_token;
  const adminResponse = await handleRequest(new Request("https://example.com/api/public-users", {
    headers: { Authorization: `Bearer ${adminToken}` },
  }), env);
  assert.equal(adminResponse.status, 200);
});

test("Cloudflare worker records a signed-in Google email with its login time", async () => {
  const db = fakeD1();
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "Viewer@Example.com", email_verified: true });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), db });

  await publicCookie(env, "/speakloop");

  const hash = await publicIdentityHashForTest("viewer@example.com");
  const stored = db.__tables.users.get(hash);
  assert.equal(stored.email, "viewer@example.com");
  assert.match(stored.last_login_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored.created_at, stored.last_seen_at);
});

test("Cloudflare worker records an admin Google email in the public user table", async () => {
  const db = fakeD1();
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv(), db });

  await adminCookie(env, "/admin");

  const hash = await publicIdentityHashForTest("admin@example.com");
  assert.equal(db.__tables.users.get(hash).email, "admin@example.com");
});

test("Cloudflare worker keeps the public user email fresh when quota is consumed", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    admin_google_emails: ["admin@example.com"],
    features: { speakloop: { daily_limit: 5, total_limit: 5, audio_max_bytes: 8000000, text_max_chars: 800 } },
  }));
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv, db, adminGoogleEmails: "admin@example.com" });

  const cookie = await publicCookie(env, "/speakloop");
  const hash = await publicIdentityHashForTest("viewer@example.com");
  db.__tables.users.get(hash).email = null;
  db.__tables.users.get(hash).last_seen_at = "2026-01-01T00:00:00.000Z";

  const form = new FormData();
  form.append("audio", new Blob(["attempt"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "ja-JP");
  form.append("recording_intent", "prompt");
  await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form, headers: { cookie } }),
    env,
  );

  const stored = db.__tables.users.get(hash);
  assert.equal(stored.email, "viewer@example.com");
  assert.notEqual(stored.last_seen_at, "2026-01-01T00:00:00.000Z");
  assert.equal(db.__tables.total.get(`${hash}:speakloop`).usage_count, 1);
});

test("Cloudflare worker protects the public user list with the admin boundary", async () => {
  const db = fakeD1();
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv(), db, googleEmail: "viewer@example.com" });

  const anonymous = await handleRequest(new Request("https://example.com/api/public-users"), env);
  const viewerCookie = await publicCookie(env, "/speakloop");
  const viewer = await handleRequest(
    new Request("https://example.com/api/public-users", { headers: { cookie: viewerCookie } }),
    env,
  );

  assert.equal(anonymous.status, 401);
  assert.equal(viewer.status, 403);
});

test("Cloudflare worker lists signed-in users with emails times and usage for an admin", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv, db });
  const viewerHash = await publicIdentityHashForTest("viewer@example.com");
  db.__tables.users.set(viewerHash, {
    email_hash: viewerHash,
    email: "viewer@example.com",
    created_at: "2026-07-01T00:00:00.000Z",
    last_seen_at: "2026-07-02T00:00:00.000Z",
    last_login_at: "2026-07-02T00:00:00.000Z",
  });
  db.__tables.total.set(`${viewerHash}:speakloop`, { usage_count: 4 });

  const cookie = await adminCookie(env, "/admin");
  const response = await handleRequest(
    new Request("https://example.com/api/public-users", { headers: { cookie } }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.users.length, 2);
  assert.equal(payload.users[0].email, "admin@example.com");
  assert.equal(payload.users[0].is_admin, true);
  assert.equal(payload.users[0].last_seen_at, "");
  assert.equal(payload.users[1].email, "viewer@example.com");
  assert.equal(payload.users[1].is_admin, false);
  assert.equal(payload.users[1].last_seen_at, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(payload.users[1].usage, { speakloop: 4 });
  assert.equal(payload.stored, 2);
});

test("Cloudflare worker limits quota reads to users selected for the response", async () => {
  const db = fakeD1();
  db.__rejectUnboundedQuotaScan = true;
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv(), db });

  const cookie = await adminCookie(env, "/admin");
  const response = await handleRequest(
    new Request("https://example.com/api/public-users?limit=1", { headers: { cookie } }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).users.length, 1);
});

test("Cloudflare worker returns an empty public user list without a D1 binding", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });

  const cookie = await adminCookie(env, "/admin");
  const response = await handleRequest(
    new Request("https://example.com/api/public-users", { headers: { cookie } }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: [], limit: 200, stored: 0 });
});

test("Cloudflare worker returns a full audit log page when no limit is requested", async () => {
  const db = fakeD1();
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv(), db });
  for (const index of [1, 2, 3]) {
    db.__tables.audit.push({
      id: `event-${index}`,
      occurred_at: `2026-07-0${index}T00:00:00.000Z`,
      actor_email_hash: "a".repeat(64),
      action: "google_login_success",
      feature: null,
      path: "/auth/google/callback",
      detail_json: "{}",
    });
  }

  const cookie = await adminCookie(env, "/admin");
  const response = await handleRequest(
    new Request("https://example.com/api/public-audit-log", { headers: { cookie } }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.limit, 100);
  assert.equal(payload.events.length, 4);
});

test("Cloudflare worker always protects admin voice conversion jobs with Google auth", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url) => {
    calls.push(url);
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const viewerCookie = await publicCookie(env, "/admin");
  const request = (cookie = "") => {
    const form = new FormData();
    form.append("source_audio", new Blob(["source"], { type: "audio/wav" }), "source.wav");
    form.append("reference_audio", new Blob(["reference"], { type: "audio/wav" }), "reference.wav");
    return new Request("https://example.com/api/voice-conversion-jobs", {
      method: "POST",
      headers: cookie ? { cookie } : undefined,
      body: form,
    });
  };

  const unauthenticated = await handleRequest(request(), env);
  const forbidden = await handleRequest(request(viewerCookie), env);

  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { detail: "Google admin login is required" });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { detail: "admin access is forbidden" });
  assert.equal(calls.some((url) => url.endsWith("/run")), false);
});

test("Cloudflare worker protects voice conversion job status with Google admin auth", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url) => {
    calls.push(url);
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const viewerCookie = await publicCookie(env, "/admin");

  const path = "/api/voice-conversion-jobs/job-vc";
  const unauthenticated = await handleRequest(new Request(`https://example.com${path}`), env);
  const forbidden = await handleRequest(
    new Request(`https://example.com${path}`, { headers: { cookie: viewerCookie } }),
    env,
  );

  assert.equal(unauthenticated.status, 401, path);
  assert.deepEqual(await unauthenticated.json(), { detail: "admin authentication required" }, path);
  assert.equal(forbidden.status, 403, path);
  assert.deepEqual(await forbidden.json(), { detail: "admin access is forbidden" }, path);

  assert.deepEqual(calls, []);
});

test("Cloudflare worker lets a Google admin edit public access limits", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });
  const cookie = await adminCookie(env);

  const blocked = await handleRequest(new Request("https://example.com/api/public-access-settings"), env);
  const updated = await handleRequest(
    new Request("https://example.com/api/public-access-settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({
        google_login_required: true,
        admin_google_emails: ["owner@example.com"],
        features: {
          speakloop: { daily_limit: 9, total_limit: 90, audio_max_bytes: 1234, text_max_chars: 321 },
        },
      }),
    }),
    env,
  );
  const fetched = await (
    await handleRequest(new Request("https://example.com/api/public-access-settings", { headers: { cookie } }), env)
  ).json();
  const blockedAudit = await handleRequest(new Request("https://example.com/api/public-audit-log"), env);
  const auditResponse = await handleRequest(new Request("https://example.com/api/public-audit-log?limit=5", { headers: { cookie } }), env);
  const audit = await auditResponse.json();

  assert.equal(blocked.status, 401);
  assert.equal(updated.status, 200);
  assert.equal(blockedAudit.status, 401);
  assert.equal(auditResponse.status, 200);
  assert.equal(audit.events[0].action, "public_access_settings_updated");
  assert.equal(audit.events[0].path, "/api/public-access-settings");
  assert.equal(fetched.google_login_required, true);
  assert.deepEqual(fetched.admin_google_emails, ["owner@example.com", "admin@example.com"]);
  assert.equal(fetched.features.speakloop.daily_limit, 9);
  assert.equal(fetched.features.speakloop.total_limit, 90);
  assert.equal(fetched.features.speakloop.audio_max_bytes, 1234);
  assert.equal(fetched.features.speakloop.text_max_chars, 321);
  assert.equal("fun" in fetched.features, false);
});

test("Cloudflare worker lets admins publish sample audios for public pages", async () => {
  const kv = fakeKv();
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv });
  const samplePayload = {
    features: {
      speakloop: {
        title: "SpeakLoop demo",
        description: "発音練習の出力例",
        filename: "speakloop.mp3",
        audio_mime_type: "audio/mpeg",
        audio_base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      },
    },
  };
  const cookie = await adminCookie(env);

  const initial = await handleRequest(new Request("https://example.com/api/public-sample-audios"), env);
  const blocked = await handleRequest(
    new Request("https://example.com/api/public-sample-audios", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(samplePayload),
    }),
    env,
  );
  const saved = await handleRequest(
    new Request("https://example.com/api/public-sample-audios", {
      method: "PUT",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(samplePayload),
    }),
    env,
  );
  const fetched = await handleRequest(new Request("https://example.com/api/public-sample-audios"), env);
  const blockedDelete = await handleRequest(
    new Request("https://example.com/api/public-sample-audios/speakloop", {
      method: "DELETE",
    }),
    env,
  );
  const deleted = await handleRequest(
    new Request("https://example.com/api/public-sample-audios/speakloop", {
      method: "DELETE",
      headers: { cookie },
    }),
    env,
  );
  const fetchedAfterDelete = await handleRequest(new Request("https://example.com/api/public-sample-audios"), env);

  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).features.speakloop, null);
  assert.equal(blocked.status, 401);
  assert.equal(saved.status, 200);
  const payload = await fetched.json();
  assert.equal(payload.features.speakloop.title, "SpeakLoop demo");
  assert.equal(payload.features.speakloop.audio_mime_type, "audio/mpeg");
  assert.equal(payload.features.speakloop.size_bytes, 4);
  assert.equal(blockedDelete.status, 401);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).features.speakloop, null);
  assert.equal((await fetchedAfterDelete.json()).features.speakloop, null);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.equal(audit.at(-2).action, "public_sample_audios_updated");
  assert.equal(audit.at(-1).action, "public_sample_audio_deleted");
  assert.equal(audit.at(-1).feature, "speakloop");
});

test("Cloudflare worker stores Japanese Chinese and English speakloop samples in D1 and R2", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  const r2 = fakeR2();
  const env = adminAuthEnv(async () => { throw new Error("unexpected fetch"); }, { kv, db, r2 });
  const cookie = await adminCookie(env);
  const sample = (language) => ({ title: language, description: `${language} sample`, filename: `${language}.wav`, audio_mime_type: "audio/wav", audio_base64: Buffer.from(language).toString("base64") });
  const body = { features: { speakloop: { samples: { "ja-JP": sample("ja-JP"), "zh-CN": sample("zh-CN"), "en-US": sample("en-US") } } } };

  const saved = await handleRequest(new Request("https://example.com/api/public-sample-audios", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  const payload = await saved.json();

  assert.equal(saved.status, 200);
  assert.equal(payload.features.speakloop.samples["ja-JP"].title, "ja-JP");
  assert.equal(payload.features.speakloop.samples["zh-CN"].title, "zh-CN");
  assert.equal(payload.features.speakloop.samples["en-US"].title, "en-US");
  assert.equal(db.__tables.samples.size, 3);
  assert.equal(r2.__store.size, 3);
  assert.equal(await kv.get("public-sample-audios"), null);

  const deleted = await handleRequest(new Request("https://example.com/api/public-sample-audios/speakloop?language=zh-CN", { method: "DELETE", headers: { cookie } }), env);
  assert.equal((await deleted.json()).features.speakloop.samples["zh-CN"] ?? null, null);
  assert.equal(db.__tables.samples.size, 2);
  assert.equal(r2.__store.size, 2);
});

test("Cloudflare worker does not recurse while migrating an empty legacy sample document", async () => {
  const kv = fakeKv();
  await kv.put("public-sample-audios", JSON.stringify({ features: { speakloop: null, fun: null, voice_conversion: null } }));
  const env = fakeEnv(async () => { throw new Error("unexpected fetch"); }, { kv, db: fakeD1(), r2: fakeR2() });

  const response = await handleRequest(new Request("https://example.com/api/public-sample-audios"), env);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.features.speakloop, null);
  assert.equal("fun" in payload.features, false);
});

test("Cloudflare worker reports admin auth setup errors on protected routes", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });

  const page = await handleRequest(new Request("https://example.com/admin"), env);
  const api = await handleRequest(new Request("https://example.com/api/warmup", { method: "POST" }), env);

  assert.equal(page.status, 503);
  assert.match(await page.text(), /ADMIN_GOOGLE_EMAILS/);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { detail: "admin authentication is not configured" });
});

test("Cloudflare worker creates a pronunciation practice prompt", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "コーヒーがほしいです" });
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
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([10, 11, 12]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  delete env.OPENAI_TRANSLATION_MODEL;
  const form = new FormData();
  form.append("audio", new Blob(["native"], { type: "audio/webm" }), "native.webm");
  form.append("target_language", "zh-CN");
  form.append("include_pinyin", "true");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/prompts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();
  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();
  const practiceHistory = await (
    await handleRequest(new Request("https://example.com/api/practice-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(response.status, 200);
  assert.equal(payload.transcript, "コーヒーがほしいです");
  assert.equal(payload.target_language, "zh-CN");
  assert.equal(payload.target_text, "我想要咖啡。");
  assert.equal(payload.audio_base64, Buffer.from([10, 11, 12]).toString("base64"));
  assert.equal(payload.display_text.primary_text, "我想要咖啡。");
  assert.equal(payload.display_text.pinyin_text, "wǒ xiǎng yào kā fēi");
  assert.equal(payload.display_text.pinyin_status, "ready");
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[0].init.body.get("model"), "whisper-1");
  assert.equal(calls[0].init.body.get("response_format"), "verbose_json");
  assert.deepEqual(calls[0].init.body.getAll("timestamp_granularities[]"), ["word", "segment"]);
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[1].body.model, "gpt-5.6-terra");
  assert.equal(calls[2].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls.filter((call) => call.url === "https://api.openai.com/v1/responses").length, 1);
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 0);
  assert.equal(practiceHistory.settings.enabled, false);
  assert.equal(practiceHistory.recordings.length, 0);
  assert.equal(practiceHistory.outputs.length, 0);
});

test("Cloudflare worker maps OpenAI quota exhaustion to a provider-free category message", async () => {
  const env = fakeEnv(async (url) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }, { status: 429 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["native"], { type: "audio/webm" }), "native.webm");
  form.append("target_language", "zh-CN");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/prompts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.detail, "現在サーバー側のAI利用枠を超えているため処理できません。時間をおいてもう一度お試しください。");
  assert.ok(!/openai|billing|quota|残高/i.test(payload.detail));
});

test("Cloudflare worker logs upstream OpenAI failures as metadata without payload content", async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    logged.push(args.map((value) => String(value)).join(" "));
  };
  try {
    const env = fakeEnv(async (url) => {
      if (url === "https://api.openai.com/v1/audio/transcriptions") {
        return json({
          error: {
            message: "You exceeded your current quota, please check your plan and billing details.",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        }, { status: 429 });
      }
      throw new Error(`unexpected url: ${url}`);
    }, { kv: fakeKv() });
    const form = new FormData();
    form.append("audio", new Blob(["native"], { type: "audio/webm" }), "native.webm");
    form.append("target_language", "zh-CN");

    await handleRequest(
      new Request("https://example.com/api/practice/prompts", { method: "POST", body: form }),
      env,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(logged.some((line) => line.includes("insufficient_quota") && line.includes("429")));
  assert.ok(logged.some((line) => line.includes("/api/practice/prompts")));
  assert.ok(!logged.some((line) => line.includes("native")));
});

test("Cloudflare worker logs a failed practice attempt job with its job id", async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    logged.push(args.map((value) => String(value)).join(" "));
  };
  let payload;
  try {
    const env = fakeEnv(async (url) => {
      if (url === "https://api.runpod.ai/v2/endpoint/status/practice-job-stale") {
        return json({
          id: "practice-job-stale",
          status: "COMPLETED",
          output: {
            practice_asr_contract_version: 2,
            text: "你好",
            model: "funasr/paraformer-zh",
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    }, { kv: fakeKv() });
    const response = await handleRequest(
      new Request("https://example.com/api/practice/attempt-jobs/practice-job-stale"),
      env,
    );
    payload = await response.json();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(payload.status, "failed");
  assert.ok(logged.some((line) => line.includes("practice-job-stale") && line.includes("contract")));
});

test("Cloudflare worker rejects attempt intent for a practice recording", async () => {
  // /api/practice/recordings only creates prompts now; attempts go through
  // /api/practice/attempt-jobs (which needs the model audio for comparison).
  const env = adminAuthEnv(async (url) => {
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "zh-CN");
  form.append("current_target_text", "我想学习软体开发");
  form.append("recording_intent", "attempt");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
    env,
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).detail, "recording_intent must be prompt");
});

test("Cloudflare worker uses explicit prompt intent even when a target exists", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "明日は天気がいいですか" });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          source_language: "ja-JP",
          target_language: "zh-CN",
          translated_text: "我想學習軟體開發。",
        }),
      });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([13, 14, 15]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["prompt"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "zh-CN");
  form.append("current_target_text", "我想要咖啡。");
  form.append("include_pinyin", "true");
  form.append("recording_intent", "prompt");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();
  const adminCookieValue = await adminCookie(env);
  const practiceHistory = await (
    await handleRequest(new Request("https://example.com/api/practice-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(response.status, 200);
  assert.equal(payload.recording_kind, "prompt");
  assert.equal(payload.transcript, "明日は天気がいいですか");
  assert.equal(payload.target_text, "我想学习软体开发。");
  assert.equal(payload.audio_base64, Buffer.from([13, 14, 15]).toString("base64"));
  assert.equal("classification" in payload, false);
  assert.equal(calls[0].init.body.get("language"), null);
  assert.equal(calls.filter((call) => call.url === "https://api.openai.com/v1/audio/transcriptions").length, 1);
  assert.equal(practiceHistory.settings.enabled, false);
  assert.deepEqual(practiceHistory.outputs, []);
});

test("Cloudflare worker creates and polls a SpeakLoop Seed-VC model voice job without admin-only VC access", async () => {
  const calls = [];
  let statusPolls = 0;
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: typeof init?.body === "string" ? parseJsonBody(init.body) : null });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "今日は何をしますか" });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: JSON.stringify({ source_language: "ja-JP", target_language: "en-US", translated_text: "What are you doing today?" }) });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([21, 22, 23]), { status: 200 });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-vc-job", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-vc-job") {
      statusPolls += 1;
      if (statusPolls === 1) {
        return json({
          id: "practice-vc-job",
          status: "IN_PROGRESS",
          output: { stage: "loading_seed_vc_model", label: "Seed-VCモデルを読み込んでいます", model: "Seed-VC" },
        });
      }
      return json({
        id: "practice-vc-job",
        status: "COMPLETED",
        output: { audio_mime_type: "audio/wav", audio_base64: "UklGRg==" },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["my reference voice"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "en-US");
  form.append("recording_intent", "prompt");
  form.append("use_own_voice", "true");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();
  const runCall = calls.find((call) => call.url === "https://api.runpod.ai/v2/endpoint/run");

  assert.equal(response.status, 200);
  assert.equal(payload.voice_conversion_job.job_id, "practice-vc-job");
  assert.equal(payload.voice_conversion_job.status, "queued");
  assert.deepEqual(
    payload.voice_conversion_job.stages.map((stage) => stage.stage),
    ["gpu_wait", "initializing", "loading_seed_vc_model", "voice_conversion"],
  );
  assert.equal(runCall.body.input.operation_mode, "voice_conversion");
  assert.equal(runCall.body.input.source_audio_base64, Buffer.from([21, 22, 23]).toString("base64"));
  assert.equal(runCall.body.input.reference_audio_base64, Buffer.from("my reference voice").toString("base64"));
  assert.equal(runCall.body.input.seed_vc_reference_auto_select, true);
  assert.equal("policy" in runCall.body, false);

  const running = await handleRequest(
    new Request("https://example.com/api/practice/voice-jobs/practice-vc-job"),
    env,
  );
  const runningSnapshot = await running.json();
  assert.equal(running.status, 200);
  assert.equal(runningSnapshot.status, "running");
  assert.equal(runningSnapshot.current_stage.stage, "loading_seed_vc_model");
  assert.equal(runningSnapshot.current_stage.model, "Seed-VC");

  const completed = await handleRequest(
    new Request("https://example.com/api/practice/voice-jobs/practice-vc-job"),
    env,
  );
  const snapshot = await completed.json();
  assert.equal(completed.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.audio_base64, "UklGRg==");
});

test("Cloudflare worker rejects separate reference sources for SpeakLoop own voice", async () => {
  for (const [field, value] of [
    ["reference_audio", new Blob(["third-party-file"], { type: "audio/wav" })],
    ["reference_audio_base64", "dGhpcmQtcGFydHk="],
    ["reference_url", "https://example.com/voice.wav"],
    ["tab_audio", new Blob(["captured-tab"], { type: "audio/webm" })],
  ]) {
    const env = fakeEnv(async () => {
      throw new Error("external processing must not start");
    });
    const form = new FormData();
    form.append("audio", new Blob(["same-session recording"], { type: "audio/webm" }), "recording.webm");
    form.append("target_language", "en-US");
    form.append("recording_intent", "prompt");
    form.append("use_own_voice", "true");
    if (value instanceof Blob) {
      form.append(field, value, `${field}.wav`);
    } else {
      form.append(field, value);
    }

    const response = await handleRequest(
      new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
      env,
    );
    assert.equal(response.status, 400, field);
    assert.match(await response.text(), /same-session SpeakLoop recording/);
  }
});

test("Cloudflare worker rejects a practice recording without explicit intent", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("OpenAI should not be called");
  });
  const form = new FormData();
  form.append("audio", new Blob(["recording"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "zh-CN");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
    env,
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /recording_intent/);
});

test("Cloudflare worker requests whisper timestamps for pronunciation practice", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      if (filename === "model.wav") {
        return json({
          text: "I want a coffee.",
          words: [{ word: "I want a coffee", start: 0.05, end: 1.15 }],
          segments: [],
        });
      }
      return json({
        text: "I want coffee.",
        words: [
          { word: "I", start: 0.1, end: 0.2 },
          { word: "want", start: 0.2, end: 0.5 },
          { word: "coffee", start: 0.6, end: 1.1 },
        ],
        segments: [{ text: "I want coffee.", start: 0.1, end: 1.1 }],
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 90,
          overall_comment: "ok",
          phrases: [{
            phrase_index: 0,
            target_text: "I want a coffee.",
            score: 90,
            comment: "ok",
            reference: { status: "assigned", word_start_index: 0, word_end_index: 1 },
            attempt: { status: "assigned", word_start_index: 0, word_end_index: 3 },
          }],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "I want a coffee.");
  form.append("asr_model", "whisper-1");
  form.append("comparison_model", "gpt-5.4-nano");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  const attemptCall = calls.find((call) => call.init.body?.get?.("file")?.name === "repeat.webm");
  assert.equal(attemptCall.init.body.get("model"), "whisper-1");
  assert.equal(attemptCall.init.body.get("response_format"), "verbose_json");
  assert.deepEqual(attemptCall.init.body.getAll("timestamp_granularities[]"), ["word", "segment"]);
  assert.equal(payload.result.recognized_text, "I want coffee.");
  assert.equal(payload.result.asr_timestamps.available, true);
  assert.equal(payload.result.asr_timestamps.words[0].text, "I");
  assert.equal(payload.result.overall_score, 90);
  assert.equal(payload.result.comparison_alignment.complete, true);
  assert.equal(payload.result.comparison_alignment.phrases[0].audio_start, 0);
  assert.equal(payload.result.comparison_alignment.phrases[0].audio_end, 1.1);
  assert.equal(payload.result.model_comparison_alignment.phrases[0].audio_start, 0);
  assert.equal(payload.result.model_comparison_alignment.phrases[0].audio_end, 1.15);
  assert.equal(payload.result.providers.asr, "openai-asr-whisper-1");

  const cookie = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/practice-history", { headers: { cookie } }), env)
  ).json();
  assert.equal(history.settings.enabled, false);
  assert.deepEqual(history.recordings, []);
});

test("Cloudflare worker rejects a boundary-only practice target before ASR", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("ASR must not run for an invalid target");
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "...");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "practice_alignment_invalid_input",
      reason: "empty_target",
      stage: "input",
      retryable: false,
      message: "入力内容を確認して、もう一度お試しください。",
      diagnostic_flags: ["empty_target"],
    },
  });
});

test("Cloudflare worker rejects oversized practice targets before external ASR", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("external ASR must not run for an oversized target");
  }, { kv: fakeKv() });
  const cases = [
    {
      path: "/api/practice/attempt-jobs",
      language: "en-US",
      target: Array.from({ length: 17 }, (_, index) => `Phrase ${index}.`).join(" "),
    },
    {
      path: "/api/practice/attempt-jobs",
      language: "zh-CN",
      target: Array.from({ length: 17 }, (_, index) => `第${index}句。`).join(""),
    },
  ];

  for (const testCase of cases) {
    const form = new FormData();
    form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
    form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
    form.append("target_language", testCase.language);
    form.append("target_text", testCase.target);

    const response = await handleRequest(
      new Request(`https://example.com${testCase.path}`, { method: "POST", body: form }),
      env,
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: "practice_alignment_invalid_input",
        reason: "alignment_input_too_large",
        stage: "input",
        retryable: false,
        message: "入力内容を確認して、もう一度お試しください。",
        diagnostic_flags: ["alignment_input_too_large"],
      },
    });
  }
});

test("Cloudflare worker returns no_speech for a silent LLM comparison attempt without calling the LLM", async () => {
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      if (filename === "model.wav") {
        return json({
          text: "Please close the window.",
          words: [{ word: "Please close the window", start: 0.1, end: 1.2 }],
          segments: [],
        });
      }
      return json({ text: "", words: [], segments: [] });
    }
    if (url === "https://api.openai.com/v1/responses") {
      throw new Error("LLM must not be called for a silent attempt recording");
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["0.72 seconds of silence"], { type: "audio/wav" }), "silent.wav");
  form.append("model_audio", new Blob(["model audio"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "Please close the window.");
  form.append("comparison_model", "gpt-5.4-nano");
  form.append("playback_padding_seconds", "0.1");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const snapshot = await response.json();

  assert.equal(response.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.outcome, "no_speech");
  assert.equal(snapshot.result.message, "音声を検出できませんでした。もう一度録音してください。");
  assert.equal(snapshot.result.comparison_alignment, null);
  assert.equal(snapshot.result.model_comparison_alignment, null);
  assert.equal(snapshot.result.comparison_model, "gpt-5.4-nano");
});

test("Cloudflare worker creates practice pinyin without Latin or numeric tokens", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "外付けSSDを買いました" });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          source_language: "ja-JP",
          target_language: "zh-CN",
          translated_text: "我买了一个外接 SSD，容量有 1TB。",
        }),
      });
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

  assert.equal(response.status, 200);
  assert.equal(payload.display_text.pinyin_text, "wǒ mǎi le yí gè wài jiē róng liàng yǒu");
  assert.doesNotMatch(payload.display_text.pinyin_text, /SSD|1TB/);
  assert.equal(calls.filter((call) => call.url === "https://api.openai.com/v1/responses").length, 1);
});

test("Cloudflare worker exposes Chinese practice as an async dual-audio RunPod job", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: parseJsonBody(init.body) });
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-job-1", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 0, running: 0, initializing: 1 } });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-job-1") {
      return json({
        id: "practice-job-1",
        status: "COMPLETED",
        delayTime: 1200,
        executionTime: 450,
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好吗？你今天去哪里？",
          text: "你哈吗？你今天到那里？",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [
            { text: "你哈吗", start: 0.1, end: 0.8 },
            { text: "你今天", start: 1.0, end: 1.5 },
            { text: "到那里", start: 1.5, end: 2.3 },
          ],
          segments: [],
          model_transcription: {
            text: "你好吗？你今天去哪里？",
            model: "funasr/paraformer-zh",
            timestamp_granularities: ["word"],
            words: [
              { text: "你好吗", start: 0.1, end: 0.8 },
              { text: "你今天", start: 1.0, end: 1.5 },
              { text: "去哪里", start: 1.5, end: 2.4 },
            ],
            segments: [],
          },
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 80,
          overall_comment: "「哈」と「到」が異なります。",
          phrases: [
            {
              phrase_index: 0,
              target_text: "你好吗？",
              score: 70,
              comment: "「好」が「哈」と認識されています。",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 1 },
              attempt: { status: "partial", word_start_index: 0, word_end_index: 1 },
            },
            {
              phrase_index: 1,
              target_text: "你今天去哪里？",
              score: 85,
              comment: "「去」が「到」と認識されています。",
              reference: { status: "assigned", word_start_index: 1, word_end_index: 3 },
              attempt: { status: "partial", word_start_index: 1, word_end_index: 3 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好吗？你今天去哪里？");
  form.append("comparison_model", "gpt-5.6-terra");

  const submitted = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const queued = await submitted.json();

  assert.equal(submitted.status, 202);
  assert.equal(queued.status, "queued");
  assert.equal(queued.current_stage.stage, "initializing");
  assert.equal(queued.current_stage.model, "funasr/paraformer-zh");
  assert.equal(calls[0].url, "https://api.runpod.ai/v2/endpoint/run");
  assert.equal(calls[0].body.input.operation_mode, "practice_asr");
  assert.equal(calls[0].body.input.align_timestamps, true);
  assert.equal(calls[0].body.input.target_text, "你好吗？你今天去哪里？");
  assert.ok(calls[0].body.input.audio_base64);
  assert.ok(calls[0].body.input.model_audio_base64);

  const completed = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-job-1"),
    env,
  );
  const snapshot = await completed.json();

  assert.equal(completed.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.deepEqual(snapshot.metrics, { delay_time_ms: 1200, execution_time_ms: 450 });
  assert.equal(snapshot.result.recognized_text, "你哈吗？你今天到那里？");
  assert.equal(snapshot.result.comparison_alignment.complete, true);
  assert.equal(snapshot.result.model_comparison_alignment.complete, true);
  assert.equal(snapshot.result.comparison_alignment.phrases[1].audio_end, 2.3);
  assert.equal(snapshot.result.model_comparison_alignment.phrases[1].audio_end, 2.4);
});

test("Cloudflare worker reuses cached model ASR across Chinese attempt retries", async () => {
  const runCalls = [];
  const kv = fakeKv();
  const env = fakeEnv(async (url, init = {}) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      const body = parseJsonBody(init.body);
      runCalls.push(body.input);
      return json({ id: `practice-job-${runCalls.length}`, status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    // 1回目のjobだけがお手本音声を受け取りFunASR推論してmodel_transcriptionを返す。
    // 2回目は同じお手本音声なのでキャッシュを再利用し、RunPod側はmodel_transcriptionを
    // 返さない(=送信側もmodel_audio_base64を送っていない想定)。
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-job-1") {
      return json({
        id: "practice-job-1",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好。",
          text: "你好",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [{ text: "你好", start: 0.1, end: 0.8 }],
          segments: [],
          model_transcription: {
            text: "你好",
            model: "funasr/paraformer-zh",
            timestamp_granularities: ["word"],
            words: [{ text: "你好", start: 0.0, end: 0.7 }],
            segments: [],
          },
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-job-2") {
      return json({
        id: "practice-job-2",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好。",
          text: "你好",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [{ text: "你好", start: 0.1, end: 0.8 }],
          segments: [],
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 100,
          overall_comment: "正確です。",
          phrases: [
            {
              phrase_index: 0,
              target_text: "你好。",
              score: 100,
              comment: "正確です。",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 1 },
              attempt: { status: "assigned", word_start_index: 0, word_end_index: 1 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const form = new FormData();
    form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
    form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
    form.append("target_language", "zh-CN");
    form.append("target_text", "你好。");
    form.append("comparison_model", "gpt-5.6-terra");

    const submitted = await handleRequest(
      new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
      env,
    );
    assert.equal(submitted.status, 202);
    const jobId = (await submitted.json()).job_id;

    const completed = await handleRequest(
      new Request(`https://example.com/api/practice/attempt-jobs/${jobId}`),
      env,
    );
    const snapshot = await completed.json();
    assert.equal(snapshot.status, "succeeded", JSON.stringify(snapshot));
    assert.equal(snapshot.result.overall_score, 100);
  }

  assert.equal(runCalls.length, 2);
  assert.ok(runCalls.every((input) => input.align_timestamps === true));
  assert.ok(runCalls[0].model_audio_base64, "the first submission must include the model audio");
  assert.equal(runCalls[1].model_audio_base64, undefined, "the second submission must reuse the cached model ASR");
  assert.ok(
    [...kv.__store.keys()].some((key) => key.includes("runpod-funasr-fa-zh-v1:zh-CN:")),
    "the aligned timestamps must use a versioned cache identity",
  );
});

test("Cloudflare worker retries an empty Chinese model ASR instead of caching it", async () => {
  const runCalls = [];
  const env = fakeEnv(async (url, init = {}) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      const body = parseJsonBody(init.body);
      runCalls.push(body.input);
      return json({ id: `empty-reference-retry-${runCalls.length}`, status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    if (url.startsWith("https://api.runpod.ai/v2/endpoint/status/empty-reference-retry-")) {
      const jobIndex = Number(url.split("-").at(-1)) - 1;
      const output = {
        practice_asr_contract_version: 3,
        target_text: "你好。",
        text: "",
        model: "funasr/paraformer-zh",
        words: [],
        segments: [],
      };
      if (runCalls[jobIndex].model_audio_base64) {
        output.model_transcription = jobIndex === 0
          ? { text: "", model: "funasr/paraformer-zh", words: [], segments: [] }
          : {
            text: "你好",
            model: "funasr/paraformer-zh",
            words: [{ text: "你好", start: 0.0, end: 0.7 }],
            segments: [],
          };
      }
      return json({ id: `empty-reference-retry-${jobIndex + 1}`, status: "COMPLETED", output });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });

  const submitAttempt = async () => {
    const form = new FormData();
    form.append("audio", new Blob(["silent repeat"], { type: "audio/wav" }), "silent.wav");
    form.append("model_audio", new Blob(["model retry after empty"], { type: "audio/wav" }), "model.wav");
    form.append("target_language", "zh-CN");
    form.append("target_text", "你好。");
    form.append("comparison_model", "gpt-5.6-terra");
    const response = await handleRequest(
      new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
      env,
    );
    assert.equal(response.status, 202);
    return (await response.json()).job_id;
  };

  const firstJobId = await submitAttempt();
  const firstCompleted = await handleRequest(
    new Request(`https://example.com/api/practice/attempt-jobs/${firstJobId}`),
    env,
  );
  const firstSnapshot = await firstCompleted.json();
  const secondJobId = await submitAttempt();
  const secondCompleted = await handleRequest(
    new Request(`https://example.com/api/practice/attempt-jobs/${secondJobId}`),
    env,
  );
  const secondSnapshot = await secondCompleted.json();

  assert.equal(firstSnapshot.status, "failed");
  assert.equal(firstSnapshot.error.reason, "empty_reference_asr");
  assert.equal(secondSnapshot.status, "succeeded", JSON.stringify(secondSnapshot));
  assert.equal(secondSnapshot.result.outcome, "no_speech");
  assert.ok(runCalls[0].model_audio_base64);
  assert.ok(runCalls[1].model_audio_base64);
});

test("Cloudflare worker returns no_speech for a silent English attempt without calling the LLM", async () => {
  const llmCalls = [];
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      if (filename === "model.wav") {
        return json({
          text: "Please close the window.",
          duration: 1.2,
          words: [{ word: "Please close the window", start: 0.1, end: 1.2 }],
          segments: [],
        });
      }
      return json({ text: "", words: [], segments: [] });
    }
    if (url === "https://api.openai.com/v1/responses") {
      llmCalls.push(JSON.parse(init.body));
      throw new Error("LLM must not be called for a silent attempt recording");
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["0.72 seconds of silence"], { type: "audio/wav" }), "silent.wav");
  form.append("model_audio", new Blob(["model audio"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "Please close the window.");
  form.append("comparison_model", "gpt-5.4-nano");
  form.append("playback_padding_seconds", "0.1");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const snapshot = await response.json();

  assert.equal(response.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.outcome, "no_speech");
  assert.equal(snapshot.result.message, "音声を検出できませんでした。もう一度録音してください。");
  assert.equal(snapshot.result.comparison_alignment, null);
  assert.equal(snapshot.result.model_comparison_alignment, null);
  assert.equal(snapshot.result.comparison_model, "gpt-5.4-nano");
  assert.equal(llmCalls.length, 0);
});

test("Cloudflare worker reuses cached model ASR across English attempt retries", async () => {
  const transcriptionCallsByFilename = {};
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      transcriptionCallsByFilename[filename] = (transcriptionCallsByFilename[filename] || 0) + 1;
      if (filename === "model.wav") {
        return json({
          text: "Hello world",
          duration: 0.9,
          words: [
            { word: "Hello", start: 0.0, end: 0.4 },
            { word: "world", start: 0.4, end: 0.9 },
          ],
          segments: [],
        });
      }
      return json({
        text: "Hello word",
        duration: 1.0,
        words: [
          { word: "Hello", start: 0.1, end: 0.5 },
          { word: "word", start: 0.5, end: 1.0 },
        ],
        segments: [],
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 80,
          overall_comment: "ok",
          phrases: [{
            phrase_index: 0,
            target_text: "Hello world.",
            score: 80,
            comment: "ok",
            reference: { status: "assigned", word_start_index: 0, word_end_index: 2 },
            attempt: { status: "partial", word_start_index: 0, word_end_index: 2 },
          }],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });

  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
    const form = new FormData();
    form.append("audio", new Blob([`repeat attempt ${attemptNumber}`], { type: "audio/webm" }), "repeat.webm");
    form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
    form.append("target_language", "en-US");
    form.append("target_text", "Hello world.");
    form.append("comparison_model", "gpt-5.4-nano");
    const response = await handleRequest(
      new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
      env,
    );
    assert.equal(response.status, 200);
  }

  // The reference/model audio is byte-identical across both attempts, so it
  // must be transcribed only once. Each attempt recording is genuinely new
  // audio and must always be transcribed.
  assert.equal(transcriptionCallsByFilename["model.wav"], 1);
  assert.equal(transcriptionCallsByFilename["repeat.webm"], 2);
});

test("Cloudflare worker retries an empty English model ASR instead of caching it", async () => {
  const transcriptionCallsByFilename = {};
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      transcriptionCallsByFilename[filename] = (transcriptionCallsByFilename[filename] || 0) + 1;
      if (filename === "model.wav") {
        if (transcriptionCallsByFilename[filename] === 1) {
          return json({ text: "", words: [], segments: [] });
        }
        return json({
          text: "Hello world",
          words: [{ word: "Hello world", start: 0.0, end: 0.9 }],
          segments: [],
        });
      }
      return json({ text: "", words: [], segments: [] });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });

  const submitAttempt = async () => {
    const form = new FormData();
    form.append("audio", new Blob(["silent repeat"], { type: "audio/wav" }), "repeat.wav");
    form.append("model_audio", new Blob(["model retry after empty"], { type: "audio/wav" }), "model.wav");
    form.append("target_language", "en-US");
    form.append("target_text", "Hello world.");
    form.append("comparison_model", "gpt-5.4-nano");
    return handleRequest(
      new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
      env,
    );
  };

  const failed = await submitAttempt();
  const failedSnapshot = await failed.json();
  const retried = await submitAttempt();
  const retriedSnapshot = await retried.json();

  assert.equal(failed.status, 502);
  assert.equal(failedSnapshot.error.reason, "empty_reference_asr");
  assert.equal(retried.status, 200);
  assert.equal(retriedSnapshot.result.outcome, "no_speech");
  assert.equal(transcriptionCallsByFilename["model.wav"], 2);
});

test("Cloudflare worker scores an English practice attempt using the LLM comparison", async () => {
  const llmCalls = [];
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      if (filename === "model.wav") {
        return json({
          text: "Hello world",
          duration: 0.9,
          words: [
            { word: "Hello", start: 0.0, end: 0.4 },
            { word: "world", start: 0.4, end: 0.9 },
          ],
          segments: [],
        });
      }
      return json({
        text: "Hello word",
        duration: 1.0,
        words: [
          { word: "Hello", start: 0.1, end: 0.5 },
          { word: "word", start: 0.5, end: 1.0 },
        ],
        segments: [],
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(init.body);
      llmCalls.push(body);
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 80,
          overall_comment: "「world」の発音を確認しましょう。",
          phrases: [
            {
              phrase_index: 0,
              target_text: "Hello world.",
              score: 80,
              comment: "「word」として認識されています。",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 2 },
              attempt: { status: "partial", word_start_index: 0, word_end_index: 2 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "Hello world.");
  form.append("comparison_model", "gpt-5.4-nano");
  form.append("playback_padding_seconds", "0.1");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const snapshot = await response.json();

  assert.equal(response.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.outcome, "evaluated");
  assert.equal(snapshot.result.overall_score, 80);
  assert.equal(snapshot.result.overall_comment, "「world」の発音を確認しましょう。");
  assert.equal(snapshot.result.comparison_model, "gpt-5.4-nano");
  assert.equal(snapshot.result.llm_comparison.phrases[0].score, 80);
  assert.equal(snapshot.result.providers.comparison, "openai-responses");
  assert.ok(Math.abs(snapshot.result.comparison_alignment.phrases[0].audio_end - 1.0) < 1e-6);
  assert.ok(Math.abs(snapshot.result.model_comparison_alignment.phrases[0].audio_end - 0.9) < 1e-6);
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].model, "gpt-5.4-nano");
  assert.equal(llmCalls[0].text.format.strict, true);
});

test("Cloudflare worker surfaces an LLM validation failure as the generic comparison error for English attempts", async () => {
  const env = fakeEnv(async (url, init) => {
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      const filename = init.body.get("file")?.name || "";
      const words = filename === "model.wav"
        ? [{ word: "Hi", start: 0.0, end: 0.3 }]
        : [{ word: "Hi", start: 0.0, end: 0.3 }];
      return json({ text: "Hi", duration: 0.3, words, segments: [] });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 100,
          overall_comment: "ok",
          phrases: [
            {
              phrase_index: 0,
              target_text: "this does not match the target text",
              score: 100,
              comment: "ok",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 1 },
              attempt: { status: "assigned", word_start_index: 0, word_end_index: 1 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "Hi");
  form.append("comparison_model", "gpt-5.4-nano");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.error.code, "practice_llm_failed");
  assert.equal(payload.error.stage, "validate_response");
  assert.equal(payload.error.message, "比較結果を作成できませんでした。もう一度お試しください。");
  assert.equal(payload.error.fallback_to_legacy, false);
});

test("Cloudflare worker rejects non-timestamp ASR models for English LLM comparison attempts", async () => {
  const env = fakeEnv(async (url) => {
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "Hello world.");
  form.append("asr_model", "gpt-4o-transcribe");
  form.append("comparison_model", "gpt-5.4-nano");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.detail, /does not return word timestamps/);
});

test("Cloudflare worker scores a Chinese practice attempt using the LLM comparison after RunPod ASR completes", async () => {
  const llmCalls = [];
  const env = fakeEnv(async (url, init = {}) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-llm-job-1", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-llm-job-1") {
      return json({
        id: "practice-llm-job-1",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好。",
          text: "你好。",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [
            { text: "你", start: 0.1, end: 0.3 },
            { text: "好", start: 0.3, end: 0.6 },
          ],
          segments: [],
          model_transcription: {
            text: "你好。",
            model: "funasr/paraformer-zh",
            timestamp_granularities: ["word"],
            words: [
              { text: "你", start: 0.0, end: 0.25 },
              { text: "好", start: 0.25, end: 0.5 },
            ],
            segments: [],
          },
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(init.body);
      llmCalls.push(body);
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 95,
          overall_comment: "よくできました。",
          phrases: [
            {
              phrase_index: 0,
              target_text: "你好。",
              score: 95,
              comment: "正しく言えています。",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 2 },
              attempt: { status: "assigned", word_start_index: 0, word_end_index: 2 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好。");
  form.append("comparison_model", "gpt-5.6-luna");
  form.append("playback_padding_seconds", "0.05");

  const submitted = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  assert.equal(submitted.status, 202);

  const completed = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-llm-job-1"),
    env,
  );
  const snapshot = await completed.json();

  assert.equal(completed.status, 200);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.result.outcome, "evaluated");
  assert.equal(snapshot.result.overall_score, 95);
  assert.equal(snapshot.result.comparison_model, "gpt-5.6-luna");
  assert.equal(snapshot.result.playback_padding_seconds, 0.05);
  assert.equal(snapshot.result.providers.comparison, "openai-responses");
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].model, "gpt-5.6-luna");
  assert.equal(llmCalls[0].text.format.strict, true);

  const repolled = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-llm-job-1"),
    env,
  );
  const repolledSnapshot = await repolled.json();

  assert.equal(repolled.status, 200);
  assert.equal(repolledSnapshot.status, "succeeded");
  assert.equal(repolledSnapshot.result.overall_score, 95);
  assert.equal(
    llmCalls.length,
    1,
    "re-polling a completed RunPod job must reuse the cached comparison instead of calling OpenAI again",
  );
});

test("Cloudflare worker keeps practice attempt LLM options alive for the whole 30-minute attempt poll window", async () => {
  const putCalls = [];
  const kv = fakeKv();
  const recordingKv = {
    ...kv,
    async put(key, value, options) {
      putCalls.push({ key, options });
      return kv.put(key, value, options);
    },
  };
  const env = fakeEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-llm-ttl-job", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: recordingKv });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好。");
  form.append("comparison_model", "gpt-5.6-luna");

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }), env);

  const optionsPut = putCalls.find((call) => call.key.startsWith("practice-attempt-llm-options:"));
  assert.ok(optionsPut, "expected the worker to persist practice attempt LLM options to KV");
  // フロントエンドのattempt-jobsポーリング締め切り(30分 = 1800秒)より長くないと、
  // RunPodジョブが15分超で完了したときにcomparison_modelを見失う。
  assert.ok(
    optionsPut.options.expirationTtl > 30 * 60,
    `expected LLM options TTL to exceed the 30-minute poll window, got ${optionsPut.options.expirationTtl}`,
  );
});

test("Cloudflare worker preserves phrase context for polyphonic diff pinyin", async () => {
  const env = fakeEnv(async (url, init = {}) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-pinyin-job-1", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-pinyin-job-1") {
      return json({
        id: "practice-pinyin-job-1",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "银行。",
          text: "银形",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [
            { text: "银", start: 0.0, end: 0.3 },
            { text: "形", start: 0.3, end: 0.6 },
          ],
          segments: [],
          model_transcription: {
            text: "银行",
            model: "funasr/paraformer-zh",
            timestamp_granularities: ["word"],
            words: [
              { text: "银", start: 0.0, end: 0.3 },
              { text: "行", start: 0.3, end: 0.6 },
            ],
            segments: [],
          },
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 90,
          overall_comment: "二文字目の発音を確認しましょう。",
          phrases: [
            {
              phrase_index: 0,
              target_text: "银行。",
              score: 90,
              comment: "「行」が「形」と認識されています。",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 2 },
              attempt: { status: "assigned", word_start_index: 0, word_end_index: 2 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "银行。");
  form.append("comparison_model", "gpt-5.6-terra");
  form.append("playback_padding_seconds", "0.05");

  const submitted = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  assert.equal(submitted.status, 202);

  const completed = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-pinyin-job-1"),
    env,
  );
  const snapshot = await completed.json();

  assert.equal(snapshot.status, "succeeded");
  // 「银行」の「行」は周囲の語によってhang2になる。「银形」の「形」はxing2のため、
  // 1文字ずつ変換して両方をxing2にすると実際の違いを隠してしまう。
  assert.deepEqual(snapshot.result.comparison_target_pinyin, ["yin2", "hang2"]);
  assert.deepEqual(snapshot.result.comparison_recognized_pinyin, ["yin2", "xing2"]);
});

test("Cloudflare worker surfaces an LLM validation failure as a failed job snapshot for Chinese attempts", async () => {
  let comparisonCalls = 0;
  const env = fakeEnv(async (url, init = {}) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ id: "practice-llm-job-fail", status: "IN_QUEUE" });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/health") {
      return json({ workers: { idle: 1, running: 0, initializing: 0 } });
    }
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-llm-job-fail") {
      return json({
        id: "practice-llm-job-fail",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好。",
          text: "你好。",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [{ text: "你", start: 0.1, end: 0.3 }, { text: "好", start: 0.3, end: 0.6 }],
          segments: [],
          model_transcription: {
            text: "你好。",
            model: "funasr/paraformer-zh",
            timestamp_granularities: ["word"],
            words: [{ text: "你", start: 0.0, end: 0.25 }, { text: "好", start: 0.25, end: 0.5 }],
            segments: [],
          },
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      comparisonCalls += 1;
      // word_end_index is out of range for a 2-word ASR result: an invalid LLM response.
      return json({
        output_text: JSON.stringify({
          schema_version: 1,
          overall_score: 100,
          overall_comment: "ok",
          phrases: [
            {
              phrase_index: 0,
              target_text: "你好。",
              score: 100,
              comment: "ok",
              reference: { status: "assigned", word_start_index: 0, word_end_index: 99 },
              attempt: { status: "assigned", word_start_index: 0, word_end_index: 2 },
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好。");
  form.append("comparison_model", "gpt-5.6-terra");

  const submitted = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );
  assert.equal(submitted.status, 202);

  const completed = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-llm-job-fail"),
    env,
  );
  const snapshot = await completed.json();

  assert.equal(completed.status, 200);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.current_stage.label, "比較結果を作成できませんでした");
  assert.equal(snapshot.error.code, "practice_llm_failed");
  assert.equal(snapshot.error.stage, "validate_response");
  assert.equal(snapshot.error.message, "比較結果を作成できませんでした。もう一度お試しください。");
  assert.equal(snapshot.result, null);

  const repeated = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-llm-job-fail"),
    env,
  );
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), snapshot);
  assert.equal(comparisonCalls, 1);
});

test("Cloudflare worker explains when the RunPod practice image predates the dual-audio contract", async () => {
  const env = fakeEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/status/outdated-practice-job") {
      return json({
        id: "outdated-practice-job",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 2,
          target_text: "你好吗？",
          text: "你好吗？",
          model: "funasr/paraformer-zh",
        },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/outdated-practice-job"),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "failed");
  assert.equal(payload.current_stage.label, "RunPod imageの更新が必要です");
  assert.match(payload.error, /practice ASR contract v3/);
  assert.match(payload.error, /再デプロイ/);
});

test("Cloudflare worker reports an empty reference ASR as a typed failed job", async () => {
  const env = fakeEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/status/empty-reference") {
      return json({
        id: "empty-reference",
        status: "COMPLETED",
        output: {
          practice_asr_contract_version: 3,
          target_text: "你好吗？",
          text: "你好吗？",
          model: "funasr/paraformer-zh",
          words: [{ text: "你好吗", start: 0.1, end: 0.8 }],
          segments: [],
          model_transcription: {
            text: "",
            model: "funasr/paraformer-zh",
            words: [],
            segments: [],
          },
        },
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/empty-reference"),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, "failed");
  assert.equal(payload.result, null);
  assert.deepEqual(payload.error, {
    code: "practice_alignment_provider_contract_error",
    reason: "empty_reference_asr",
    stage: "reference_asr",
    retryable: true,
    message: "音声の解析結果を確認できませんでした。もう一度お試しください。",
    diagnostic_flags: ["empty_reference_asr"],
  });
});

test("Cloudflare worker surfaces RunPod practice progress without echoing provider failure text", async () => {
  let responseBody = {
    id: "practice-job-2",
    status: "IN_PROGRESS",
    output: {
      stage: "transcribing_attempt",
      label: "録音をFunASRで解析しています",
      model: "funasr/paraformer-zh",
    },
  };
  const env = fakeEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/status/practice-job-2") {
      return json(responseBody);
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const runningResponse = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-job-2"),
    env,
  );
  const running = await runningResponse.json();
  assert.equal(running.status, "running");
  assert.equal(running.current_stage.stage, "transcribing_attempt");
  assert.equal(running.current_stage.model, "funasr/paraformer-zh");

  responseBody = {
    id: "practice-job-2",
    status: "FAILED",
    error: "Insufficient balance to start a worker",
  };
  const failedResponse = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs/practice-job-2"),
    env,
  );
  const failed = await failedResponse.json();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "RunPod job failed with status FAILED");
  assert.doesNotMatch(failed.error, /Insufficient balance/);
});

test("Cloudflare worker does not silently fall back when Chinese FunASR fails", async () => {
  const calls = [];
  const env = fakeEnv(async (url) => {
    calls.push(url);
    if (url === "https://api.runpod.ai/v2/endpoint/run") {
      return json({ error: "FunASR unavailable" }, { status: 503 });
    }
    throw new Error(`unexpected fallback url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好。");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", body: form }),
    env,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["https://api.runpod.ai/v2/endpoint/run"]);
  const body = await response.text();
  assert.match(body, /RunPod request failed with HTTP 503/);
  assert.doesNotMatch(body, /FunASR unavailable/);
});

test("Cloudflare worker strips audio MIME parameters for voice conversion files", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return json({ id: "job-vc", status: "IN_QUEUE" });
  });
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["source"], { type: "audio/webm;codecs=opus" }), "source.webm");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/webm;codecs=opus" }), "reference.webm");

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", headers: { cookie: await adminCookie(env) }, body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.job_id, "job-vc");
  assert.equal(calls[0].body.input.operation_mode, "voice_conversion");
  assert.equal(calls[0].body.input.source_audio_mime_type, "audio/webm");
  assert.equal(calls[0].body.input.reference_audio_mime_type, "audio/webm");
  assert.equal("audio_effect_audio_base64" in calls[0].body.input, false);
});

test("Cloudflare worker does not save voice conversion source audio", async () => {
  const env = adminAuthEnv(
    async () => json({ id: "job-vc", status: "IN_QUEUE" }),
    { kv: fakeKv() },
  );
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["source"], { type: "audio/webm;codecs=opus" }), "source.webm");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/webm;codecs=opus" }), "reference.webm");
  const adminCookieValue = await adminCookie(env);

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", headers: { cookie: adminCookieValue }, body: form }),
    env,
  );
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(response.status, 200);
  assert.equal(history.settings.enabled, false);
  assert.deepEqual(history.recordings, []);
});

test("Cloudflare worker maps completed RunPod voice conversion status to local job snapshot", async () => {
  const env = adminAuthEnv(
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
    new Request("https://example.com/api/voice-conversion-jobs/job-vc", {
      headers: { cookie: await adminCookie(env) },
    }),
    env,
  );
  const payload = await response.json();
  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(payload.status, "succeeded");
  assert.equal(payload.current_stage.stage, "complete");
  assert.equal(payload.result.audio_base64, "AAAA");
  assert.deepEqual(history.outputs, []);
});

test("Cloudflare worker reports audio history as disabled", async () => {
  const env = adminAuthEnv(async () => json({ ok: true }), { kv: fakeKv() });
  const adminCookieValue = await adminCookie(env);

  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(history.settings.enabled, false);
  assert.equal(history.settings.limit, 0);

  for (const request of [
    new Request("https://example.com/api/audio-history/outputs", {
      method: "POST",
      headers: { cookie: adminCookieValue, "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64: "UklGRg==", audio_mime_type: "audio/wav" }),
    }),
    new Request("https://example.com/api/audio-history/outputs/old.wav", { headers: { cookie: adminCookieValue } }),
    new Request("https://example.com/api/audio-history/outputs/old.wav", { method: "DELETE", headers: { cookie: adminCookieValue } }),
  ]) {
    assert.equal((await handleRequest(request, env)).status, 404);
  }
});

test("Cloudflare worker reports RunPod runtime availability and warm health", async () => {
  const env = fakeEnv(async () => json({ workers: [{ state: "IDLE" }] }));

  const response = await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), env, {});
  const payload = await response.json();
  const seedVc = payload.voice_conversion_backends[0];

  assert.equal("translation_backends" in payload, false);
  assert.equal(payload.providers.asr, "openai-asr-gpt-4o-transcribe");
  assert.equal(payload.providers.translation, "openai-translation-gpt-5.6-terra");
  assert.deepEqual(payload.supported_voice_modes, ["default"]);
  assert.equal(seedVc.available, true);
  assert.equal(seedVc.settings.seed_vc.model_resident, false);
  assert.equal(seedVc.settings.warmup.ready, false);
  assert.equal(seedVc.settings.health.warm, true);
  assert.deepEqual(payload.ui_capabilities, {
    practice_developer_settings: false,
    practice_history_preview: false,
  });
});

test("Cloudflare worker marks Seed-VC ready only after warmup job succeeds", async () => {
  const kv = fakeKv();
  const calls = [];
  const env = adminAuthEnv(
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

  const adminCookieValue = await adminCookie(env);
  const warmupResponse = await handleRequest(
    new Request("https://example.com/api/warmup", { method: "POST", headers: { cookie: adminCookieValue } }),
    env,
  );
  const warmupJob = await warmupResponse.json();
  const statusResponse = await handleRequest(new Request("https://example.com/api/warmup/warm-job", { headers: { cookie: adminCookieValue } }), env);
  const statusJob = await statusResponse.json();
  const runtimeResponse = await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), env, {});
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
  const env = adminAuthEnv(
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

  const adminCookieValue = await adminCookie(env);
  const warmupResponse = await handleRequest(
    new Request("https://example.com/api/warmup", { method: "POST", headers: { cookie: adminCookieValue } }),
    env,
  );
  const warmupJob = await warmupResponse.json();
  const runtimeResponse = await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), env, {});
  const runtime = await runtimeResponse.json();
  const seedVc = runtime.voice_conversion_backends[0];

  assert.equal(warmupJob.status, "succeeded");
  assert.equal(seedVc.settings.seed_vc.model_resident, true);
  assert.equal(seedVc.settings.warmup.ready, true);
  assert.equal(seedVc.settings.warmup.source, "warmup");
});

test("Cloudflare worker stores Seed-VC ready state when voice conversion run completes immediately", async () => {
  const kv = fakeKv();
  const env = adminAuthEnv(
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
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", headers: { cookie: await adminCookie(env) }, body: form }),
    env,
  );
  const vcJob = await vcResponse.json();
  const runtimeResponse = await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), env, {});
  const runtime = await runtimeResponse.json();
  const seedVc = runtime.voice_conversion_backends[0];

  assert.equal(vcJob.status, "succeeded");
  assert.equal(seedVc.settings.seed_vc.model_resident, true);
  assert.equal(seedVc.settings.warmup.ready, true);
  assert.equal(seedVc.settings.warmup.source, "voice_conversion");
});

test("Cloudflare worker does not echo RunPod raw payloads from failure responses", async () => {
  const marker = "RAW_AUDIO_AND_SCRIPT_MUST_NOT_LEAK";
  const env = adminAuthEnv(async (url) => {
    if (url.endsWith("/run")) {
      return json({ error: { message: marker, audio_base64: marker, script: marker } }, { status: 502 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const cookie = await adminCookie(env, "/speakloop/admin");
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob([marker], { type: "audio/wav" }), "source.wav");
  form.append("reference_audio", new Blob([marker], { type: "audio/wav" }), "reference.wav");

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", headers: { cookie }, body: form }),
    env,
  );
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.doesNotMatch(body, new RegExp(marker));
  assert.match(body, /RunPod request failed/);
});

test("Cloudflare worker submits RunPod jobs without an application policy override", async () => {
  let submittedPayload = null;
  const env = adminAuthEnv(async (url, options = {}) => {
    if (url.endsWith("/run")) {
      submittedPayload = JSON.parse(options.body);
      return json({ id: "job-1", status: "IN_QUEUE" });
    }
    throw new Error(`unexpected external request: ${url}`);
  });
  delete env.RUNPOD_OPERATION_POLICIES_JSON;
  const cookie = await adminCookie(env, "/speakloop/admin");
  const form = new FormData();
  form.append("voice_backend", "seed-vc");
  form.append("source_audio", new Blob(["voice"], { type: "audio/wav" }), "source.wav");
  form.append("reference_audio", new Blob(["voice"], { type: "audio/wav" }), "reference.wav");

  const response = await handleRequest(
    new Request("https://example.com/api/voice-conversion-jobs", { method: "POST", headers: { cookie }, body: form }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(submittedPayload.input.operation_mode, "voice_conversion");
  assert.equal("policy" in submittedPayload, false);
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
  const firstEnv = adminAuthEnv(fetchImpl, { kv });
  firstEnv.RUNPOD_ENDPOINT_ID = "endpoint-a";
  const secondEnv = adminAuthEnv(fetchImpl, { kv });
  secondEnv.RUNPOD_ENDPOINT_ID = "endpoint-b";
  const adminCookieValue = await adminCookie(firstEnv);

  await handleRequest(new Request("https://example.com/api/warmup/warm-job", { headers: { cookie: adminCookieValue } }), firstEnv);
  const firstRuntime = await (await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), firstEnv, {})).json();
  const secondRuntime = await (await workerEntrypoint.fetch(new Request("https://example.com/api/runtime"), secondEnv, {})).json();

  assert.equal(firstRuntime.voice_conversion_backends[0].settings.warmup.ready, true);
  assert.equal(secondRuntime.voice_conversion_backends[0].settings.warmup.ready, false);
  assert.equal(secondRuntime.voice_conversion_backends[0].settings.seed_vc.model_resident, false);
});

const GOOGLE_TEST_KEY_ID = "google-test-key";
let googleIdTokenFixturePromise;

async function googleIdTokenFixture() {
  if (!googleIdTokenFixturePromise) {
    googleIdTokenFixturePromise = (async () => {
      const primary = await generateKeyPair("RS256", { extractable: true });
      const other = await generateKeyPair("RS256", { extractable: true });
      const publicJwk = await exportJWK(primary.publicKey);
      Object.assign(publicJwk, { alg: "RS256", kid: GOOGLE_TEST_KEY_ID, use: "sig" });
      return {
        privateKey: primary.privateKey,
        otherPrivateKey: other.privateKey,
        jwks: createLocalJWKSet({ keys: [publicJwk] }),
      };
    })();
  }
  return googleIdTokenFixturePromise;
}

async function signGoogleIdToken(claims = {}, options = {}) {
  const fixture = await googleIdTokenFixture();
  const now = Math.floor(Date.now() / 1000);
  const algorithm = options.algorithm || "RS256";
  const key = algorithm === "HS256"
    ? new TextEncoder().encode("unit-test-google-hmac-secret-at-least-32-bytes")
    : (options.privateKey || fixture.privateKey);
  return new SignJWT({
    iss: "https://accounts.google.com",
    aud: "google-client-id",
    sub: "google-viewer-subject",
    email: "viewer@example.com",
    email_verified: true,
    iat: now,
    nbf: now - 5,
    exp: now + 900,
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm, kid: options.kid || GOOGLE_TEST_KEY_ID, typ: "JWT" })
    .sign(key);
}

function nativeSessionRequest(idToken) {
  return new Request("https://example.com/api/native-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
  });
}

function signedSessionPayload(token) {
  const encodedPayload = String(token || "").split(".")[0];
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

async function signPublicSessionTokenForTest(payload, secret = "test-public-session-secret") {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload)));
  const signatureHex = [...signature].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${encodedPayload}.${signatureHex}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fakeEnv(fetchImpl, options = {}) {
  return {
    RUNPOD_ENDPOINT_ID: "endpoint",
    RUNPOD_API_KEY: "runpod-secret",
    RUNPOD_API_BASE_URL: "https://api.runpod.ai/v2",
    OPENAI_API_KEY: "openai-secret",
    OPENAI_TRANSLATION_MODEL: "gpt-5.6-terra",
    OPENAI_TEXT_DISPLAY_MODEL: "gpt-5.6-terra",
    OPENAI_TTS_MODEL: "gpt-4o-mini-tts",
    OPENAI_TTS_VOICE: "coral",
    OPENAI_TTS_RESPONSE_FORMAT: "wav",
    MO_SPEECH_KV: options.kv || null,
    MO_SPEECH_AUDIO_R2: options.r2 || null,
    MO_SPEECH_DB: options.db || null,
    __fetch: fetchImpl,
  };
}

function adminAuthEnv(fetchImpl, options = {}) {
  return {
    ...fakeEnv(fetchImpl, options),
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    PUBLIC_SESSION_SECRET: "test-public-session-secret",
    ADMIN_GOOGLE_EMAILS: options.adminGoogleEmails || "admin@example.com",
    __fetch: async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "google-access-token" });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ sub: options.googleSub || "google-admin-subject", email: options.googleEmail || "admin@example.com", email_verified: true, name: "Admin" });
      }
      return fetchImpl(url, init);
    },
  };
}

function publicAuthEnv(fetchImpl, options = {}) {
  return {
    ...fakeEnv(fetchImpl, options),
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    PUBLIC_SESSION_SECRET: "test-public-session-secret",
    PUBLIC_GOOGLE_AUTH_REQUIRED: "1",
    ADMIN_GOOGLE_EMAILS: options.adminGoogleEmails || "",
  };
}

async function adminCookie(env, next = "/admin") {
  return publicCookie(env, next);
}

async function publicCookie(env, next = "/speakloop") {
  const login = await handleRequest(new Request(`https://example.com/auth/google/login?next=${encodeURIComponent(next)}`), env);
  const location = new URL(login.headers.get("location"));
  const state = location.searchParams.get("state");
  const callback = await handleRequest(
    new Request(`https://example.com/auth/google/callback?code=oauth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: login.headers.get("set-cookie") },
    }),
    env,
  );
  return callback.headers.get("set-cookie");
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

function publicSessionPayload(setCookie) {
  const cookieValue = String(setCookie).match(/(?:^|;\s*)mo_public_session=([^;]+)/)?.[1] || "";
  const encodedPayload = cookieValue.split(".")[0];
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

async function publicIdentityHashForTest(email) {
  const bytes = new TextEncoder().encode(String(email).trim().toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function fakeKv() {
  const store = new Map();
  return {
    __store: store,
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

function fakeR2() {
  const store = new Map();
  return {
    __store: store,
    async get(key) {
      const value = store.get(key);
      if (!value) return null;
      return {
        async arrayBuffer() {
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        },
      };
    },
    async put(key, value) {
      store.set(key, new Uint8Array(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function zoovoiceEnv(fetchImpl, { db = fakeZoovoiceBudgetD1() } = {}) {
  return {
    __fetch: fetchImpl,
    MO_SPEECH_DB: db,
    ZOOVOICE_ENABLED: "1",
    ZOOVOICE_LOCAL_DEV: "1",
    ZOOVOICE_ORIGIN_MODE: "cloud-run-smoke",
    ZOOVOICE_CLOUD_RUN_URL: "https://zoovoice.example.run.app",
    ZOOVOICE_GCP_ID_TOKEN: "unit-test-id-token",
    ZOOVOICE_TURNSTILE_SITE_KEY: "unit-test-site-key",
    ZOOVOICE_TURNSTILE_SECRET_KEY: "unit-test-secret-key",
    ZOOVOICE_TURNSTILE_EXPECTED_HOSTNAME: "example.com",
    ZOOVOICE_DAILY_LIMIT: "100",
    ZOOVOICE_MONTHLY_LIMIT: "1200",
  };
}

async function productionZoovoiceEnv(fetchImpl, { nowSeconds, serviceAccount } = {}) {
  const env = await zoovoiceEnv(fetchImpl);
  env.ZOOVOICE_LOCAL_DEV = "0";
  env.ZOOVOICE_ORIGIN_MODE = "cloud-run";
  env.ZOOVOICE_CLOUD_RUN_URL = "https://zoovoice.example.run.app/";
  delete env.ZOOVOICE_GCP_ID_TOKEN;
  env.ZOOVOICE_GCP_SA_KEY = JSON.stringify(serviceAccount || await testServiceAccountKey());
  env.__ZOOVOICE_NOW = () => Number(nowSeconds) * 1_000;
  return env;
}

async function testServiceAccountKey() {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const base64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g).join("\n");
  return {
    client_email: "zoovoice-invoker@example.invalid",
    private_key: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
    __publicKey: keyPair.publicKey,
  };
}

function testIdToken(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.test-signature`;
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function decodeBase64UrlBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function useOfficialLocalTurnstileCredentials(env) {
  env.ZOOVOICE_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
  env.ZOOVOICE_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
}

function zoovoiceComposeRequest({
  audio = new Uint8Array([1, 2, 3]),
  url = "http://127.0.0.1:8787/api/zoovoice/compose",
  settings = { intensity: 40 },
} = {}) {
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/webm" }), "recording.webm");
  form.append("settings", JSON.stringify(settings));
  form.append("turnstile_token", "turnstile-response-token");
  return new Request(url, { method: "POST", body: form });
}

function validZoovoiceOriginResponse() {
  return {
    audio: { format: "wav", base64: "UklGRg==" },
    meta: {
      transcript: "猫が窓辺で眠っています",
      selected_animal: { id: "cat", label_ja: "猫" },
      selected_animals: [{ id: "cat", label_ja: "猫", reason: "猫が出てくるため" }],
      association_reason: "猫が出てくるため",
      insertions: [{ slot: "word", species: "cat", at_seconds: 0.4, duration_seconds: 0.8 }],
      sound_credits: [{ license: "CC0 1.0", creator: "someone", source_url: "https://example.com/cat" }],
      input_duration_seconds: 1,
      output_duration_seconds: 1.4,
    },
  };
}

function fakeZoovoiceBudgetD1({ row = null, error = null } = {}) {
  const db = {
    __row: row ? { ...row } : null,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (error) throw error;
              if (!String(sql).includes("zoovoice_usage_counters")) {
                throw new Error(`unexpected Zoovoice D1 query: ${sql}`);
              }
              const [feature, usageDate, usageMonth, updatedAt, dailyLimit, monthlyLimit] = args;
              const previous = db.__row;
              const nextDaily = previous?.usage_date === usageDate
                ? Number(previous.daily_count) + 1
                : 1;
              const nextMonthly = previous?.usage_month === usageMonth
                ? Number(previous.monthly_count) + 1
                : 1;
              if (nextDaily > Number(dailyLimit) || nextMonthly > Number(monthlyLimit)) {
                return null;
              }
              db.__row = {
                feature,
                usage_date: usageDate,
                daily_count: nextDaily,
                usage_month: usageMonth,
                monthly_count: nextMonthly,
                updated_at: updatedAt,
              };
              return { daily_count: nextDaily, monthly_count: nextMonthly };
            },
          };
        },
      };
    },
  };
  return db;
}

function fakeD1() {
  const tables = {
    samples: new Map(),
    daily: new Map(),
    total: new Map(),
    audit: [],
    users: new Map(),
    reservations: new Map(),
  };
  const db = {
    __tables: tables,
    __rejectUnboundedQuotaScan: false,
    // 対応表へ流れたSQLを記録する。無料枠の利用者でD1読みが増えていないことを検査で見るため
    __reservationQueries: [],
    prepare(sql) {
      return fakeD1Statement(db, String(sql), []);
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return db;
}

function fakeD1Statement(db, sql, args) {
  return {
    bind(...values) { return fakeD1Statement(db, sql, values); },
    async all() {
      if (sql.includes("FROM public_sample_audios")) return { results: [...db.__tables.samples.values()] };
      if (sql.includes("WITH selected_users") && sql.includes("LEFT JOIN quota_usage_total")) {
        const limit = Number(args[0] || 200);
        const users = [...db.__tables.users.values()]
          .sort((a, b) => String(b.last_login_at || "").localeCompare(String(a.last_login_at || "")))
          .slice(0, limit);
        return {
          results: users.flatMap((user) => {
            const usage = [...db.__tables.total.entries()]
              .filter(([key]) => key.startsWith(`${user.email_hash}:`))
              .map(([key, row]) => ({
                ...user,
                feature: key.slice(user.email_hash.length + 1),
                usage_count: Number(row.usage_count || 0),
              }));
            return usage.length > 0 ? usage : [{ ...user, feature: null, usage_count: null }];
          }),
        };
      }
      if (sql.includes("FROM public_users")) {
        const limit = Number(args[0] || 200);
        return {
          results: [...db.__tables.users.values()]
            .sort((a, b) => String(b.last_login_at || "").localeCompare(String(a.last_login_at || "")))
            .slice(0, limit),
        };
      }
      if (sql.includes("FROM quota_usage_total")) {
        if (db.__rejectUnboundedQuotaScan) {
          throw new Error("quota_usage_total must be limited to the selected public users");
        }
        return {
          results: [...db.__tables.total.entries()].map(([key, row]) => ({
            email_hash: key.split(":")[0],
            feature: key.split(":")[1],
            usage_count: Number(row.usage_count || 0),
          })),
        };
      }
      if (sql.includes("FROM audit_events")) {
        const limit = Number(args[0] || 100);
        return { results: [...db.__tables.audit].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, limit) };
      }
      return { results: [] };
    },
    async first() {
      // 対応表のSQLは定数と完全一致でだけ拾う。部分一致だと本体側で文を変えてもfakeが
      // 古い解釈のまま応え続け、テストが素通りする
      if (sql === CREDIT_RESERVATION_SQL.selectByKey) {
        db.__reservationQueries.push("selectByKey");
        return db.__tables.reservations.get(args[0]) || null;
      }
      if (sql === CREDIT_RESERVATION_SQL.selectByJobId) {
        db.__reservationQueries.push("selectByJobId");
        return [...db.__tables.reservations.values()].find((row) => row.job_id === args[0]) || null;
      }
      if (sql.includes("credit_job_reservations")) throw new Error(`unexpected credit reservation query: ${sql}`);
      if (sql.includes("quota_usage_daily")) return db.__tables.daily.get(`${args[0]}:${args[1]}:${args[2]}`) || null;
      if (sql.includes("quota_usage_total")) return db.__tables.total.get(`${args[0]}:${args[1]}`) || null;
      if (sql.includes("COUNT(*)") && sql.includes("public_users")) return { count: db.__tables.users.size };
      if (sql.includes("COUNT(*)") && sql.includes("audit_events")) return { count: db.__tables.audit.length };
      return null;
    },
    async run() {
      if (sql === CREDIT_RESERVATION_SQL.insert) {
        db.__reservationQueries.push("insert");
        db.__tables.reservations.set(args[0], {
          reserve_key: args[0], job_id: null, subject_id: args[1], feature: args[2], kind: args[3],
          reserved_amount: args[4], status: "in_flight", job_status: null, execution_time_ms: null,
          settled_amount: null, created_at: args[5], resolved_at: null,
        });
        return { success: true };
      }
      if (sql === CREDIT_RESERVATION_SQL.attachJobId) {
        db.__reservationQueries.push("attachJobId");
        const row = db.__tables.reservations.get(args[1]);
        if (row) row.job_id = args[0];
        return { success: true };
      }
      if (sql === CREDIT_RESERVATION_SQL.recordOutcome) {
        db.__reservationQueries.push("recordOutcome");
        const row = db.__tables.reservations.get(args[2]);
        if (row && row.status === "in_flight") {
          row.job_status = args[0];
          row.execution_time_ms = args[1];
        }
        return { success: true };
      }
      if (sql === CREDIT_RESERVATION_SQL.finalize) {
        db.__reservationQueries.push("finalize");
        const row = db.__tables.reservations.get(args[3]);
        if (row && row.status === "in_flight") {
          row.status = args[0];
          row.settled_amount = args[1];
          row.resolved_at = args[2];
        }
        return { success: true };
      }
      if (sql === CREDIT_RESERVATION_SQL.deleteResolved) {
        db.__reservationQueries.push("deleteResolved");
        for (const [key, row] of db.__tables.reservations) {
          if (row.status !== "in_flight" && String(row.resolved_at || "") < args[0]) {
            db.__tables.reservations.delete(key);
          }
        }
        return { success: true };
      }
      if (sql.includes("credit_job_reservations")) throw new Error(`unexpected credit reservation query: ${sql}`);
      if (sql.startsWith("DELETE FROM quota_usage_daily")) {
        for (const [key, row] of db.__tables.daily) {
          if (row.updated_at < args[0]) db.__tables.daily.delete(key);
        }
      } else if (sql.startsWith("DELETE FROM audit_events")) {
        db.__tables.audit = db.__tables.audit.filter((row) => row.occurred_at >= args[0]);
      } else if (sql.startsWith("DELETE FROM public_sample_audios")) {
        db.__tables.samples.delete(`${args[0]}:${args[1]}`);
      } else if (sql.startsWith("INSERT INTO public_sample_audios")) {
        db.__tables.samples.set(`${args[0]}:${args[1]}`, {
          feature: args[0], language: args[1], title: args[2], description: args[3], filename: args[4],
          audio_mime_type: args[5], audio_r2_key: args[6], size_bytes: args[7], updated_at: args[8],
        });
      } else if (sql.startsWith("INSERT INTO public_users")) {
        const previous = db.__tables.users.get(args[0]);
        const tracksLogin = sql.includes("last_login_at = excluded.last_login_at");
        if (previous) {
          previous.email = args[1];
          if (tracksLogin) {
            previous.last_login_at = args[4];
          } else {
            previous.last_seen_at = args[3];
          }
        } else {
          db.__tables.users.set(args[0], {
            email_hash: args[0],
            email: args[1],
            created_at: args[2],
            last_seen_at: args[3],
            last_login_at: args[4] ?? null,
          });
        }
      } else if (sql.startsWith("INSERT INTO quota_usage_daily")) {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        const previous = db.__tables.daily.get(key);
        db.__tables.daily.set(key, { usage_count: previous ? Number(previous.usage_count) + 1 : Number(args[3]) });
      } else if (sql.startsWith("INSERT INTO quota_usage_total")) {
        const key = `${args[0]}:${args[1]}`;
        const previous = db.__tables.total.get(key);
        db.__tables.total.set(key, { usage_count: previous ? Number(previous.usage_count) + 1 : Number(args[2]) });
      } else if (sql.startsWith("INSERT INTO audit_events") || sql.startsWith("INSERT OR IGNORE INTO audit_events")) {
        db.__tables.audit.push({ id: args[0], occurred_at: args[1], actor_email_hash: args[2], action: args[3], feature: args[4], path: args[5], detail_json: args[6] });
      }
      return { success: true };
    },
  };
}

test("Cloudflare worker serves robots.txt and sitemap.xml for the public origin", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.PUBLIC_CANONICAL_ORIGIN = "https://voice-lab.inakaegg.workers.dev";
  // 生成API向けのログイン必須設定はページ閲覧を制限しないため、クロール許可を変えない。
  env.PUBLIC_GOOGLE_AUTH_REQUIRED = "1";
  env.ASSETS = {
    fetch: async () => {
      throw new Error("robots.txt and sitemap.xml must not fall through to assets");
    },
  };

  const robots = await handleRequest(new Request("https://voice-lab.inakaegg.workers.dev/robots.txt"), env);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("Content-Type"), /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /^User-agent: \*$/m);
  for (const path of ["/admin", "/speakloop/admin", "/api/", "/auth/"]) {
    assert.ok(robotsBody.includes(`Disallow: ${path}`), `robots.txt disallows ${path}`);
  }
  assert.equal(robotsBody.includes("Disallow: /fun"), false);
  assert.ok(robotsBody.includes("Sitemap: https://voice-lab.inakaegg.workers.dev/sitemap.xml"));

  const sitemap = await handleRequest(new Request("https://voice-lab.inakaegg.workers.dev/sitemap.xml"), env);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("Content-Type"), /application\/xml/);
  const sitemapBody = await sitemap.text();
  for (const loc of [
    "https://voice-lab.inakaegg.workers.dev/",
    "https://voice-lab.inakaegg.workers.dev/speakloop",
    "https://voice-lab.inakaegg.workers.dev/privacy",
  ]) {
    assert.ok(sitemapBody.includes(`<loc>${loc}</loc>`), `sitemap lists ${loc}`);
  }
  assert.doesNotMatch(sitemapBody, /skitvoice/);
});

test("Cloudflare worker blocks crawlers on non-canonical deployments", async () => {
  const assets = {
    fetch: async () => {
      throw new Error("robots.txt and sitemap.xml must not fall through to assets");
    },
  };

  const nonCanonicalEnv = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  nonCanonicalEnv.PUBLIC_GOOGLE_AUTH_REQUIRED = "1";
  nonCanonicalEnv.ASSETS = assets;

  const robots = await handleRequest(new Request("https://voice-lab-unset-origin.inakaegg.workers.dev/robots.txt"), nonCanonicalEnv);
  assert.equal(robots.status, 200);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /^Disallow: \/$/m);
  assert.doesNotMatch(robotsBody, /Sitemap:/);

  const sitemap = await handleRequest(new Request("https://voice-lab-unset-origin.inakaegg.workers.dev/sitemap.xml"), nonCanonicalEnv);
  assert.equal(sitemap.status, 404);

  const mismatchedEnv = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  mismatchedEnv.PUBLIC_CANONICAL_ORIGIN = "https://voice-lab.inakaegg.workers.dev";
  mismatchedEnv.ASSETS = assets;

  const mismatchedRobots = await handleRequest(new Request("https://voice-lab-unset-origin.inakaegg.workers.dev/robots.txt"), mismatchedEnv);
  assert.match(await mismatchedRobots.text(), /^Disallow: \/$/m);
  const mismatchedSitemap = await handleRequest(new Request("https://voice-lab-unset-origin.inakaegg.workers.dev/sitemap.xml"), mismatchedEnv);
  assert.equal(mismatchedSitemap.status, 404);
});

test("Cloudflare worker stores the Google subject in the public session cookie", async () => {
  const env = adminAuthEnv(async (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  }, { googleEmail: "viewer@example.com", googleSub: "google-subject-42" });

  const cookie = await publicCookie(env);

  assert.equal(publicSessionPayload(cookie).sub, "google-subject-42");
  assert.equal(publicSessionPayload(cookie).email, "viewer@example.com");
});

test("Cloudflare worker stores the Google subject in a native session token", async () => {
  const fixture = await googleIdTokenFixture();
  const env = publicAuthEnv(async (url) => {
    throw new Error(`native session exchange must not call an external service: ${url}`);
  }, { kv: fakeKv(), db: fakeD1() });
  env.__googleJwks = fixture.jwks;
  const idToken = await signGoogleIdToken({ sub: "google-native-subject", email: "viewer@example.com" });

  const response = await handleRequest(nativeSessionRequest(idToken), env);

  assert.equal(response.status, 200);
  const body = parseJsonBody(await response.text());
  assert.equal(signedSessionPayload(body.session_token).sub, "google-native-subject");
});

test("Cloudflare worker keeps accepting public sessions issued before the subject was stored", async () => {
  const env = publicAuthEnv(async (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  });
  const legacyToken = await signPublicSessionTokenForTest({
    email: "viewer@example.com",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const response = await handleRequest(
    new Request("https://example.com/api/public-session", {
      headers: { cookie: `mo_public_session=${legacyToken}` },
    }),
    env,
  );

  assert.equal(response.status, 200);
  const body = parseJsonBody(await response.text());
  assert.equal(body.authenticated, true);
  assert.equal(body.email, "viewer@example.com");
});

test("credit client prefers the HTTP route so a declared service binding stub cannot hide it", async () => {
  const calls = [];
  const env = {
    CREDIT_BASE_URL: "https://credit.example.test",
    CREDIT_BASE_SECRET: "credit-secret",
    CREDIT_BASE: { async reserve() { throw new Error("the RPC stub must not be used while the HTTP route is configured"); } },
    __fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      return json({ status: "recorded", reservedAmount: 30, balance: 70 });
    },
  };

  const { client, reason } = resolveCreditClient(env);
  const result = await client.reserve({
    subjectId: "google:1", amount: 30, product: "voice-lab", feature: "voice-conversion-jobs", idempotencyKey: "k1",
  });

  assert.equal(reason, "");
  assert.equal(client.transport, "http");
  assert.equal(calls[0].url, "https://credit.example.test/internal/reserve");
  assert.equal(calls[0].authorization, "Bearer credit-secret");
  assert.deepEqual(result, { status: "recorded", reservedAmount: 30, balance: 70 });
});

test("credit client uses the RPC binding when no HTTP route is configured", async () => {
  const calls = [];
  const env = {
    CREDIT_BASE: {
      async reserve(payload) {
        calls.push(payload);
        return { status: "recorded", reserved_amount: 30, balance: 70 };
      },
    },
  };

  const { client } = resolveCreditClient(env);
  const result = await client.reserve({
    subjectId: "google:1", amount: 30, product: "voice-lab", feature: "voice-conversion-jobs",
    idempotencyKey: "k1", callbackUrl: "https://voice-lab.test/cb", ttlSeconds: 600,
  });

  assert.equal(client.transport, "rpc");
  assert.deepEqual(calls[0], {
    subject_id: "google:1", amount: 30, product: "voice-lab", feature: "voice-conversion-jobs",
    idempotency_key: "k1", callback_url: "https://voice-lab.test/cb", ttl_seconds: 600,
  });
  assert.deepEqual(result, { status: "recorded", reservedAmount: 30, balance: 70 });
});

test("credit client reports a misconfigured HTTP route separately from an absent one", () => {
  assert.deepEqual(
    resolveCreditClient({ CREDIT_BASE_URL: "https://credit.example.test" }),
    { client: null, reason: "misconfigured" },
  );
  assert.deepEqual(resolveCreditClient({}), { client: null, reason: "no_client" });
});

test("credit client normalizes both key spellings and both routes' validation errors", async () => {
  const rpc = resolveCreditClient({
    CREDIT_BASE: {
      async settle() {
        const error = new Error("actual_amount は1以上の整数である必要がある");
        error.name = "ValidationError";
        throw error;
      },
    },
  }).client;
  const http = resolveCreditClient({
    CREDIT_BASE_URL: "https://credit.example.test",
    CREDIT_BASE_SECRET: "s",
    __fetch: async () => json({ error: "invalid_request", message: "actual_amount は1以上の整数である必要がある" }, { status: 400 }),
  }).client;

  await assert.rejects(
    () => rpc.settle({ reserveKey: "r1", actualAmount: 0, idempotencyKey: "vl:r1:settle" }),
    (error) => error.creditKind === "invalid_request",
  );
  await assert.rejects(
    () => http.settle({ reserveKey: "r1", actualAmount: 0, idempotencyKey: "vl:r1:settle" }),
    (error) => error.creditKind === "invalid_request",
  );
});

test("credit client treats an unnamed RPC failure as an unknown outcome that may be retried", async () => {
  const client = resolveCreditClient({
    CREDIT_BASE: { async settle() { throw new Error("D1_ERROR: database is locked"); } },
  }).client;

  await assert.rejects(
    () => client.settle({ reserveKey: "r1", actualAmount: 5, idempotencyKey: "vl:r1:settle" }),
    (error) => error.creditKind === "unknown",
  );
});

function fakeCreditBase(responses = {}) {
  const calls = [];
  const respond = (method, fallback) => async (payload) => {
    calls.push({ method, payload });
    const handler = responses[method];
    if (typeof handler === "function") return handler(payload, calls);
    return handler || fallback;
  };
  return {
    calls,
    getBalance: respond("getBalance", { balance: 0 }),
    reserve: respond("reserve", { status: "recorded" }),
    settle: respond("settle", { status: "recorded" }),
    release: respond("release", { status: "recorded" }),
  };
}

function practiceOpenAiFetch(overrides = {}) {
  return async (url) => {
    if (typeof overrides[url] === "function") return overrides[url]();
    if (url === "https://api.openai.com/v1/audio/transcriptions") return json({ text: "今日は何をしますか" });
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: JSON.stringify({ source_language: "ja-JP", target_language: "en-US", translated_text: "What are you doing today?" }) });
    }
    if (url === "https://api.openai.com/v1/audio/speech") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    throw new Error(`unexpected external request: ${url}`);
  };
}

async function exhaustedQuotaCreditEnv({ fetchImpl = practiceOpenAiFetch(), credit = fakeCreditBase(), flag = "1", db = fakeD1() } = {}) {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    admin_google_emails: ["admin@example.com"],
    features: { speakloop: { daily_limit: 0, total_limit: 0, audio_max_bytes: 8000000, text_max_chars: 800 } },
  }));
  const env = adminAuthEnv(fetchImpl, { kv, db, googleEmail: "viewer@example.com", googleSub: "viewer-subject" });
  if (flag !== null) env.CREDIT_CONSUME_ENABLED = flag;
  if (credit) env.CREDIT_BASE = credit;
  env.PUBLIC_CANONICAL_ORIGIN = "https://voice-lab.test";
  env.CREDIT_BASE_CALLBACK_SECRET = "callback-secret";
  return { env, kv, db, credit };
}

function practicePromptRequest(cookie) {
  const form = new FormData();
  form.append("audio", new Blob(["prompt"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "en-US");
  return new Request("https://example.com/api/practice/prompts", { method: "POST", headers: { cookie }, body: form });
}

test("Cloudflare worker spends credits once the free quota is exhausted", async () => {
  const { env, credit, db } = await exhaustedQuotaCreditEnv();
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 200);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "settle"]);
  const [reserve, settle] = credit.calls;
  assert.equal(reserve.payload.subject_id, "google:viewer-subject");
  assert.equal(reserve.payload.amount, 5);
  assert.equal(reserve.payload.product, "voice-lab");
  assert.equal(reserve.payload.feature, "practice-prompts");
  assert.equal(reserve.payload.ttl_seconds, 600);
  assert.match(reserve.payload.callback_url, /^https:\/\/voice-lab\.test\/api\/internal\/credit-jobs\/[^?]+\?iat=.+&sig=[0-9a-f]{32}$/);
  assert.equal(settle.payload.actual_amount, 5);
  assert.equal(settle.payload.idempotency_key, `vl:${reserve.payload.idempotency_key}:settle`);
  const reservation = db.__tables.reservations.get(reserve.payload.idempotency_key);
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.job_status, "succeeded");
  assert.equal(reservation.settled_amount, 5);
});

test("Cloudflare worker refuses the request without calling OpenAI when the credit balance is short", async () => {
  const credit = fakeCreditBase({ reserve: { status: "insufficient_balance" } });
  const { env } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => { throw new Error(`OpenAI must not be called without credits: ${url}`); },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 402);
  const body = parseJsonBody(await response.text());
  assert.equal(body.code, "credit_insufficient");
  // チャージが要ることだけを伝える。残高の数値や台帳の状態は出さない
  assert.equal(body.detail, "クレジットが不足しています。チャージしてからもう一度お試しください。");
  assert.deepEqual(Object.keys(body).sort(), ["code", "detail"]);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve"]);
});

test("Cloudflare worker returns the reserved credits when the generation fails", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: practiceOpenAiFetch({
      "https://api.openai.com/v1/audio/speech": () => new Response("tts is down", { status: 502 }),
    }),
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 502);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  const reservation = db.__tables.reservations.get(credit.calls[0].payload.idempotency_key);
  assert.equal(reservation.status, "released");
  assert.equal(reservation.job_status, "failed");
});

test("Cloudflare worker keeps rejecting exhausted quotas while credit consumption is switched off", async () => {
  const credit = fakeCreditBase();
  const { env } = await exhaustedQuotaCreditEnv({
    credit,
    flag: null,
    fetchImpl: async (url) => { throw new Error(`no external call is expected: ${url}`); },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 429);
  assert.equal(parseJsonBody(await response.text()).detail, "public quota exceeded");
  assert.deepEqual(credit.calls, []);
});

test("Cloudflare worker declines to spend credits for sessions issued without a Google subject", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => { throw new Error(`no external call is expected: ${url}`); },
  });
  const legacyToken = await signPublicSessionTokenForTest({
    email: "viewer@example.com",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const response = await handleRequest(practicePromptRequest(`mo_public_session=${legacyToken}`), env);

  assert.equal(response.status, 429);
  assert.deepEqual(credit.calls, []);
  assert.equal(db.__tables.audit.at(-1).action, "credit_skipped_no_subject");
});

test("Cloudflare worker disables credit consumption when the reservation table is unreachable", async () => {
  const credit = fakeCreditBase();
  const { env } = await exhaustedQuotaCreditEnv({
    credit,
    db: null,
    fetchImpl: async (url) => { throw new Error(`no external call is expected: ${url}`); },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 429);
  assert.deepEqual(credit.calls, []);
});

test("Cloudflare worker reports the billing service as unavailable instead of claiming the quota ran out", async () => {
  const credit = fakeCreditBase({ reserve: () => { throw new Error("D1_ERROR: database is locked"); } });
  const { env } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => { throw new Error(`OpenAI must not be called: ${url}`); },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  assert.equal(response.status, 503);
  assert.equal(parseJsonBody(await response.text()).detail, "credit service is unavailable");
});

function attemptJobRequest(cookie) {
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "我想喝咖啡。");
  form.append("asr_model", "whisper-1");
  return new Request("https://example.com/api/practice/attempt-jobs", { method: "POST", headers: { cookie }, body: form });
}

function runpodJobFetch(statusByCall) {
  let statusIndex = 0;
  return async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") return json({ id: "zh-job", status: "IN_QUEUE" });
    if (url === "https://api.runpod.ai/v2/endpoint/health") return json({ workers: {} });
    if (url === "https://api.runpod.ai/v2/endpoint/status/zh-job") {
      const next = statusByCall[Math.min(statusIndex, statusByCall.length - 1)];
      statusIndex += 1;
      if (typeof next === "function") return next();
      return json(next);
    }
    throw new Error(`unexpected external request: ${url}`);
  };
}

test("Cloudflare worker reserves on submission and settles the measured cost when polling sees the job finish", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([
      { id: "zh-job", status: "IN_PROGRESS" },
      { id: "zh-job", status: "FAILED", error: "gpu crashed", executionTime: 48_000 },
    ]),
  });
  const cookie = await publicCookie(env);

  const submitted = await handleRequest(attemptJobRequest(cookie), env);
  assert.equal(submitted.status, 202);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve"]);
  const reserveKey = credit.calls[0].payload.idempotency_key;
  assert.equal(credit.calls[0].payload.amount, 10);
  assert.equal(db.__tables.reservations.get(reserveKey).job_id, "zh-job");

  // 実行中のあいだは精算しない
  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve"]);

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  const reservation = db.__tables.reservations.get(reserveKey);
  assert.equal(reservation.status, "released");
  assert.equal(reservation.job_status, "failed");
});

test("Cloudflare worker settles a finished job from the recorded measurement after RunPod drops the result", async () => {
  let settleAttempts = 0;
  const credit = fakeCreditBase({
    settle: () => {
      settleAttempts += 1;
      if (settleAttempts === 1) throw new Error("D1_ERROR: database is locked");
      return { status: "recorded" };
    },
  });
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([
      { id: "zh-job", status: "COMPLETED", executionTime: 48_000, output: { practice_asr_contract_version: 3 } },
      () => { throw httpErrorForTest(404, "RunPod request failed with HTTP 404"); },
    ]),
  });
  const cookie = await publicCookie(env);
  await handleRequest(attemptJobRequest(cookie), env);
  const reserveKey = credit.calls[0].payload.idempotency_key;

  // 1回目のポーリングは終了を観測して記録するが、精算そのものは落ちる
  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);
  assert.equal(db.__tables.reservations.get(reserveKey).status, "in_flight");
  assert.equal(db.__tables.reservations.get(reserveKey).execution_time_ms, 48_000);

  // RunPodが結果を捨てた後でも、記録した実行時間から同じ額で精算し直せる
  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);
  const settleCalls = credit.calls.filter((call) => call.method === "settle");
  assert.equal(settleCalls.length, 2);
  assert.equal(settleCalls[0].payload.actual_amount, 12);
  assert.equal(settleCalls[1].payload.actual_amount, 12);
  assert.equal(settleCalls[0].payload.idempotency_key, settleCalls[1].payload.idempotency_key);
  assert.equal(db.__tables.reservations.get(reserveKey).status, "settled");
});

test("Cloudflare worker records the amount the ledger actually billed, not the amount it sent", async () => {
  // 実費が予約額を超えると credit-base 側で頭打ちになる。照会エンドポイントは台帳と同じ額を返す
  const credit = fakeCreditBase({ settle: { status: "recorded", billed: 10, unbilled_overage: 2 } });
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([{ id: "zh-job", status: "COMPLETED", executionTime: 48_000, output: { practice_asr_contract_version: 3 } }]),
  });
  const cookie = await publicCookie(env);
  await handleRequest(attemptJobRequest(cookie), env);
  const reserveKey = credit.calls[0].payload.idempotency_key;

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);

  assert.equal(credit.calls.find((call) => call.method === "settle").payload.actual_amount, 12);
  assert.equal(db.__tables.reservations.get(reserveKey).settled_amount, 10);
  assert.equal(db.__tables.audit.at(-1).action, "credit_unbilled_overage");
});

test("Cloudflare worker stops retrying once credit-base reports the reservation is already resolved", async () => {
  const credit = fakeCreditBase({ settle: { status: "already_settled" } });
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([{ id: "zh-job", status: "COMPLETED", executionTime: 8_000, output: { practice_asr_contract_version: 3 } }]),
  });
  const cookie = await publicCookie(env);
  await handleRequest(attemptJobRequest(cookie), env);
  const reserveKey = credit.calls[0].payload.idempotency_key;

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);
  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);

  assert.equal(credit.calls.filter((call) => call.method === "settle").length, 1);
  assert.equal(db.__tables.reservations.get(reserveKey).status, "resolved_elsewhere");
});

test("Cloudflare worker leaves free-quota polling untouched by the reservation table", async () => {
  const credit = fakeCreditBase();
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    admin_google_emails: ["admin@example.com"],
    features: { speakloop: { daily_limit: 50, total_limit: 50, audio_max_bytes: 8000000, text_max_chars: 800 } },
  }));
  const env = adminAuthEnv(runpodJobFetch([{ id: "zh-job", status: "COMPLETED", executionTime: 8_000, output: { practice_asr_contract_version: 3 } }]), {
    kv, db, googleEmail: "viewer@example.com", googleSub: "viewer-subject",
  });
  env.CREDIT_CONSUME_ENABLED = "1";
  env.CREDIT_BASE = credit;
  const cookie = await publicCookie(env);

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);

  assert.deepEqual(credit.calls, []);
  assert.deepEqual(db.__reservationQueries, []);
});

test("Cloudflare worker finds the reservation without the KV marker when no KV namespace is bound", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([{ id: "zh-job", status: "COMPLETED", executionTime: 8_000, output: { practice_asr_contract_version: 3 } }]),
  });
  const cookie = await publicCookie(env);
  await handleRequest(attemptJobRequest(cookie), env);
  const reserveKey = credit.calls[0].payload.idempotency_key;
  db.__tables.reservations.get(reserveKey).job_id = "zh-job";
  env.MO_SPEECH_KV = null;

  await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);

  assert.ok(db.__reservationQueries.includes("selectByJobId"));
  assert.equal(db.__tables.reservations.get(reserveKey).status, "settled");
});

function httpErrorForTest(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

test("Cloudflare worker returns the reserved credits when a recording request fails after the reservation", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: practiceOpenAiFetch({
      "https://api.openai.com/v1/audio/speech": () => new Response("tts is down", { status: 502 }),
    }),
  });
  const cookie = await publicCookie(env);
  const form = new FormData();
  form.append("audio", new Blob(["prompt"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "en-US");
  form.append("recording_intent", "prompt");

  const response = await handleRequest(new Request("https://example.com/api/practice/recordings", {
    method: "POST", headers: { cookie }, body: form,
  }), env);

  assert.equal(response.status, 502);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  assert.equal(credit.calls[0].payload.feature, "practice-recordings");
  assert.equal(credit.calls[0].payload.amount, 8);
  assert.equal(db.__tables.reservations.get(credit.calls[0].payload.idempotency_key).status, "released");
});

test("Cloudflare worker returns the reserved credits when a same-request attempt comparison fails", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => {
      if (url === "https://api.openai.com/v1/audio/transcriptions") return new Response("asr is down", { status: 502 });
      throw new Error(`unexpected external request: ${url}`);
    },
  });
  const cookie = await publicCookie(env);
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "en-US");
  form.append("target_text", "I want a coffee.");
  form.append("asr_model", "whisper-1");

  const response = await handleRequest(new Request("https://example.com/api/practice/attempt-jobs", {
    method: "POST", headers: { cookie }, body: form,
  }), env);

  assert.equal(response.status, 502);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  assert.equal(credit.calls[0].payload.feature, "practice-attempt-jobs");
  assert.equal(db.__tables.reservations.get(credit.calls[0].payload.idempotency_key).status, "released");
});

test("Cloudflare worker never reaches the credit path for the admin-only voice conversion feature", async () => {
  const credit = fakeCreditBase();
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    admin_google_emails: ["admin@example.com"],
    features: { speakloop: { daily_limit: 0, total_limit: 0 }, voice_conversion: { daily_limit: 0, total_limit: 0 } },
  }));
  const env = adminAuthEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/run") return json({ id: "vc-job", status: "IN_QUEUE" });
    throw new Error(`unexpected external request: ${url}`);
  }, { kv, db, googleEmail: "admin@example.com", googleSub: "admin-subject" });
  env.CREDIT_CONSUME_ENABLED = "1";
  env.CREDIT_BASE = credit;
  const cookie = await publicCookie(env);
  const form = new FormData();
  form.append("source_audio", new Blob(["source"], { type: "audio/wav" }), "source.wav");
  form.append("reference_audio", new Blob(["reference"], { type: "audio/wav" }), "reference.wav");

  const response = await handleRequest(new Request("https://example.com/api/voice-conversion-jobs", {
    method: "POST", headers: { cookie }, body: form,
  }), env);

  // 管理者は無料枠の判定を免除されるので、この機能ではクレジット経路へ到達しない。
  // 非管理者へ開放するまで、ここは配線が誤って発火しないことだけを見張る
  assert.equal(response.status, 200);
  assert.deepEqual(credit.calls, []);
  assert.equal(db.__tables.reservations.size, 0);
});

test("Cloudflare worker never settles a GPU job for zero credits", async () => {
  for (const [executionTime, expected] of [[0, 1], [undefined, 10], [1200, 1], [48_000, 12]]) {
    const credit = fakeCreditBase();
    const { env } = await exhaustedQuotaCreditEnv({
      credit,
      fetchImpl: runpodJobFetch([{
        id: "zh-job",
        status: "COMPLETED",
        ...(executionTime === undefined ? {} : { executionTime }),
        output: { practice_asr_contract_version: 3 },
      }]),
    });
    const cookie = await publicCookie(env);
    await handleRequest(attemptJobRequest(cookie), env);
    await handleRequest(new Request("https://example.com/api/practice/attempt-jobs/zh-job", { headers: { cookie } }), env);

    const settle = credit.calls.find((call) => call.method === "settle");
    assert.equal(settle.payload.actual_amount, expected, `executionTime=${executionTime}`);
  }
});

async function creditCallbackUrlForTest(reserveKey, issuedAt, secret = "callback-secret") {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${reserveKey}\n${issuedAt}`)));
  const hex = [...signature].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const query = new URLSearchParams({ iat: issuedAt, sig: hex });
  return `https://example.com/api/internal/credit-jobs/${encodeURIComponent(reserveKey)}?${query}`;
}

function creditStatusEnv(fetchImpl = async (url) => { throw new Error(`unexpected external request: ${url}`); }) {
  const db = fakeD1();
  const env = fakeEnv(fetchImpl, { db, kv: fakeKv() });
  env.CREDIT_BASE_CALLBACK_SECRET = "callback-secret";
  return { env, db };
}

function seedReservation(db, overrides = {}) {
  const row = {
    reserve_key: "r1", job_id: null, subject_id: "google:1", feature: "practice-attempt-jobs", kind: "job",
    reserved_amount: 10, status: "in_flight", job_status: null, execution_time_ms: null,
    settled_amount: null, created_at: "2026-09-03T00:00:00.000Z", resolved_at: null, ...overrides,
  };
  db.__tables.reservations.set(row.reserve_key, row);
  return row;
}

async function creditStatus(env, reserveKey, issuedAt, secret) {
  const response = await handleRequest(new Request(await creditCallbackUrlForTest(reserveKey, issuedAt, secret)), env);
  return { status: response.status, body: parseJsonBody(await response.text()) };
}

test("Cloudflare worker only answers credit job status for correctly signed callback URLs", async () => {
  const { env } = creditStatusEnv();
  const now = new Date().toISOString();

  const wrongKey = await creditStatus(env, "r1", now, "not-the-secret");
  assert.equal(wrongKey.status, 401);

  const unsigned = await handleRequest(new Request("https://example.com/api/internal/credit-jobs/r1"), env);
  assert.equal(unsigned.status, 401);

  // 別の予約の署名は使い回せない
  const other = await creditCallbackUrlForTest("r2", now);
  const swapped = await handleRequest(new Request(other.replace("/credit-jobs/r2", "/credit-jobs/r1")), env);
  assert.equal(swapped.status, 401);
});

test("Cloudflare worker keeps answering callback URLs signed with the previous key during a rotation", async () => {
  const { env, db } = creditStatusEnv();
  env.CREDIT_BASE_CALLBACK_SECRET = "new-secret";
  env.CREDIT_BASE_CALLBACK_SECRET_PREVIOUS = "callback-secret";
  seedReservation(db, { status: "settled", settled_amount: 12, resolved_at: "2026-09-03T00:01:00.000Z" });

  const answered = await creditStatus(env, "r1", new Date().toISOString(), "callback-secret");

  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body, { status: "succeeded", cost_credits: 12 });
});

test("Cloudflare worker answers credit job status from the reservation table before asking RunPod", async () => {
  const now = new Date().toISOString();
  const cases = [
    [{ status: "settled", settled_amount: 12, resolved_at: now }, { status: "succeeded", cost_credits: 12 }],
    [{ status: "released", resolved_at: now }, { status: "failed", cost_credits: 0 }],
    [{ status: "resolved_elsewhere", resolved_at: now }, { status: "failed", cost_credits: 0 }],
    [{ job_status: "succeeded", execution_time_ms: 48_000, job_id: "zh-job" }, { status: "succeeded", cost_credits: 12 }],
    [{ job_status: "succeeded", kind: "sync", reserved_amount: 5 }, { status: "succeeded", cost_credits: 5 }],
    [{ job_status: "failed", job_id: "zh-job" }, { status: "failed", cost_credits: 0 }],
  ];

  for (const [overrides, expected] of cases) {
    const { env, db } = creditStatusEnv();
    seedReservation(db, overrides);
    const answered = await creditStatus(env, "r1", now);
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.body, expected, JSON.stringify(overrides));
  }
});

test("Cloudflare worker holds unobserved reservations until their reservation TTL runs out", async () => {
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 700 * 1000).toISOString();
  const cases = [
    [{ kind: "sync", reserved_amount: 5 }, fresh, { status: "running", cost_credits: 0 }],
    [{ kind: "sync", reserved_amount: 5 }, stale, { status: "failed", cost_credits: 0 }],
    [{ kind: "job", job_id: null }, fresh, { status: "running", cost_credits: 0 }],
    [{ kind: "job", job_id: null }, stale, { status: "failed", cost_credits: 0 }],
  ];

  for (const [overrides, issuedAt, expected] of cases) {
    const { env, db } = creditStatusEnv();
    seedReservation(db, overrides);
    const answered = await creditStatus(env, "r1", issuedAt);
    assert.deepEqual(answered.body, expected, `${JSON.stringify(overrides)} ${issuedAt}`);
  }
});

test("Cloudflare worker asks RunPod for jobs nobody has observed yet and records what it learns", async () => {
  const now = new Date().toISOString();
  const cases = [
    [json({ id: "zh-job", status: "COMPLETED", executionTime: 48_000 }), { status: "succeeded", cost_credits: 12 }, "succeeded"],
    [json({ id: "zh-job", status: "FAILED" }), { status: "failed", cost_credits: 0 }, "failed"],
    [json({ id: "zh-job", status: "IN_PROGRESS" }), { status: "running", cost_credits: 0 }, null],
  ];

  for (const [runpodResponse, expected, recorded] of cases) {
    const { env, db } = creditStatusEnv(async (url) => {
      if (url === "https://api.runpod.ai/v2/endpoint/status/zh-job") return runpodResponse;
      throw new Error(`unexpected external request: ${url}`);
    });
    seedReservation(db, { job_id: "zh-job" });
    const answered = await creditStatus(env, "r1", now);
    assert.deepEqual(answered.body, expected);
    assert.equal(db.__tables.reservations.get("r1").job_status, recorded);
  }
});

test("Cloudflare worker separates a lost RunPod result from a RunPod it cannot reach", async () => {
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 90_000 * 1000).toISOString();
  const gone = () => new Response("not found", { status: 404 });
  const broken = () => new Response("bad gateway", { status: 502 });
  const unreachable = () => { throw new Error("network is unreachable"); };

  const cases = [
    [gone, fresh, { status: "running", cost_credits: 0 }],
    [gone, old, { status: "failed", cost_credits: 0 }],
    // 通信できないだけなら保留する。復旧すれば次の掃除で決着する
    [broken, old, { status: "running", cost_credits: 0 }],
    [unreachable, old, { status: "running", cost_credits: 0 }],
  ];

  for (const [runpod, issuedAt, expected] of cases) {
    const { env, db } = creditStatusEnv(async (url) => {
      if (url === "https://api.runpod.ai/v2/endpoint/status/zh-job") return runpod();
      throw new Error(`unexpected external request: ${url}`);
    });
    seedReservation(db, { job_id: "zh-job" });
    assert.deepEqual((await creditStatus(env, "r1", issuedAt)).body, expected, `${issuedAt}`);
  }
});

test("Cloudflare worker frees reservations whose row is gone once the grace period passes", async () => {
  const { env } = creditStatusEnv();

  assert.deepEqual((await creditStatus(env, "missing", new Date().toISOString())).body, { status: "running", cost_credits: 0 });
  const old = new Date(Date.now() - 90_000 * 1000).toISOString();
  assert.deepEqual((await creditStatus(env, "missing", old)).body, { status: "failed", cost_credits: 0 });
});

test("Cloudflare worker retains in-flight reservations while sweeping resolved ones", async () => {
  const { env, db } = creditStatusEnv();
  seedReservation(db, { reserve_key: "old", status: "settled", settled_amount: 5, resolved_at: "2020-01-01T00:00:00.000Z" });
  seedReservation(db, { reserve_key: "recent", status: "settled", settled_amount: 5, resolved_at: new Date().toISOString() });
  seedReservation(db, { reserve_key: "pending" });

  await runPublicDataRetention(env, new Date());

  assert.deepEqual([...db.__tables.reservations.keys()].sort(), ["pending", "recent"]);
});

test("Cloudflare worker returns the reserved credits even when the reservation row cannot be written", async () => {
  const credit = fakeCreditBase();
  const db = fakeD1();
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql === CREDIT_RESERVATION_SQL.insert) {
      return { bind: () => ({ async run() { throw new Error("D1_ERROR: disk is full"); } }) };
    }
    return realPrepare(sql);
  };
  const { env } = await exhaustedQuotaCreditEnv({
    credit, db,
    fetchImpl: async (url) => { throw new Error(`OpenAI must not be called: ${url}`); },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(practicePromptRequest(cookie), env);

  // 対応表が書けないと誰も精算できない。応答を返す前にその場で枠を返す
  assert.equal(response.status, 500);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  assert.equal(credit.calls[1].payload.reserve_key, credit.calls[0].payload.idempotency_key);
});

test("Cloudflare worker refuses to spend credits without a callback signing key", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => { throw new Error(`no external call is expected: ${url}`); },
  });
  delete env.CREDIT_BASE_CALLBACK_SECRET;

  const response = await handleRequest(practicePromptRequest(await publicCookie(env)), env);

  // 署名鍵が無いと callback_url を組めず、cronが掃除できない予約だけが溜まる
  assert.equal(response.status, 429);
  assert.deepEqual(credit.calls, []);
  assert.equal(db.__tables.audit.at(-1).action, "credit_disabled_misconfigured");
});

test("Cloudflare worker rejects a malformed credit job path as an unsigned request", async () => {
  const { env } = creditStatusEnv();

  const response = await handleRequest(new Request("https://example.com/api/internal/credit-jobs/%?iat=x&sig=y"), env);

  assert.equal(response.status, 401);
});

test("Cloudflare worker returns the reserved credits when RunPod accepts a job without an id", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => {
      // idが返らないと、あとからジョブの状態を照会する手立てがない
      if (url === "https://api.runpod.ai/v2/endpoint/run") return json({ status: "IN_QUEUE" });
      if (url === "https://api.runpod.ai/v2/endpoint/health") return json({ workers: {} });
      throw new Error(`unexpected external request: ${url}`);
    },
  });
  const cookie = await publicCookie(env);

  const response = await handleRequest(attemptJobRequest(cookie), env);

  assert.equal(response.status, 202);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "release"]);
  assert.equal(db.__tables.reservations.get(credit.calls[0].payload.idempotency_key).status, "released");
});

test("Cloudflare worker keeps the reservation attached when post-submit bookkeeping fails", async () => {
  const credit = fakeCreditBase();
  const { env, db } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: runpodJobFetch([{ id: "zh-job", status: "IN_QUEUE" }]),
  });
  const realPut = env.MO_SPEECH_KV.put.bind(env.MO_SPEECH_KV);
  env.MO_SPEECH_KV.put = async (key, ...rest) => {
    // ジョブは既にRunPodで走っている。ここで枠を返すと無請求のGPU実行になる
    if (String(key).startsWith("practice-attempt-llm-options:")) throw new Error("KV write failed");
    return realPut(key, ...rest);
  };

  const response = await handleRequest(attemptJobRequest(await publicCookie(env)), env);

  assert.equal(response.status, 500);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve"]);
  assert.equal(db.__tables.reservations.get(credit.calls[0].payload.idempotency_key).status, "in_flight");
});

test("Cloudflare worker still answers a charged request when the local reservation row cannot be finalized", async () => {
  const credit = fakeCreditBase();
  const db = fakeD1();
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql === CREDIT_RESERVATION_SQL.finalize) {
      return { bind: () => ({ async run() { throw new Error("D1_ERROR: disk is full"); } }) };
    }
    return realPrepare(sql);
  };
  const { env } = await exhaustedQuotaCreditEnv({ credit, db });

  const response = await handleRequest(practicePromptRequest(await publicCookie(env)), env);

  // 台帳では課金が確定している。手元の後始末が落ちただけで結果を捨てない
  assert.equal(response.status, 200);
  assert.deepEqual(credit.calls.map((call) => call.method), ["reserve", "settle"]);
});

test("credit client refuses a response whose status it does not recognize", async () => {
  const client = resolveCreditClient({ CREDIT_BASE: { async reserve() { return {}; } } }).client;

  await assert.rejects(
    () => client.reserve({ subjectId: "google:1", amount: 5, idempotencyKey: "k1" }),
    (error) => error.creditKind === "unknown",
  );
});

test("Cloudflare worker does not start paid work on an unrecognized reservation response", async () => {
  const credit = fakeCreditBase({ reserve: {} });
  const { env } = await exhaustedQuotaCreditEnv({
    credit,
    fetchImpl: async (url) => { throw new Error(`OpenAI must not be called: ${url}`); },
  });

  const response = await handleRequest(practicePromptRequest(await publicCookie(env)), env);

  assert.equal(response.status, 503);
});

test("Cloudflare worker refuses to spend credits with a non-positive conversion rate", async () => {
  for (const rate of ["0", "-1"]) {
    const credit = fakeCreditBase();
    const { env, db } = await exhaustedQuotaCreditEnv({
      credit,
      fetchImpl: async (url) => { throw new Error(`no external call is expected: ${url}`); },
    });
    env.CREDIT_RUNPOD_CREDITS_PER_SECOND = rate;

    const response = await handleRequest(practicePromptRequest(await publicCookie(env)), env);

    assert.equal(response.status, 429, rate);
    assert.deepEqual(credit.calls, [], rate);
    assert.equal(db.__tables.audit.at(-1).action, "credit_disabled_misconfigured", rate);
  }
});
