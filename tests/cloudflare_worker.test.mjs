import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../cloudflare/worker.mjs";

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

  await handleRequest(new Request("https://example.com/"), env);
  await handleRequest(new Request("https://example.com/speakloop"), env);
  await handleRequest(new Request("https://example.com/skitvoice"), env);

  assert.deepEqual(requestedPaths, [
    "/react/portal.html",
    "/react/speakloop.html",
    "/react/skitvoice.html",
  ]);
});

test("Cloudflare worker exposes fun only to an allowlisted Google account", async () => {
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

  const blocked = await handleRequest(new Request("https://example.com/fun"), env);
  const cookie = await adminCookie(env);
  const allowed = await handleRequest(new Request("https://example.com/fun", { headers: { cookie } }), env);
  const directAsset = await handleRequest(new Request("https://example.com/static/user.html", { headers: { cookie } }), env);

  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/auth/google/login?next=%2Ffun");
  assert.equal(allowed.status, 200);
  assert.equal(directAsset.status, 404);
  assert.deepEqual(requestedPaths, ["/user.html"]);
});

test("Cloudflare worker returns 404 for retired application routes", async () => {
  const env = fakeEnv(async () => {
    throw new Error("unexpected fetch");
  });
  env.ASSETS = { fetch: async () => new Response("unexpected asset", { status: 200 }) };

  for (const path of [
    "/user",
    "/vibevoice",
    "/vibevoice/simple",
    "/vibevoice/admin",
    "/seed-vc",
    "/user.html",
    "/vibevoice.html",
    "/vibevoice_simple.html",
    "/seed_vc.html",
    "/static/user.html",
    "/static/vibevoice_simple.html",
    "/static/seed_vc.html",
  ]) {
    const response = await handleRequest(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404, path);
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

  for (const path of ["/static/index.html", "/static/practice_admin.html", "/static/vibevoice.html"]) {
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

  const blocked = await handleRequest(new Request("https://example.com/skitvoice/admin"), env);
  const cookie = await adminCookie(env, "/skitvoice/admin");
  const allowed = await handleRequest(new Request("https://example.com/skitvoice/admin", { headers: { cookie } }), env);

  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/auth/google/login?next=%2Fskitvoice%2Fadmin");
  assert.match(cookie, /mo_public_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(allowed.status, 200);
  assert.deepEqual(requestedPaths, ["/vibevoice.html"]);
});

test("Cloudflare worker protects admin APIs with the same allowlisted Google session", async () => {
  const env = adminAuthEnv(async () => {
    throw new Error("unexpected fetch");
  }, { kv: fakeKv() });
  const cookie = await adminCookie(env);

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

  const form = new FormData();
  form.append("script", "1 Hello");
  form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");
  const response = await handleRequest(new Request("https://example.com/api/vibevoice/jobs", { method: "POST", body: form }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Google login is required" });
});

test("Cloudflare worker lets a Google admin use fun generation APIs without consuming quota", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      fun: { daily_limit: 0, total_limit: 0, text_max_chars: 5, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = adminAuthEnv(async (url) => {
    calls.push(url);
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await adminCookie(env);

  const allowed = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" }),
    }),
    env,
  );
  const oversized = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ translated_text: "こんにちは！", target_language: "ja-JP" }),
    }),
    env,
  );
  const practiceForm = new FormData();
  practiceForm.append("audio", new Blob(["native"], { type: "audio/webm" }), "native.webm");
  practiceForm.append("target_language", "en-US");
  const publicFeatureUsesSameGoogleSession = await handleRequest(
    new Request("https://example.com/api/practice/prompts", {
      method: "POST",
      headers: { cookie },
      body: practiceForm,
    }),
    env,
  );

  assert.equal(allowed.status, 200);
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { detail: "text is too large" });
  assert.notEqual(publicFeatureUsesSameGoogleSession.status, 401);
  assert.equal(calls.filter((url) => url === "https://api.openai.com/v1/audio/speech").length, 1);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  const funExemption = audit.find((event) => event.action === "public_quota_exempt" && event.feature === "fun");
  assert.equal(funExemption.email, "admin@example.com");
});

test("Cloudflare worker always protects fun generation APIs with Google admin auth", async () => {
  const env = adminAuthEnv(async (url) => {
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const viewerCookie = await publicCookie(env, "/fun");
  const requestBody = JSON.stringify({ translated_text: "こんにちは", target_language: "ja-JP" });

  const unauthenticated = await handleRequest(new Request("https://example.com/api/user-text-output", {
    method: "POST",
    body: requestBody,
  }), env);
  const forbidden = await handleRequest(new Request("https://example.com/api/user-text-output", {
    method: "POST",
    headers: { cookie: viewerCookie },
    body: requestBody,
  }), env);

  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { detail: "Google admin login is required" });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { detail: "admin access is forbidden" });
});

