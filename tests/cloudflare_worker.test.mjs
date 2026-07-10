import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../cloudflare/worker.mjs";

test("Cloudflare worker routes public app pages from the Voice Lab portal", async () => {
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

  await handleRequest(new Request("https://example.com/"), env);
  await handleRequest(new Request("https://example.com/fun"), env);
  await handleRequest(new Request("https://example.com/speakloop"), env);
  await handleRequest(new Request("https://example.com/skitvoice"), env);
  await handleRequest(new Request("https://example.com/seed-vc"), env);

  assert.deepEqual(requestedPaths, [
    "/portal.html",
    "/user.html",
    "/practice.html",
    "/vibevoice_simple.html",
    "/seed_vc.html",
  ]);
});

test("Cloudflare worker protects admin pages with a signed password session", async () => {
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

  const blocked = await handleRequest(new Request("https://example.com/skitvoice/admin"), env);
  const loginForm = await handleRequest(new Request("https://example.com/admin/login?next=%2Fskitvoice%2Fadmin"), env);
  const badLogin = await handleRequest(
    new Request("https://example.com/admin/login", {
      method: "POST",
      body: new URLSearchParams({ password: "wrong", next: "/skitvoice/admin" }),
    }),
    env,
  );
  const login = await handleRequest(
    new Request("https://example.com/admin/login", {
      method: "POST",
      body: new URLSearchParams({ password: "secret-pass", next: "/skitvoice/admin" }),
    }),
    env,
  );
  const cookie = login.headers.get("set-cookie");
  const allowed = await handleRequest(new Request("https://example.com/skitvoice/admin", { headers: { cookie } }), env);

  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/admin/login?next=%2Fskitvoice%2Fadmin");
  assert.equal(loginForm.status, 200);
  assert.match(await loginForm.text(), /管理ログイン/);
  assert.equal(badLogin.status, 401);
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/skitvoice/admin");
  assert.match(cookie, /mo_admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(allowed.status, 200);
  assert.deepEqual(requestedPaths, ["/vibevoice.html"]);
});

test("Cloudflare worker protects admin APIs with the same password session", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });
  const login = await handleRequest(
    new Request("https://example.com/admin/login", {
      method: "POST",
      body: new URLSearchParams({ password: "secret-pass" }),
    }),
    env,
  );
  const cookie = login.headers.get("set-cookie");

  const blockedSettings = await handleRequest(
    new Request("https://example.com/api/user-settings", {
      method: "PUT",
      body: JSON.stringify({ theme: "blue" }),
    }),
    env,
  );
  const allowedSettings = await handleRequest(
    new Request("https://example.com/api/user-settings", {
      method: "PUT",
      headers: { cookie },
      body: JSON.stringify({ theme: "blue" }),
    }),
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
  assert.equal(session.google_login_required, true);
  assert.equal(session.authenticated, true);
  assert.equal(session.email, "viewer@example.com");
  assert.equal(session.is_admin, false);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "google_login_success");
  assert.equal(audit[0].email, "viewer@example.com");
  assert.equal(audit[0].path, "/auth/google/callback");
  assert.equal(audit[0].next, "/speakloop");
});

test("Cloudflare worker requires public Google login before costly generation APIs", async () => {
  const env = publicAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });

  const response = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Google login is required" });
});

test("Cloudflare worker stores public quota in KV and blocks non-admin overage", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      fun: { daily_limit: 1, total_limit: 1, text_max_chars: 80, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = publicAuthEnv(async (url, init) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env);

  const first = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );
  const second = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { detail: "public quota exceeded" });
  assert.equal(calls.filter((call) => call.url === "https://api.openai.com/v1/audio/speech").length, 1);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.deepEqual(
    audit.map((event) => event.action),
    ["google_login_success", "public_quota_consumed", "public_quota_blocked"],
  );
  assert.equal(audit[1].feature, "fun");
  assert.equal(audit[1].email, "viewer@example.com");
  assert.equal(audit[1].daily_used, 1);
  assert.equal(audit[2].limit_type, "daily");
});

test("Cloudflare worker stores quota and audit in D1 when bound", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({ google_login_required: true, features: { fun: { daily_limit: 1, total_limit: 1, text_max_chars: 80, audio_max_bytes: 1000 } } }));
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return json({ email: "viewer@example.com", email_verified: true });
    if (url === "https://api.openai.com/v1/audio/speech") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    throw new Error(`unexpected url: ${url}`);
  }, { kv, db });
  const cookie = await publicCookie(env);
  const request = () => new Request("https://example.com/api/user-text-output", { method: "POST", headers: { cookie }, body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }) });

  assert.equal((await handleRequest(request(), env)).status, 200);
  assert.equal((await handleRequest(request(), env)).status, 429);
  assert.equal(db.__tables.daily.size, 1);
  assert.equal([...db.__tables.daily.values()][0].usage_count, 1);
  assert.deepEqual(db.__tables.audit.map((event) => event.action), ["google_login_success", "public_quota_consumed", "public_quota_blocked"]);
  assert.equal(await kv.get("public-audit-log"), null);
});

test("Cloudflare worker exempts configured admin Google emails from public quota", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      fun: { daily_limit: 0, total_limit: 0, text_max_chars: 80, audio_max_bytes: 1000 },
    },
  }));
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "owner@example.com", email_verified: true });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv, adminGoogleEmails: "owner@example.com" });
  const cookie = await publicCookie(env);

  const first = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );
  const second = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.deepEqual(
    audit.map((event) => event.action),
    ["google_login_success", "public_quota_exempt", "public_quota_exempt"],
  );
});

test("Cloudflare worker lets password admin edit public access limits", async () => {
  const env = publicAuthEnv(async () => {
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
  assert.deepEqual(fetched.admin_google_emails, ["owner@example.com"]);
  assert.equal(fetched.features.speakloop.daily_limit, 9);
  assert.equal(fetched.features.speakloop.total_limit, 90);
  assert.equal(fetched.features.speakloop.audio_max_bytes, 1234);
  assert.equal(fetched.features.speakloop.text_max_chars, 321);
});

test("Cloudflare worker applies saved public admin emails before quota checks", async () => {
  const kv = fakeKv();
  const calls = [];
  const env = publicAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init?.body) });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "Owner@Example.COM", email_verified: true });
    }
    if (url.endsWith("/run")) {
      return json({ id: "admin-vv-job", status: "IN_QUEUE" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const adminSession = await adminCookie(env);

  const updated = await handleRequest(
    new Request("https://example.com/api/public-access-settings", {
      method: "PUT",
      headers: { cookie: adminSession },
      body: JSON.stringify({
        google_login_required: true,
        admin_google_emails: ["owner@example.com"],
        features: {
          skitvoice: { daily_limit: 0, total_limit: 0, script_max_chars: 100, audio_max_bytes: 1000 },
        },
      }),
    }),
    env,
  );
  const publicSession = await publicCookie(env, "/skitvoice");
  const form = new FormData();
  form.append("script", "1 こんにちは");
  form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");

  const created = await handleRequest(
    new Request("https://example.com/api/vibevoice/jobs", {
      method: "POST",
      headers: { cookie: publicSession },
      body: form,
    }),
    env,
  );
  const audit = JSON.parse(await kv.get("public-audit-log"));
  const runCall = calls.find((call) => call.url.endsWith("/run"));

  assert.equal(updated.status, 200);
  assert.equal(created.status, 200);
  assert.ok(runCall);
  assert.deepEqual(
    audit.map((event) => event.action),
    ["public_access_settings_updated", "google_login_success", "public_quota_exempt"],
  );
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
      skitvoice: null,
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
  assert.equal(payload.features.skitvoice, null);
  assert.equal(blockedDelete.status, 401);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).features.speakloop, null);
  assert.equal((await fetchedAfterDelete.json()).features.speakloop, null);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.equal(audit.at(-2).action, "public_sample_audios_updated");
  assert.equal(audit.at(-1).action, "public_sample_audio_deleted");
  assert.equal(audit.at(-1).feature, "speakloop");
});