test("Cloudflare worker always protects fun voice conversion jobs with Google admin auth", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url) => {
    calls.push(url);
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const viewerCookie = await publicCookie(env, "/fun");
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

test("Cloudflare worker protects fun job status endpoints with Google admin auth", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url) => {
    calls.push(url);
    throw new Error(`unexpected url: ${url}`);
  }, { kv: fakeKv(), googleEmail: "viewer@example.com", adminGoogleEmails: "admin@example.com" });
  const viewerCookie = await publicCookie(env, "/fun");

  for (const path of [
    "/api/translate-speech-jobs/job-translation",
    "/api/voice-conversion-jobs/job-vc",
  ]) {
    const unauthenticated = await handleRequest(new Request(`https://example.com${path}`), env);
    const forbidden = await handleRequest(
      new Request(`https://example.com${path}`, { headers: { cookie: viewerCookie } }),
      env,
    );

    assert.equal(unauthenticated.status, 401, path);
    assert.deepEqual(await unauthenticated.json(), { detail: "admin authentication required" }, path);
    assert.equal(forbidden.status, 403, path);
    assert.deepEqual(await forbidden.json(), { detail: "admin access is forbidden" }, path);
  }

  assert.deepEqual(calls, []);
});

test("Cloudflare worker stores public quota in KV and blocks non-admin overage", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      skitvoice: { daily_limit: 1, total_limit: 1, script_max_chars: 80, audio_max_bytes: 1000 },
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
    if (url.endsWith("/run")) {
      return json({ id: "quota-job", status: "IN_QUEUE" });
    }
    throw new Error(`unexpected url: ${url}`);
  }, { kv });
  const cookie = await publicCookie(env);

  const request = () => {
    const form = new FormData();
    form.append("script", "1 Hello");
    form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");
    return new Request("https://example.com/api/vibevoice/jobs", { method: "POST", headers: { cookie }, body: form });
  };
  const first = await handleRequest(request(), env);
  const second = await handleRequest(request(), env);

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { detail: "public quota exceeded" });
  assert.equal(calls.filter((call) => call.url.endsWith("/run")).length, 1);
  const audit = JSON.parse(await kv.get("public-audit-log"));
  assert.deepEqual(
    audit.map((event) => event.action),
    ["google_login_success", "public_quota_consumed", "public_quota_blocked"],
  );
  assert.equal(audit[1].feature, "skitvoice");
  assert.equal(audit[1].email, "viewer@example.com");
  assert.equal(audit[1].daily_used, 1);
  assert.equal(audit[2].limit_type, "daily");
});

test("Cloudflare worker stores quota and audit in D1 when bound", async () => {
  const kv = fakeKv();
  const db = fakeD1();
  await kv.put("public-access-settings", JSON.stringify({ google_login_required: true, features: { skitvoice: { daily_limit: 1, total_limit: 1, script_max_chars: 80, audio_max_bytes: 1000 } } }));
  const env = publicAuthEnv(async (url) => {
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return json({ email: "viewer@example.com", email_verified: true });
    if (url.endsWith("/run")) return json({ id: "quota-job", status: "IN_QUEUE" });
    throw new Error(`unexpected url: ${url}`);
  }, { kv, db });
  const cookie = await publicCookie(env);
  const request = () => {
    const form = new FormData();
    form.append("script", "1 Hello");
    form.append("voice_file_1", new Blob(["voice"], { type: "audio/wav" }), "voice.wav");
    return new Request("https://example.com/api/vibevoice/jobs", { method: "POST", headers: { cookie }, body: form });
  };

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
  }, { kv, adminGoogleEmails: "owner@example.com" });
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
    ["google_login_success", "public_access_settings_updated", "google_login_success", "public_quota_exempt"],
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