test("Cloudflare worker stores Japanese Chinese and English SkitVoice samples in D1 and R2", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  const r2 = fakeR2();
  const env = adminAuthEnv(async () => { throw new Error("unexpected fetch"); }, { kv, db, r2 });
  const cookie = await adminCookie(env);
  const sample = (language) => ({ title: language, description: `${language} sample`, filename: `${language}.wav`, audio_mime_type: "audio/wav", audio_base64: Buffer.from(language).toString("base64") });
  const body = { features: { skitvoice: { samples: { "ja-JP": sample("ja-JP"), "zh-CN": sample("zh-CN"), "en-US": sample("en-US") } } } };

  const saved = await handleRequest(new Request("https://example.com/api/public-sample-audios", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  const payload = await saved.json();

  assert.equal(saved.status, 200);
  assert.equal(payload.features.skitvoice.samples["ja-JP"].title, "ja-JP");
  assert.equal(payload.features.skitvoice.samples["zh-CN"].title, "zh-CN");
  assert.equal(payload.features.skitvoice.samples["en-US"].title, "en-US");
  assert.equal(db.__tables.samples.size, 3);
  assert.equal(r2.__store.size, 3);
  assert.equal(await kv.get("public-sample-audios"), null);

  const deleted = await handleRequest(new Request("https://example.com/api/public-sample-audios/skitvoice?language=zh-CN", { method: "DELETE", headers: { cookie } }), env);
  assert.equal((await deleted.json()).features.skitvoice.samples["zh-CN"], null);
  assert.equal(db.__tables.samples.size, 2);
  assert.equal(r2.__store.size, 2);
});

test("Cloudflare worker does not recurse while migrating an empty legacy sample document", async () => {
  const kv = fakeKv();
  await kv.put("public-sample-audios", JSON.stringify({ features: { speakloop: null, skitvoice: null, fun: null, voice_conversion: null } }));
  const env = fakeEnv(async () => { throw new Error("unexpected fetch"); }, { kv, db: fakeD1(), r2: fakeR2() });

  const response = await handleRequest(new Request("https://example.com/api/public-sample-audios"), env);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).features.skitvoice.samples["ja-JP"], null);
});

test("Cloudflare worker rejects oversized public input before consuming quota", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      fun: { daily_limit: 1, total_limit: 1, text_max_chars: 5, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = publicAuthEnv(async (url) => {
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env);

  const tooLong = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "これは長すぎる", target_language: "ja-JP" }),
    }),
    env,
  );
  const valid = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "短い", target_language: "ja-JP" }),
    }),
    env,
  );

  assert.equal(tooLong.status, 413);
  assert.deepEqual(await tooLong.json(), { detail: "text is too large" });
  assert.equal(valid.status, 200);
  assert.equal(calls.filter((url) => url === "https://api.openai.com/v1/audio/speech").length, 1);
});

test("Cloudflare worker forwards SkitVoice jobs to RunPod with public quota", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      skitvoice: { daily_limit: 2, total_limit: 2, script_max_chars: 100, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = publicAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    if (url.endsWith("/run")) {
      return json({ id: "vv-job", status: "IN_QUEUE" });
    }
    if (url.endsWith("/status/vv-job")) {
      return json({
        id: "vv-job",
        status: "COMPLETED",
        output: {
          audio_mime_type: "audio/mpeg",
          audio_base64: Buffer.from([4, 5, 6]).toString("base64"),
          normalized_script: "Speaker 1: こんにちは",
        },
      });
    }
    if (url.endsWith("/cancel/vv-job")) {
      return json({ id: "vv-job", status: "CANCELLED", error: "cancelled" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env, "/skitvoice");
  const form = new FormData();
  form.append("script", "1 こんにちは");
  form.append("model_id", "vibevoice-large-aoi-pinned");
  form.append("cfg_scale", "1.2");
  form.append("directed_line_mode", "true");
  form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");

  const created = await (
    await handleRequest(new Request("https://example.com/api/vibevoice/jobs", { method: "POST", headers: { cookie }, body: form }), env)
  ).json();
  const completed = await (
    await handleRequest(new Request("https://example.com/api/vibevoice/jobs/vv-job"), env)
  ).json();
  const cancelled = await (
    await handleRequest(new Request("https://example.com/api/vibevoice/jobs/vv-job/cancel", { method: "POST" }), env)
  ).json();
  const runCall = calls.find((call) => call.url.endsWith("/run"));

  assert.equal(created.job_id, "vv-job");
  assert.equal(created.status, "queued");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.normalized_script, "Speaker 1: こんにちは");
  assert.equal(cancelled.status, "failed");
  assert.equal(runCall.body.input.operation_mode, "vibevoice");
  assert.equal(runCall.body.input.script, "1 こんにちは");
  assert.equal(runCall.body.input.generation.model_id, "vibevoice-large-aoi-pinned");
  assert.equal(runCall.body.input.generation.cfg_scale, 1.2);
  assert.equal(runCall.body.input.voices[0].speaker, 1);
  assert.equal(runCall.body.input.voices[0].audio_mime_type, "audio/wav");
  assert.equal(runCall.body.input.voices[0].audio_base64, Buffer.from("voice").toString("base64"));
});

test("Cloudflare worker translates SkitVoice script before RunPod generation", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      skitvoice: { daily_limit: 2, total_limit: 2, script_max_chars: 100, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = publicAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: JSON.stringify({ source_language: "ja-JP", script: "1 Hello.\n2 How are you?" }) });
    }
    if (url.endsWith("/run")) {
      return json({ id: "vv-job", status: "IN_QUEUE" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  env.OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL = "test-vv-translation-model";
  const cookie = await publicCookie(env, "/skitvoice");
  const form = new FormData();
  form.append("script", "1 こんにちは\n2 元気ですか");
  form.append("output_language", "en-US");
  form.append("translate_script", "true");
  form.append("model_id", "vibevoice-large-aoi-pinned");
  form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");

  const created = await (
    await handleRequest(new Request("https://example.com/api/vibevoice/jobs", { method: "POST", headers: { cookie }, body: form }), env)
  ).json();
  const openAiCall = calls.find((call) => call.url === "https://api.openai.com/v1/responses");
  const runCall = calls.find((call) => call.url.endsWith("/run"));

  assert.equal(created.job_id, "vv-job");
  assert.equal(openAiCall.body.model, "test-vv-translation-model");
  assert.match(openAiCall.body.instructions, /Preserve speaker tags/);
  assert.equal(runCall.body.input.script, "1 Hello.\n2 How are you?");
  assert.deepEqual(runCall.body.input.script_translation, {
    requested: true,
    enabled: true,
    output_language: "en-US",
    source_language: "ja-JP",
    source_script: "1 こんにちは\n2 元気ですか",
    translated_script: "1 Hello.\n2 How are you?",
    model: "test-vv-translation-model",
    provider: "openai-responses",
  });
});

test("Cloudflare worker generates a five-line two-speaker SkitVoice script without consuming generation quota", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: { skitvoice: { daily_limit: 2, total_limit: 2 } },
  }));
  let scriptGenerationInput = "";
  const env = publicAuthEnv(async (url, init = {}) => {
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return json({ email: "viewer@example.com", email_verified: true });
    if (url === "https://api.openai.com/v1/responses") {
      scriptGenerationInput = parseJsonBody(init.body).input;
      return json({ output_text: "1 こんにちは\n2 久しぶりです\n1 元気でしたか\n2 元気です\n1 また話しましょう" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env, "/skitvoice");

  const response = await handleRequest(new Request("https://example.com/api/vibevoice/scripts", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ seed_script: "1 AIについて話そう\n2 いいですね" }),
  }), env);

  assert.equal(response.status, 200);
  assert.match(scriptGenerationInput, /AIについて話そう/);
  assert.equal((await response.json()).script.split("\n").length, 5);
  assert.equal(await kv.get("public-quota:skitvoice:viewer@example.com"), null);
});

test("Cloudflare worker rejects SkitVoice URL references before RunPod", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      skitvoice: {
        daily_limit: 2,
        total_limit: 2,
        script_max_chars: 100,
        audio_max_bytes: 1000,
      },
    },
  }));
  const calls = [];
  const env = publicAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: "google-access-token" });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ email: "viewer@example.com", email_verified: true });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env, "/skitvoice");
  const form = new FormData();
  form.append("script", "1 こんにちは");
  form.append("voice_url_1", "https://youtu.be/zDZvAmCJJaY?t=2129");
  form.append("voice_url_duration_1", "6");

  const response = await handleRequest(
    new Request("https://example.com/api/vibevoice/jobs", { method: "POST", headers: { cookie }, body: form }),
    env,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    detail: "URL reference audio is not available on the Cloudflare public demo. Upload or record reference audio instead.",
  });
  assert.equal(calls.some((call) => call.url.endsWith("/run")), false);
});

test("Cloudflare worker does not expose URL reference audio extraction", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("url", "https://youtu.be/zDZvAmCJJaY?t=2129");
  form.append("duration_seconds", "5");
  const response = await handleRequest(
    new Request("https://example.com/api/vibevoice/reference-audio-from-url", {
      method: "POST",
      body: form,
    }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 501);
  assert.deepEqual(payload, { detail: "URL reference audio extraction is only available in the local FastAPI app" });
  assert.equal(calls.some((call) => call.url.endsWith("/runsync")), false);
});