test("Cloudflare worker rejects oversized admin input before calling an external API", async () => {
  const kv = fakeKv();
  await kv.put("public-access-settings", JSON.stringify({
    google_login_required: true,
    features: {
      fun: { daily_limit: 1, total_limit: 1, text_max_chars: 5, audio_max_bytes: 1000 },
    },
  }));
  const calls = [];
  const env = adminAuthEnv(async (url) => {
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
  const cookie = await adminCookie(env);

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
  let statusCalls = 0;
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
    if (url.endsWith("/health")) {
      return json({ workers: { initializing: 1, idle: 0, running: 0 } });
    }
    if (url.endsWith("/status/vv-job")) {
      statusCalls += 1;
      if (statusCalls === 1) {
        return json({
          id: "vv-job",
          status: "IN_PROGRESS",
          delayTime: 1234,
          output: {
            stage: "loading_vibevoice_model",
            label: "VibeVoice Largeモデルを読み込んでいます",
            provider: "RunPod Serverless",
            model: "vibevoice-large-aoi-pinned",
            detail: "初回起動時は数分かかる場合があります。",
          },
        });
      }
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
  const running = await (
    await handleRequest(new Request("https://example.com/api/vibevoice/jobs/vv-job"), env)
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
  assert.equal(created.current_stage.stage, "initializing");
  assert.match(created.current_stage.label, /GPUワーカー/);
  assert.equal(running.status, "running");
  assert.equal(running.current_stage.stage, "loading_vibevoice_model");
  assert.equal(running.current_stage.model, "vibevoice-large-aoi-pinned");
  assert.match(running.current_stage.detail, /初回起動/);
  assert.equal(running.metrics.delay_time_ms, 1234);
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
  assert.match(await page.text(), /ADMIN_GOOGLE_EMAILS/);
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
  const adminCookieValue = await adminCookie(env);

  const response = await handleRequest(
    new Request("https://example.com/api/translate-speech-jobs", { method: "POST", headers: { cookie: adminCookieValue }, body: form }),
    env,
  );
  const payload = await response.json();
  const polled = await (
    await handleRequest(
      new Request(`https://example.com/api/translate-speech-jobs/${payload.job_id}`, { headers: { cookie: adminCookieValue } }),
      env,
    )
  ).json();
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
  assert.equal(history.settings.enabled, false);
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 0);
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
  assert.equal(practiceHistory.settings.enabled, false);
  assert.equal(practiceHistory.recordings.length, 0);
  assert.equal(practiceHistory.outputs.length, 0);
});

test("Cloudflare worker uses explicit attempt intent for a practice recording", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: parseJsonBody(init.body) });
    if (url === "https://api.runpod.ai/v2/endpoint/runsync") {
      return json({
        status: "COMPLETED",
        output: {
          text: "我想學習軟體開發",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [{ text: "我", start: 0, end: 0.2 }],
          segments: [{ text: "我想學習軟體開發", start: 0, end: 1.2 }],
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
    }
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
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.recording_kind, "attempt");
  assert.equal(payload.recognized_text, "我想学习软体开发");
  assert.equal("classification" in payload, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.runpod.ai/v2/endpoint/runsync");
  assert.equal(calls[0].body.input.operation_mode, "practice_asr");
  assert.equal(calls[0].body.input.source_language, "zh-CN");
  assert.equal(calls[0].body.input.audio_mime_type, "audio/webm");
  assert.equal(calls[0].body.input.audio_base64, Buffer.from("repeat").toString("base64"));
  assert.equal(payload.providers.asr, "funasr-paraformer-zh");
  assert.equal(payload.asr_model, "funasr/paraformer-zh");
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
  assert.equal(history.settings.enabled, false);
  assert.deepEqual(history.recordings, []);
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

test("Cloudflare worker routes Chinese practice attempts to RunPod FunASR", async () => {
  const calls = [];
  const env = fakeEnv(async (url, init) => {
    calls.push({ url, body: parseJsonBody(init.body) });
    if (url === "https://api.runpod.ai/v2/endpoint/runsync") {
      return json({
        status: "COMPLETED",
        output: {
          text: "你好，你最近怎麼樣?",
          model: "funasr/paraformer-zh",
          timestamp_granularities: ["word"],
          words: [
            { text: "你", start: 0.1, end: 0.2 },
            { text: "好", start: 0.2, end: 0.4 },
          ],
          segments: [{ text: "你好，你最近怎麼樣?", start: 0.1, end: 1.5 }],
          providers: { asr: "funasr-paraformer-zh" },
        },
      });
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
  assert.equal(calls[0].url, "https://api.runpod.ai/v2/endpoint/runsync");
  assert.equal(calls[0].body.input.operation_mode, "practice_asr");
  assert.equal(calls[0].body.input.source_language, "zh-CN");
  assert.equal(payload.grade, "perfect");
  assert.equal(payload.similarity, 1);
  assert.equal(payload.normalized_target, payload.normalized_recognized);
  assert.equal(payload.asr_timestamps.words[0].text, "你");
  assert.equal(payload.providers.asr, "funasr-paraformer-zh");
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
          practice_asr_contract_version: 2,
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
    throw new Error(`unexpected url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("model_audio", new Blob(["model"], { type: "audio/wav" }), "model.wav");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好吗？你今天去哪里？");

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
});

test("Cloudflare worker explains when the RunPod practice image predates the dual-audio contract", async () => {
  const env = fakeEnv(async (url) => {
    if (url === "https://api.runpod.ai/v2/endpoint/status/outdated-practice-job") {
      return json({
        id: "outdated-practice-job",
        status: "COMPLETED",
        output: {
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
  assert.match(payload.error, /practice ASR contract v2/);
  assert.match(payload.error, /再デプロイ/);
});

test("Cloudflare worker surfaces RunPod practice progress and explicit balance failures", async () => {
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
  assert.match(failed.error, /残高不足/);
  assert.match(failed.error, /Insufficient balance/);
});

test("Cloudflare worker does not silently fall back when Chinese FunASR fails", async () => {
  const calls = [];
  const env = fakeEnv(async (url) => {
    calls.push(url);
    if (url === "https://api.runpod.ai/v2/endpoint/runsync") {
      return json({ error: "FunASR unavailable" }, { status: 503 });
    }
    throw new Error(`unexpected fallback url: ${url}`);
  });
  const form = new FormData();
  form.append("audio", new Blob(["repeat"], { type: "audio/webm" }), "repeat.webm");
  form.append("target_language", "zh-CN");
  form.append("target_text", "你好。");

  const response = await handleRequest(
    new Request("https://example.com/api/practice/attempts", { method: "POST", body: form }),
    env,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["https://api.runpod.ai/v2/endpoint/runsync"]);
  assert.match(await response.text(), /FunASR unavailable/);
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
  form.append("audio_effect_audio", new Blob(["moo"], { type: "audio/mpeg" }), "cow.mp3");
  form.append("audio_effect_enabled", "true");
  form.append("audio_effect_insert_mode", "silence_or_tail");
  form.append("audio_effect_max_insertions", "2");
  form.append("audio_effect_min_silence_ms", "450");

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
  assert.equal(calls[0].body.input.audio_effect_audio_mime_type, "audio/mpeg");
  assert.equal(calls[0].body.input.audio_effect_audio_base64, Buffer.from("moo").toString("base64"));
  assert.equal(calls[0].body.input.audio_effect_insert_mode, "silence_or_tail");
  assert.equal(calls[0].body.input.audio_effect_max_insertions, 2);
  assert.equal(calls[0].body.input.audio_effect_min_silence_ms, 450);
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

test("Cloudflare worker creates user text output with OpenAI text transform and TTS", async () => {
  const calls = [];
  const env = adminAuthEnv(async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url === "https://api.openai.com/v1/responses") {
      return json({ output_text: "めっちゃこんにちは" });
    }
    if (url === "https://api.openai.com/v1/audio/speech") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const cookie = await adminCookie(env);
  const response = await handleRequest(
    new Request("https://example.com/api/user-text-output", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
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

test("Cloudflare worker does not save joke TTS output", async () => {
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
  const cookie = await adminCookie(env);

  const jokeResponse = await handleRequest(
    new Request("https://example.com/api/user-joke-output", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
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
  assert.equal(jokeResponse.status, 200);
  assert.equal(history.settings.enabled, false);
  assert.equal(history.recordings.length, 0);
  assert.equal(history.outputs.length, 0);
});

test("Cloudflare worker does not store generated audio in R2 history", async () => {
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
  assert.equal(history.settings.metadata_store, "none");
  assert.equal(history.settings.blob_store, "none");
  assert.deepEqual(history.outputs, []);
  assert.equal(r2.__store.size, 0);
});

test("Cloudflare worker leaves both KV and R2 audio history unused", async () => {
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
  assert.deepEqual(history.outputs, []);
  assert.equal(r2.__store.size, 0);
});

test("Cloudflare worker exposes no R2 history when its binding changes", async () => {
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
  const after = await (
    await handleRequest(new Request("https://example.com/api/audio-history", { headers: { cookie: adminCookieValue } }), env)
  ).json();

  assert.deepEqual(before.outputs, []);
  assert.deepEqual(after.outputs, []);
  assert.equal(r2.__store.size, 0);
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
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    PUBLIC_SESSION_SECRET: "test-public-session-secret",
    ADMIN_GOOGLE_EMAILS: options.adminGoogleEmails || "admin@example.com",
    __fetch: async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "google-access-token" });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ email: options.googleEmail || "admin@example.com", email_verified: true, name: "Admin" });
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