test("Cloudflare worker reports admin auth setup errors on protected routes", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });

  const page = await handleRequest(new Request("https://example.com/admin"), env);
  const api = await handleRequest(new Request("https://example.com/api/warmup", { method: "POST" }), env);

  assert.equal(page.status, 503);
  assert.match(await page.text(), /ADMIN_PASSWORD_SHA256/);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { detail: "admin authentication is not configured" });
});

test("Cloudflare worker translates speech with OpenAI and stores a completed job", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "Halo Jepang" });
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
  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

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
  assert.match(history.recordings[0].metadata.original_content_type, /^audio\/webm(?:;codecs=opus)?$/);
  assert.equal(history.outputs.length, 1);
  assert.equal(history.outputs[0].metadata.endpoint, "translate-speech-jobs");
  assert.equal(calls[0].init.body.get("response_format"), "json");
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
  assert.equal(calls[2].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(calls.filter((call) => call.url === "https://api.openai.com/v1/responses").length, 1);
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 0);
  assert.equal(practiceHistory.recordings[0].metadata.endpoint, "practice-prompts");
  assert.equal(practiceHistory.outputs[0].metadata.endpoint, "practice-prompts");
});

test("Cloudflare worker auto-classifies a single practice recording as a repeat attempt", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({
        text: calls.length === 1 ? "La pelan susinja se treak" : "我想要咖啡",
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "recording.webm");
  form.append("target_language", "zh-CN");
  form.append("current_target_text", "我想要咖啡。");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/recordings", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.recording_kind, "attempt");
  assert.equal(payload.recognized_text, "我想要咖啡");
  assert.equal(payload.classification.attempt_source, "target");
  assert.equal(calls[0].init.body.get("language"), null);
  assert.equal(calls[1].init.body.get("language"), "zh");
});

test("Cloudflare worker auto-classifies a single practice recording as a new prompt", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({
        text: calls.length === 1 ? "明日は天気がいいですか" : "请问明天天气怎么样",
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return json({
        output_text: JSON.stringify({
          source_language: "ja-JP",
          target_language: "zh-CN",
          translated_text: "明天天气好吗？",
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
  assert.equal(payload.target_text, "明天天气好吗？");
  assert.equal(payload.audio_base64, Buffer.from([13, 14, 15]).toString("base64"));
  assert.equal(payload.classification.kind, "prompt");
  assert.equal(calls[0].init.body.get("language"), null);
  assert.equal(calls[1].init.body.get("language"), "zh");
  assert.equal(practiceHistory.outputs[0].metadata.endpoint, "practice-recordings");
});

test("Cloudflare worker requests whisper timestamps for pronunciation practice", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
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
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv() });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("target_language", "en-US");
  form.append("target_text", "I want a coffee.");
  form.append("asr_model", "whisper-1");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempts", { method: "POST", body: form }),
    env,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].init.body.get("model"), "whisper-1");
  assert.equal(calls[0].init.body.get("response_format"), "verbose_json");
  assert.deepEqual(calls[0].init.body.getAll("timestamp_granularities[]"), ["word", "segment"]);
  assert.equal(payload.recognized_text, "I want coffee.");
  assert.equal(payload.asr_timestamps.available, true);
  assert.equal(payload.asr_timestamps.words[0].text, "I");
  assert.equal(payload.comparison_alignment.complete, true);
  assert.equal(payload.comparison_alignment.ranges[0].audio_start, 0.1);
  assert.equal(payload.comparison_alignment.ranges[0].audio_end, 1.1);
  assert.equal(payload.providers.asr, "openai-asr-whisper-1");

  const cookie = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/practice-history", { headers: { cookie } }), env)
  ).json();
  const diagnostics = JSON.parse(history.recordings[0].metadata.practice_diagnostics_json);
  assert.equal(diagnostics.recognized_text, "I want coffee.");
  assert.equal(diagnostics.asr_timestamps.word_count, 3);
  assert.equal(diagnostics.comparison_alignment.complete, true);
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

test("Cloudflare worker scores a pronunciation practice attempt", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, language: init.body?.get?.("language") || "" });
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return json({ text: "I want coffee" });
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
  assert.ok(payload.similarity >= 0.95);
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
      return json({ text: "你好，你最近怎麼樣?" });
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
  assert.equal(payload.grade, "perfect");
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
  const env = adminAuthEnv(
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
  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(response.status, 200);
  assert.equal(history.recordings.length, 1);
  assert.equal(history.recordings[0].filename, "job-vc-source.webm");
  assert.equal(history.recordings[0].metadata.endpoint, "voice-conversion-jobs");
  assert.match(history.recordings[0].metadata.content_type, /^audio\/webm(?:;codecs=opus)?$/);
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
    new Request("https://example.com/api/voice-conversion-jobs/job-vc"),
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
  const env = adminAuthEnv(
    async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === "https://api.openai.com/v1/responses") {
        return json({ output_text: JSON.stringify({ variants: [["A1"], ["B1"]] }) });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv: fakeKv() },
  );

  const adminCookieValue = await adminCookie(env);
  const saveResponse = await handleRequest(
    new Request("https://example.com/api/user-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: adminCookieValue },
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
  const env = adminAuthEnv(
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
  const adminCookieValue = await adminCookie(env);
  const historyResponse = await handleRequest(
    new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }),
    env,
  );
  const history = await historyResponse.json();
  const entry = history.outputs[0];
  const audioResponse = await handleRequest(new Request(`https://example.com${entry.url}`, { headers: { cookie: adminCookieValue } }), env);
  const audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
  const deleteResponse = await handleRequest(
    new Request(`https://example.com${entry.url}`, { method: "DELETE", headers: { cookie: adminCookieValue } }),
    env,
  );
  const afterDelete = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

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

test("Cloudflare worker stores new audio history blobs in R2 while keeping metadata in KV", async () => {
  const r2 = fakeR2();
  const env = adminAuthEnv(
    async (url) => {
      if (url === "https://api.openai.com/v1/responses") {
        return json({ output_text: "R2 sample." });
      }
      if (url === "https://api.openai.com/v1/audio/speech") {
        return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv: fakeKv(), r2 },
  );

  await handleRequest(
    new Request("https://example.com/api/user-joke-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "R2 test", target_language: "en-US" }),
    }),
    env,
  );
  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();
  const entry = history.outputs[0];

  assert.equal(history.settings.metadata_store, "kv");
  assert.equal(history.settings.blob_store, "r2");
  assert.equal(entry.audio_storage, "r2");
  assert.equal(r2.__store.size, 1);

  const audioResponse = await handleRequest(
    new Request(`https://example.com${entry.url}`, { headers: { cookie: adminCookieValue } }),
    env,
  );
  assert.deepEqual([...new Uint8Array(await audioResponse.arrayBuffer())], [7, 8, 9]);

  await handleRequest(
    new Request(`https://example.com${entry.url}`, { method: "DELETE", headers: { cookie: adminCookieValue } }),
    env,
  );
  assert.equal(r2.__store.size, 0);
});

test("Cloudflare worker keeps legacy KV audio readable after enabling R2", async () => {
  const kv = fakeKv();
  const r2 = fakeR2();
  let speechCount = 0;
  const env = adminAuthEnv(
    async (url) => {
      if (url === "https://api.openai.com/v1/responses") {
        return json({ output_text: `sample-${speechCount}` });
      }
      if (url === "https://api.openai.com/v1/audio/speech") {
        speechCount += 1;
        return new Response(new Uint8Array([speechCount]), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    { kv },
  );
  const create = () => handleRequest(
    new Request("https://example.com/api/user-joke-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "migration test", target_language: "en-US" }),
    }),
    env,
  );

  await create();
  env.MO_SPEECH_AUDIO_R2 = r2;
  await create();

  const adminCookieValue = await adminCookie(env);
  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();
  const legacyEntry = history.outputs.find((entry) => entry.audio_storage === "kv");
  const r2Entry = history.outputs.find((entry) => entry.audio_storage === "r2");
  const legacyAudio = await handleRequest(
    new Request(`https://example.com${legacyEntry.url}`, { headers: { cookie: adminCookieValue } }),
    env,
  );

  assert.ok(legacyEntry);
  assert.ok(r2Entry);
  assert.deepEqual([...new Uint8Array(await legacyAudio.arrayBuffer())], [1]);
  assert.equal(r2.__store.size, 1);
});

test("Cloudflare worker keeps R2 metadata when its binding is temporarily unavailable", async () => {
  const r2 = fakeR2();
  const env = adminAuthEnv(
    async (url) => {
      if (url === "https://api.openai.com/v1/responses") return json({ output_text: "temporary" });
      if (url === "https://api.openai.com/v1/audio/speech") return new Response(new Uint8Array([10]), { status: 200 });
      throw new Error(`unexpected url: ${url}`);
    },
    { kv: fakeKv(), r2 },
  );
  await handleRequest(
    new Request("https://example.com/api/user-joke-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "binding test", target_language: "en-US" }),
    }),
    env,
  );
  const adminCookieValue = await adminCookie(env);
  const before = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();
  env.MO_SPEECH_AUDIO_R2 = null;
  const deleteResponse = await handleRequest(
    new Request(`https://example.com${before.outputs[0].url}`, { method: "DELETE", headers: { cookie: adminCookieValue } }),
    env,
  );
  const after = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.equal(deleteResponse.status, 503);
  assert.deepEqual(await deleteResponse.json(), { detail: "MO_SPEECH_AUDIO_R2 binding is required for this audio history entry" });
  assert.equal(after.outputs.length, 1);
  assert.equal(r2.__store.size, 1);
});

test("Cloudflare worker can expose one hundred audio history entries per kind", async () => {
  const env = adminAuthEnv(async () => json({ ok: true }), { kv: fakeKv() });
  env.CLOUDFLARE_AUDIO_HISTORY_LIMIT = "100";
  const adminCookieValue = await adminCookie(env);

  const history = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

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
  const firstEnv = adminAuthEnv(fetchImpl, { kv });
  firstEnv.RUNPOD_ENDPOINT_ID = "endpoint-a";
  const secondEnv = adminAuthEnv(fetchImpl, { kv });
  secondEnv.RUNPOD_ENDPOINT_ID = "endpoint-b";
  const adminCookieValue = await adminCookie(firstEnv);

  await handleRequest(new Request("https://example.com/api/warmup/warm-job", { headers: { cookie: adminCookieValue } }), firstEnv);
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
    MO_SPEECH_AUDIO_R2: options.r2 || null,
    MO_SPEECH_DB: options.db || null,
    __fetch: fetchImpl,
  };
}

function adminAuthEnv(fetchImpl, options = {}) {
  return {
    ...fakeEnv(fetchImpl, options),
    ADMIN_PASSWORD_SHA256: "f38eb016088980f10dcbffce49bc7d0d476d198c43a6fa8a343416709049c9db",
    ADMIN_SESSION_SECRET: "test-admin-session-secret",
  };
}

function publicAuthEnv(fetchImpl, options = {}) {
  return {
    ...adminAuthEnv(fetchImpl, options),
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    PUBLIC_SESSION_SECRET: "test-public-session-secret",
    PUBLIC_GOOGLE_AUTH_REQUIRED: "1",
    ADMIN_GOOGLE_EMAILS: options.adminGoogleEmails || "",
  };
}

async function adminCookie(env) {
  const response = await handleRequest(
    new Request("https://example.com/admin/login", {
      method: "POST",
      body: new URLSearchParams({ password: "secret-pass" }),
    }),
    env,
  );
  return response.headers.get("set-cookie");
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

function fakeD1() {
  const tables = {
    samples: new Map(),
    daily: new Map(),
    total: new Map(),
    audit: [],
    users: new Map(),
  };
  const db = {
    __tables: tables,
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
      if (sql.includes("FROM audit_events")) {
        const limit = Number(args[0] || 100);
        return { results: [...db.__tables.audit].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, limit) };
      }
      return { results: [] };
    },
    async first() {
      if (sql.includes("quota_usage_daily")) return db.__tables.daily.get(`${args[0]}:${args[1]}:${args[2]}`) || null;
      if (sql.includes("quota_usage_total")) return db.__tables.total.get(`${args[0]}:${args[1]}`) || null;
      if (sql.includes("COUNT(*)") && sql.includes("audit_events")) return { count: db.__tables.audit.length };
      return null;
    },
    async run() {
      if (sql.startsWith("DELETE FROM public_sample_audios")) {
        db.__tables.samples.delete(`${args[0]}:${args[1]}`);
      } else if (sql.startsWith("INSERT INTO public_sample_audios")) {
        db.__tables.samples.set(`${args[0]}:${args[1]}`, {
          feature: args[0], language: args[1], title: args[2], description: args[3], filename: args[4],
          audio_mime_type: args[5], audio_r2_key: args[6], size_bytes: args[7], updated_at: args[8],
        });
      } else if (sql.startsWith("INSERT INTO public_users")) {
        db.__tables.users.set(args[0], { email_hash: args[0], created_at: args[1], last_seen_at: args[2] });
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
