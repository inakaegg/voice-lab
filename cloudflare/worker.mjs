import { pinyin } from "pinyin-pro";

const RUNPOD_DEFAULT_BASE_URL = "https://api.runpod.ai/v2";
const RUNPOD_TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const RUNPOD_RUNNING_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "RUNNING"]);
const USER_SETTINGS_KV_KEY = "user-settings";
const AUDIO_HISTORY_INDEX_KV_KEY = "audio-history:index";
const TRANSLATION_JOB_KV_PREFIX = "translation-job:";
const RUNPOD_VC_READY_KV_KEY_PREFIX = "runpod:seed-vc-ready:";
const AUDIO_HISTORY_DEFAULT_LIMIT = 100;
const AUDIO_HISTORY_KINDS = new Set(["recordings", "outputs"]);
const ADMIN_SESSION_COOKIE = "mo_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24;
const PUBLIC_ACCESS_SETTINGS_KV_KEY = "public-access-settings";
const PUBLIC_AUDIT_LOG_KV_KEY = "public-audit-log";
const PUBLIC_AUDIT_LOG_DEFAULT_LIMIT = 500;
const PUBLIC_SAMPLE_AUDIOS_KV_KEY = "public-sample-audios";
const PUBLIC_SAMPLE_AUDIO_MAX_BASE64_CHARS = 2_500_000;
const PUBLIC_USAGE_KV_PREFIX = "public-usage:";
const PUBLIC_SESSION_COOKIE = "mo_public_session";
const PUBLIC_OAUTH_STATE_COOKIE = "mo_google_oauth_state";
const PUBLIC_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PUBLIC_OAUTH_STATE_TTL_SECONDS = 60 * 10;
const PUBLIC_ACCESS_FEATURES = ["speakloop", "skitvoice", "fun", "voice_conversion"];
const OPENAI_LANGUAGE_CODES = {
  auto: "",
  "id-ID": "id",
  "ja-JP": "ja",
  "zh-CN": "zh",
  "en-US": "en",
};
const OPENAI_LANGUAGE_NAMES = {
  "id-ID": "Indonesian",
  "ja-JP": "Japanese",
  "zh-CN": "Chinese",
  "en-US": "English",
};
const OPENAI_PRACTICE_ASR_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
const OPENAI_DEFAULT_PRACTICE_ASR_MODEL = "whisper-1";
const OPENAI_TIMESTAMP_ASR_MODELS = new Set(["whisper-1"]);
const OPENAI_JSON_ONLY_ASR_MODELS = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
const PRACTICE_TARGET_LANGUAGES = {
  "ja-JP": { label: "日本語", speech_name: "Japanese" },
  "zh-CN": { label: "中文", speech_name: "Mandarin Chinese" },
  "en-US": { label: "English", speech_name: "English" },
};
const VIBEVOICE_OUTPUT_LANGUAGES = {
  "en-US": { label: "英語", speech_name: "English" },
  "zh-CN": { label: "中国語", speech_name: "Chinese" },
  "ja-JP": { label: "日本語（低品質）", speech_name: "Japanese" },
};
const PRACTICE_GRADE_LABELS = {
  perfect: "できました",
  ok: "いいかんじ",
  almost: "まあまあ",
  retry: "もう一回",
};
const ZH_TRADITIONAL_TO_SIMPLIFIED = {
  後: "后",
  裏: "里",
  裡: "里",
  著: "着",
  麼: "么",
  麽: "么",
  樣: "样",
  嗎: "吗",
  妳: "你",
  們: "们",
  個: "个",
  這: "这",
  會: "会",
  說: "说",
  話: "话",
  語: "语",
  學: "学",
  習: "习",
  聽: "听",
  問: "问",
  題: "题",
  現: "现",
  開: "开",
  關: "关",
  見: "见",
  歡: "欢",
  愛: "爱",
  買: "买",
  賣: "卖",
  車: "车",
  輛: "辆",
  價: "价",
  還: "还",
  貴: "贵",
  綠: "绿",
  種: "种",
  點: "点",
  氣: "气",
  電: "电",
  腦: "脑",
  網: "网",
  寫: "写",
  讀: "读",
  書: "书",
  時: "时",
  間: "间",
  國: "国",
  東: "东",
  風: "风",
  來: "来",
  過: "过",
  長: "长",
  門: "门",
  無: "无",
  實: "实",
  體: "体",
  應: "应",
  讓: "让",
  給: "给",
  對: "对",
  從: "从",
  為: "为",
  發: "发",
  聲: "声",
  區: "区",
  別: "别",
  當: "当",
  幾: "几",
  難: "难",
  簡: "简",
  漢: "汉",
  雖: "虽",
  舊: "旧",
};

const DEFAULT_USER_SETTINGS = {
  target_language: "ja-JP",
  joke_text: "",
  joke_texts: [],
  joke_position: "after",
  joke_selection: "rotation",
  joke_variation_count: 0,
  joke_variants: [],
  joke_pool: [],
  effect_audios: [],
  effect_selection: "rotation",
  effect_insert_mode: "silence_or_tail",
  effect_max_insertions: 1,
  effect_min_silence_ms: 300,
  theme: "blue",
};

const DEFAULT_PUBLIC_ACCESS_SETTINGS = {
  google_login_required: false,
  admin_google_emails: [],
  features: {
    speakloop: {
      daily_limit: 20,
      total_limit: 200,
      audio_max_bytes: 8_000_000,
      text_max_chars: 800,
    },
    skitvoice: {
      daily_limit: 2,
      total_limit: 20,
      audio_max_bytes: 10_000_000,
      script_max_chars: 1600,
    },
    fun: {
      daily_limit: 10,
      total_limit: 100,
      audio_max_bytes: 8_000_000,
      text_max_chars: 1000,
    },
    voice_conversion: {
      daily_limit: 3,
      total_limit: 30,
      audio_max_bytes: 10_000_000,
      text_max_chars: 0,
    },
  },
};

const DEFAULT_PUBLIC_SAMPLE_AUDIOS = {
  features: {
    speakloop: null,
    skitvoice: null,
    fun: null,
    voice_conversion: null,
  },
};

let ephemeralUserSettings = null;
let ephemeralPublicAccessSettings = null;
const ephemeralTranslationJobs = new Map();
const ephemeralPublicUsage = new Map();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (isPublicAuthPath(url.pathname)) {
    return handlePublicAuthRequest(request, env, url);
  }
  if (isAdminAuthPath(url.pathname)) {
    return handleAdminAuthRequest(request, env, url);
  }
  if (url.pathname.startsWith("/api/")) {
    if (isProtectedAdminApiRequest(request.method, url.pathname)) {
      const authResponse = await adminApiAuthResponse(request, env);
      if (authResponse) {
        return authResponse;
      }
    }
    return handleApiRequest(request, env, ctx, url);
  }
  if (isProtectedAdminPagePath(url.pathname)) {
    const authResponse = await adminPageAuthResponse(request, env, url);
    if (authResponse) {
      return authResponse;
    }
  }
  return serveAsset(request, env, url);
}

function isAdminAuthPath(pathname) {
  return pathname === "/admin/login" || pathname === "/admin/login/" || pathname === "/admin/logout" || pathname === "/admin/logout/";
}

function isPublicAuthPath(pathname) {
  const path = normalizePathname(pathname);
  return path === "/auth/google/login" || path === "/auth/google/callback" || path === "/auth/logout";
}

function isProtectedAdminPagePath(pathname) {
  const path = normalizePathname(pathname);
  return new Set([
    "/admin",
    "/index.html",
    "/skitvoice/admin",
    "/vibevoice/admin",
    "/vibevoice.html",
    "/speakloop/admin",
    "/practice/admin",
    "/practice_admin.html",
  ]).has(path);
}

function isProtectedAdminApiRequest(method, pathname) {
  if (method === "OPTIONS") {
    return false;
  }
  if (method === "PUT" && pathname === "/api/user-settings") {
    return true;
  }
  if ((method === "GET" || method === "PUT") && pathname === "/api/public-access-settings") {
    return true;
  }
  if (method === "PUT" && pathname === "/api/public-sample-audios") {
    return true;
  }
  if (method === "DELETE" && pathname.startsWith("/api/public-sample-audios/")) {
    return true;
  }
  if (method === "GET" && pathname === "/api/audio-history") {
    return true;
  }
  if ((method === "GET" || method === "DELETE") && pathname.startsWith("/api/audio-history/")) {
    return true;
  }
  if (method === "GET" && pathname === "/api/practice-history") {
    return true;
  }
  if (method === "GET" && pathname === "/api/public-audit-log") {
    return true;
  }
  if (method === "POST" && pathname === "/api/warmup") {
    return true;
  }
  if (method === "GET" && pathname.startsWith("/api/warmup/")) {
    return true;
  }
  return false;
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

async function adminPageAuthResponse(request, env, url) {
  if (!adminAuthConfigured(env)) {
    return adminSetupErrorResponse();
  }
  if (await hasValidAdminSession(request, env)) {
    return null;
  }
  return redirectResponse(`/admin/login?next=${encodeURIComponent(url.pathname)}`);
}

async function adminApiAuthResponse(request, env) {
  if (!adminAuthConfigured(env)) {
    return jsonResponse({ detail: "admin authentication is not configured" }, { status: 503 });
  }
  if (await hasValidAdminSession(request, env)) {
    return null;
  }
  return jsonResponse({ detail: "admin authentication required" }, { status: 401 });
}

async function handleAdminAuthRequest(request, env, url) {
  if (url.pathname === "/admin/logout" || url.pathname === "/admin/logout/") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/admin/login",
        "Set-Cookie": expiredAdminCookie(),
      },
    });
  }
  if (!adminAuthConfigured(env)) {
    return adminSetupErrorResponse();
  }
  if (request.method === "GET") {
    return adminLoginPage(url.searchParams.get("next") || "/admin");
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  const form = await request.formData();
  const password = String(form.get("password") || "");
  const next = safeAdminNextPath(String(form.get("next") || url.searchParams.get("next") || "/admin"));
  if (!(await adminPasswordMatches(password, env))) {
    return adminLoginPage(next, "パスワードが違います。", 401);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      "Set-Cookie": await createAdminSessionCookie(env),
    },
  });
}

function adminAuthConfigured(env) {
  return Boolean(adminPasswordHash(env) && env.ADMIN_SESSION_SECRET);
}

function adminPasswordHash(env) {
  return String(env.ADMIN_PASSWORD_SHA256 || env.ADMIN_PASSWORD_HASH || "").trim().toLowerCase();
}

async function adminPasswordMatches(password, env) {
  const expected = adminPasswordHash(env);
  if (!expected) {
    return false;
  }
  const actual = await sha256Hex(password);
  return constantTimeEqual(actual, expected);
}

async function hasValidAdminSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const value = cookies.get(ADMIN_SESSION_COOKIE);
  if (!value || !env.ADMIN_SESSION_SECRET) {
    return false;
  }
  const [payload, signature] = value.split(".");
  if (!payload || !signature) {
    return false;
  }
  const expectedSignature = await hmacSha256Hex(payload, env.ADMIN_SESSION_SECRET);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }
  try {
    const session = JSON.parse(base64UrlDecodeToString(payload));
    return Number(session.exp || 0) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function createAdminSessionCookie(env) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.ADMIN_SESSION_TTL_SECONDS || ADMIN_SESSION_TTL_SECONDS) || ADMIN_SESSION_TTL_SECONDS;
  const payload = base64UrlEncodeString(JSON.stringify({ iat: now, exp: now + ttl }));
  const signature = await hmacSha256Hex(payload, env.ADMIN_SESSION_SECRET);
  return `${ADMIN_SESSION_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`;
}

function expiredAdminCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function safeAdminNextPath(next) {
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/admin";
  }
  try {
    const path = new URL(next, "https://example.com").pathname;
    return isProtectedAdminPagePath(path) ? path : "/admin";
  } catch {
    return "/admin";
  }
}

function adminSetupErrorResponse() {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><title>Admin auth setup required</title><h1>管理認証が未設定です</h1><p>Cloudflare Worker secret の ADMIN_PASSWORD_SHA256 と ADMIN_SESSION_SECRET を設定してください。</p>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function adminLoginPage(next, errorMessageText = "", status = 200) {
  const safeNext = safeAdminNextPath(next || "/admin");
  const errorHtml = errorMessageText ? `<p class="error">${escapeHtml(errorMessageText)}</p>` : "";
  return new Response(
    `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>管理ログイン</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #172026; }
    main { width: min(92vw, 380px); padding: 28px; background: white; border: 1px solid #d7dce2; border-radius: 8px; box-shadow: 0 12px 30px rgba(16, 24, 40, 0.08); }
    h1 { margin: 0 0 18px; font-size: 22px; }
    label { display: grid; gap: 8px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid #b8c0cc; border-radius: 6px; font-size: 16px; }
    button { width: 100%; min-height: 44px; margin-top: 16px; border: 0; border-radius: 6px; background: #1d4ed8; color: white; font-weight: 700; font-size: 16px; cursor: pointer; }
    .error { color: #b42318; font-weight: 700; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      main { background: #1f2937; border-color: #374151; }
      input { background: #111827; color: #f9fafb; border-color: #4b5563; }
    }
  </style>
</head>
<body>
  <main>
    <h1>管理ログイン</h1>
    ${errorHtml}
    <form method="post" action="/admin/login">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
      <label>
        パスワード
        <input type="password" name="password" autocomplete="current-password" required autofocus />
      </label>
      <button type="submit">ログイン</button>
    </form>
  </main>
</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function handlePublicAuthRequest(request, env, url) {
  try {
    const path = normalizePathname(url.pathname);
    if (path === "/auth/logout") {
      const session = await readPublicSession(request, env);
      if (session) {
        await appendPublicAuditEvent(env, {
          action: "google_logout",
          email: session.email,
          ...requestAuditContext(request),
        });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: safePublicNextPath(url.searchParams.get("next") || "/"),
          "Set-Cookie": expiredCookie(PUBLIC_SESSION_COOKIE),
        },
      });
    }
    if (!publicGoogleAuthConfigured(env)) {
      return jsonResponse({ detail: "Google login is not configured" }, { status: 503 });
    }
    if (path === "/auth/google/login") {
      return createGoogleLoginRedirect(env, url);
    }
    if (path === "/auth/google/callback") {
      return handleGoogleCallback(request, env, url);
    }
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

function publicGoogleAuthConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && publicSessionSecret(env));
}

function publicSessionSecret(env) {
  return String(env.PUBLIC_SESSION_SECRET || env.ADMIN_SESSION_SECRET || "").trim();
}

async function createGoogleLoginRedirect(env, url) {
  const next = safePublicNextPath(url.searchParams.get("next") || "/");
  const now = Math.floor(Date.now() / 1000);
  const state = await createSignedPayload({
    next,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + PUBLIC_OAUTH_STATE_TTL_SECONDS,
  }, publicSessionSecret(env));
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri(url));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `${PUBLIC_OAUTH_STATE_COOKIE}=${state}; Path=/; Max-Age=${PUBLIC_OAUTH_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function handleGoogleCallback(request, env, url) {
  const code = String(url.searchParams.get("code") || "");
  const state = String(url.searchParams.get("state") || "");
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const stateCookie = cookies.get(PUBLIC_OAUTH_STATE_COOKIE) || "";
  if (!code || !state || !stateCookie || !constantTimeEqual(state, stateCookie)) {
    throw httpError(400, "invalid Google OAuth state");
  }
  const statePayload = await verifySignedPayload(state, publicSessionSecret(env));
  const token = await exchangeGoogleOAuthCode(env, code, googleRedirectUri(url));
  const userInfo = await fetchGoogleUserInfo(env, token.access_token);
  const email = normalizeEmail(userInfo.email);
  if (!email || userInfo.email_verified === false) {
    throw httpError(403, "Google account email is not verified");
  }
  const sessionCookie = await createPublicSessionCookie(env, {
    email,
    name: String(userInfo.name || ""),
    picture: String(userInfo.picture || ""),
  });
  const settings = await readPublicAccessSettings(env);
  await appendPublicAuditEvent(env, {
    action: "google_login_success",
    email,
    is_admin: isPublicAdminEmail(email, settings),
    next: safePublicNextPath(statePayload.next || "/"),
    ...requestAuditContext(request),
  });
  const headers = new Headers({ Location: safePublicNextPath(statePayload.next || "/") });
  headers.append("Set-Cookie", sessionCookie);
  headers.append("Set-Cookie", expiredCookie(PUBLIC_OAUTH_STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

async function exchangeGoogleOAuthCode(env, code, redirectUri) {
  const response = await runtimeFetch(env)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw httpError(response.status || 502, body.error_description || body.error || "Google OAuth token exchange failed");
  }
  return body;
}

async function fetchGoogleUserInfo(env, accessToken) {
  const response = await runtimeFetch(env)("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, body.error_description || body.error || "Google userinfo request failed");
  }
  return body;
}

function googleRedirectUri(url) {
  return new URL("/auth/google/callback", url.origin).toString();
}

function safePublicNextPath(next) {
  if (!next || !String(next).startsWith("/") || String(next).startsWith("//")) {
    return "/";
  }
  try {
    const parsed = new URL(String(next), "https://example.com");
    const path = normalizePathname(parsed.pathname);
    if (path.includes("/admin") || path === "/index.html" || path.startsWith("/api/") || path.startsWith("/auth/")) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

async function createPublicSessionCookie(env, user) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.PUBLIC_SESSION_TTL_SECONDS || PUBLIC_SESSION_TTL_SECONDS) || PUBLIC_SESSION_TTL_SECONDS;
  const value = await createSignedPayload({
    email: normalizeEmail(user.email),
    name: String(user.name || ""),
    picture: String(user.picture || ""),
    iat: now,
    exp: now + ttl,
  }, publicSessionSecret(env));
  return `${PUBLIC_SESSION_COOKIE}=${value}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`;
}

async function readPublicSession(request, env) {
  const secret = publicSessionSecret(env);
  if (!secret) {
    return null;
  }
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const value = cookies.get(PUBLIC_SESSION_COOKIE);
  if (!value) {
    return null;
  }
  try {
    const payload = await verifySignedPayload(value, secret);
    const email = normalizeEmail(payload.email);
    if (!email) {
      return null;
    }
    return {
      email,
      name: String(payload.name || ""),
      picture: String(payload.picture || ""),
      exp: Number(payload.exp || 0),
    };
  } catch {
    return null;
  }
}

async function createSignedPayload(payload, secret) {
  const encoded = base64UrlEncodeString(JSON.stringify(payload || {}));
  const signature = await hmacSha256Hex(encoded, secret);
  return `${encoded}.${signature}`;
}

async function verifySignedPayload(value, secret) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) {
    throw httpError(400, "invalid signed payload");
  }
  const expectedSignature = await hmacSha256Hex(payload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw httpError(400, "invalid signed payload");
  }
  const parsed = JSON.parse(base64UrlDecodeToString(payload));
  if (Number(parsed.exp || 0) <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, "signed payload expired");
  }
  return parsed;
}

function expiredCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) {
      continue;
    }
    cookies.set(name, valueParts.join("="));
  }
  return cookies;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bufferToHex(digest);
}

async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return bufferToHex(signature);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function base64UrlEncodeString(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function handleApiRequest(request, env, ctx, url) {
  try {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/api/runtime") {
      return jsonResponse(await runtimePayload(env));
    }
    if (request.method === "GET" && url.pathname === "/api/user-settings") {
      return jsonResponse(await readUserSettings(env));
    }
    if (request.method === "PUT" && url.pathname === "/api/user-settings") {
      const payload = await request.json();
      return jsonResponse(await writeUserSettings(payload, env));
    }
    if (request.method === "GET" && url.pathname === "/api/public-session") {
      return jsonResponse(await publicSessionPayload(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/public-sample-audios") {
      return jsonResponse(await readPublicSampleAudios(env));
    }
    if (request.method === "GET" && url.pathname === "/api/public-access-settings") {
      return jsonResponse(await readPublicAccessSettings(env));
    }
    if (request.method === "PUT" && url.pathname === "/api/public-access-settings") {
      const payload = await request.json();
      const settings = await writePublicAccessSettings(payload, env);
      await appendPublicAuditEvent(env, {
        action: "public_access_settings_updated",
        ...requestAuditContext(request),
      });
      return jsonResponse(settings);
    }
    if (request.method === "GET" && url.pathname === "/api/public-audit-log") {
      return jsonResponse(await readPublicAuditLog(env, url));
    }
    if (request.method === "PUT" && url.pathname === "/api/public-sample-audios") {
      const payload = await request.json();
      const samples = await writePublicSampleAudios(payload, env);
      await appendPublicAuditEvent(env, {
        action: "public_sample_audios_updated",
        ...requestAuditContext(request),
      });
      return jsonResponse(samples);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/public-sample-audios/")) {
      const feature = decodeURIComponent(url.pathname.slice("/api/public-sample-audios/".length));
      const samples = await deletePublicSampleAudioFeature(feature, env);
      await appendPublicAuditEvent(env, {
        action: "public_sample_audio_deleted",
        feature,
        ...requestAuditContext(request),
      });
      return jsonResponse(samples);
    }
    if (request.method === "GET" && url.pathname === "/api/audio-history") {
      return jsonResponse(await listAudioHistory(env));
    }
    if (request.method === "GET" && url.pathname === "/api/practice-history") {
      return jsonResponse(await listPracticeHistory(env));
    }
    if (request.method === "POST" && url.pathname === "/api/audio-history/outputs") {
      return jsonResponse(await saveUploadedAudioHistoryOutput(request, env));
    }
    if ((request.method === "GET" || request.method === "DELETE") && url.pathname.startsWith("/api/audio-history/")) {
      const [, , , kind, filename] = url.pathname.split("/");
      if (request.method === "GET") {
        return getAudioHistoryFile(kind, decodeURIComponent(filename || ""), env);
      }
      return jsonResponse(await deleteAudioHistoryFile(kind, decodeURIComponent(filename || ""), env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-display-text") {
      const payload = await request.json();
      const text = String(payload.text || "").trim();
      const targetLanguage = String(payload.target_language || "ja-JP");
      if (text && targetLanguage === "ja-JP") {
        await enforcePublicFeatureAccess(request, env, "fun", { textChars: text.length });
      }
      return jsonResponse(await createUserDisplayText(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-text-output") {
      const payload = await request.json();
      await enforcePublicFeatureAccess(request, env, "fun", {
        textChars: String(payload.translated_text || "").trim().length,
      });
      return jsonResponse(await createUserTextOutput(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/user-joke-output") {
      const payload = await request.json();
      await enforcePublicFeatureAccess(request, env, "fun", {
        textChars: String(payload.text || "").trim().length,
      });
      return jsonResponse(await createUserJokeOutput(payload, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/prompts") {
      return jsonResponse(await createPracticePrompt(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/recordings") {
      return jsonResponse(await createPracticeRecording(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/practice/attempts") {
      return jsonResponse(await createPracticeAttempt(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/vibevoice/status") {
      return jsonResponse(await vibeVoiceStatus(env));
    }
    if (request.method === "POST" && url.pathname === "/api/vibevoice/reference-audio-from-url") {
      return jsonResponse(await createVibeVoiceReferenceAudioFromUrl(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/vibevoice/jobs") {
      return jsonResponse(await createVibeVoiceJob(request, env));
    }
    if (request.method === "GET" && /^\/api\/vibevoice\/jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "vibevoice"));
    }
    if (request.method === "POST" && /^\/api\/vibevoice\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const jobId = decodeURIComponent(parts[parts.length - 2] || "");
      return jsonResponse(await cancelRunpodJob(jobId, env, "vibevoice"));
    }
    if (request.method === "POST" && url.pathname === "/api/translate-speech-jobs") {
      return jsonResponse(await createTranslationJob(request, env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/translate-speech-jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getTranslationJobSnapshot(jobId, env));
    }
    if (request.method === "POST" && url.pathname === "/api/voice-conversion-jobs") {
      return jsonResponse(await createVoiceConversionJob(request, env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/voice-conversion-jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "voice_conversion"));
    }
    if (request.method === "POST" && url.pathname === "/api/warmup") {
      return jsonResponse(await createWarmupJob(env));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/warmup/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      return jsonResponse(await getRunpodJobSnapshot(jobId, env, "warmup"));
    }
    return jsonResponse({ detail: "not found" }, { status: 404 });
  } catch (error) {
    return jsonResponse({ detail: errorMessage(error) }, { status: error.status || 500 });
  }
}

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return new Response("Cloudflare static assets binding is not configured.", { status: 503 });
  }
  const assetUrl = new URL(request.url);
  if (url.pathname === "/") {
    assetUrl.pathname = "/portal.html";
  } else if (url.pathname === "/fun" || url.pathname === "/fun/" || url.pathname === "/user" || url.pathname === "/user/") {
    assetUrl.pathname = "/user.html";
  } else if (url.pathname === "/practice" || url.pathname === "/practice/" || url.pathname === "/speakloop" || url.pathname === "/speakloop/") {
    assetUrl.pathname = "/practice.html";
  } else if (
    url.pathname === "/practice/admin" ||
    url.pathname === "/practice/admin/" ||
    url.pathname === "/speakloop/admin" ||
    url.pathname === "/speakloop/admin/"
  ) {
    assetUrl.pathname = "/practice_admin.html";
  } else if (url.pathname === "/vibevoice" || url.pathname === "/vibevoice/" || url.pathname === "/skitvoice" || url.pathname === "/skitvoice/") {
    assetUrl.pathname = "/vibevoice_simple.html";
  } else if (
    url.pathname === "/vibevoice/admin" ||
    url.pathname === "/vibevoice/admin/" ||
    url.pathname === "/skitvoice/admin" ||
    url.pathname === "/skitvoice/admin/"
  ) {
    assetUrl.pathname = "/vibevoice.html";
  } else if (url.pathname === "/seed-vc" || url.pathname === "/seed-vc/") {
    assetUrl.pathname = "/seed_vc.html";
  } else if (url.pathname === "/admin" || url.pathname === "/admin/") {
    assetUrl.pathname = "/index.html";
  } else if (url.pathname.startsWith("/static/")) {
    assetUrl.pathname = `/${url.pathname.slice("/static/".length)}`;
  }
  return env.ASSETS.fetch(
    new Request(assetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
    }),
  );
}

async function runtimePayload(env) {
  const runpodAvailable = Boolean(env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY);
  const openaiAvailable = Boolean(env.OPENAI_API_KEY);
  const health = runpodAvailable && env.RUNPOD_RUNTIME_HEALTH_CHECK !== "0"
    ? await runpodHealthSummary(env)
    : { checked: false, warm: false, worker_counts: {} };
  const warmup = {
    ...(runpodAvailable ? await readRunpodVcReadyState(env) : runpodVcReadyState(false)),
    auto_on_user_page_load: Boolean(runpodAvailable && env.RUNPOD_AUTO_WARMUP_ON_USER_LOAD === "1"),
  };
  const seedVcModelResident = Boolean(warmup.ready);
  return {
    provider_mode: "cloudflare",
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    supported_voice_modes: ["default", "convert"],
    translation_backends: [
      {
        id: "openai",
        label: "音声翻訳（Cloudflare + OpenAI API）",
        available: openaiAvailable,
        reason: openaiAvailable ? "" : "OPENAI_API_KEY が設定されていません。",
        providers: {
          asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
          translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
          tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_source_languages: ["auto", "id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_target_languages: ["id-ID", "ja-JP", "zh-CN", "en-US"],
          supported_voice_modes: ["default"],
          text_transform: true,
          request_mode: "completed_job",
          gateway: "cloudflare",
        },
      },
      {
        id: "runpod_serverless",
        label: "音声翻訳（RunPod Serverless）",
        available: false,
        reason: "Cloudflareデモでは音声翻訳をOpenAI API、RunPodをSeed-VC専用にします。",
        providers: {
          asr: "runpod-serverless-asr",
          translation: "runpod-serverless-translation",
          tts: "runpod-serverless-tts",
        },
        settings: {
          source_language_mode: "specified_or_auto",
          supported_voice_modes: ["default", "convert"],
          text_transform: true,
          serverless: true,
          health,
        },
      },
    ],
    text_tts_backends: [
      {
        id: "openai",
        label: "OpenAI TTS API",
        available: openaiAvailable,
        reason: openaiAvailable ? "" : "OPENAI_API_KEY が設定されていません。",
        provider: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
        settings: {
          supported_target_languages: ["auto", "id-ID", "ja-JP", "zh-CN", "en-US"],
          official_api: true,
        },
      },
    ],
    voice_conversion_backends: [
      {
        id: "seed-vc",
        label: "Seed-VC",
        provider: "RunPod Serverless Seed-VC",
        available: runpodAvailable,
        reason: runpodAvailable ? "" : "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
        settings: {
          seed_vc: {
            execution_mode: "resident",
            model_resident: seedVcModelResident,
            diffusion_steps: numberFromEnv(env.SEED_VC_DIFFUSION_STEPS, 8),
            reference_max_seconds: numberFromEnv(env.SEED_VC_REFERENCE_MAX_SECONDS, 12),
            reference_auto_select: true,
          },
          warmup,
          health,
        },
      },
    ],
  };
}

async function runpodHealthSummary(env) {
  try {
    const body = await runpodRequest(env, "/health", { method: "GET", timeoutMs: 3000 });
    const workerCounts = workerCountsFromHealth(body.workers);
    return {
      checked: true,
      warm: Object.entries(workerCounts).some(([state, count]) =>
        ["IDLE", "RUNNING", "READY", "INITIALIZED"].includes(state) && count > 0
      ),
      worker_counts: workerCounts,
    };
  } catch (error) {
    return {
      checked: true,
      warm: false,
      worker_counts: {},
      error: errorMessage(error),
    };
  }
}

function workerCountsFromHealth(workers) {
  const counts = {};
  if (Array.isArray(workers)) {
    for (const worker of workers) {
      const state = String(worker?.state || worker?.status || "UNKNOWN").toUpperCase();
      counts[state] = (counts[state] || 0) + 1;
    }
    return counts;
  }
  if (workers && typeof workers === "object") {
    for (const [key, value] of Object.entries(workers)) {
      if (typeof value === "number") {
        counts[String(key).toUpperCase()] = value;
      }
    }
  }
  return counts;
}

async function readUserSettings(env) {
  const kv = stateKv(env);
  if (kv) {
    const stored = await kvGetJson(kv, USER_SETTINGS_KV_KEY, null);
    if (stored && typeof stored === "object") {
      return coerceUserSettings(stored);
    }
  }
  if (ephemeralUserSettings) {
    return ephemeralUserSettings;
  }
  if (env.USER_SETTINGS_JSON) {
    try {
      return coerceUserSettings(JSON.parse(env.USER_SETTINGS_JSON));
    } catch (_error) {
      return DEFAULT_USER_SETTINGS;
    }
  }
  return DEFAULT_USER_SETTINGS;
}

async function writeUserSettings(payload, env) {
  const settings = await prepareUserSettingsForWrite(payload, env);
  const kv = stateKv(env);
  if (kv) {
    await kv.put(USER_SETTINGS_KV_KEY, JSON.stringify(settings));
  } else {
    ephemeralUserSettings = settings;
  }
  return settings;
}

async function readPublicAccessSettings(env) {
  const kv = stateKv(env);
  let stored = null;
  if (kv) {
    stored = await kvGetJson(kv, PUBLIC_ACCESS_SETTINGS_KV_KEY, null);
  } else if (ephemeralPublicAccessSettings) {
    stored = ephemeralPublicAccessSettings;
  } else if (env.PUBLIC_ACCESS_SETTINGS_JSON) {
    try {
      stored = JSON.parse(env.PUBLIC_ACCESS_SETTINGS_JSON);
    } catch (_error) {
      stored = null;
    }
  }
  const envDefaults = {
    google_login_required: env.PUBLIC_GOOGLE_AUTH_REQUIRED === "1",
    admin_google_emails: coerceEmailList(env.ADMIN_GOOGLE_EMAILS),
  };
  const settings = coercePublicAccessSettings(mergePublicAccessSettings(DEFAULT_PUBLIC_ACCESS_SETTINGS, envDefaults, stored || {}));
  settings.admin_google_emails = uniqueEmails([
    ...settings.admin_google_emails,
    ...coerceEmailList(env.ADMIN_GOOGLE_EMAILS),
  ]);
  return settings;
}

async function writePublicAccessSettings(payload, env) {
  const settings = coercePublicAccessSettings(payload);
  const kv = stateKv(env);
  if (kv) {
    await kv.put(PUBLIC_ACCESS_SETTINGS_KV_KEY, JSON.stringify(settings));
  } else {
    ephemeralPublicAccessSettings = settings;
  }
  return readPublicAccessSettings(env);
}

async function readPublicSampleAudios(env) {
  const kv = stateKv(env);
  let stored = null;
  if (kv) {
    stored = await kvGetJson(kv, PUBLIC_SAMPLE_AUDIOS_KV_KEY, null);
  } else if (env.PUBLIC_SAMPLE_AUDIOS_JSON) {
    try {
      stored = JSON.parse(env.PUBLIC_SAMPLE_AUDIOS_JSON);
    } catch (_error) {
      stored = null;
    }
  }
  return coercePublicSampleAudios(stored || DEFAULT_PUBLIC_SAMPLE_AUDIOS);
}

async function writePublicSampleAudios(payload, env) {
  const samples = coercePublicSampleAudios(payload);
  const kv = stateKv(env);
  if (kv) {
    await kv.put(PUBLIC_SAMPLE_AUDIOS_KV_KEY, JSON.stringify(samples));
  }
  return samples;
}

async function deletePublicSampleAudioFeature(feature, env) {
  if (!PUBLIC_ACCESS_FEATURES.includes(feature)) {
    throw httpError(404, "sample audio feature is not found");
  }
  const samples = await readPublicSampleAudios(env);
  samples.features[feature] = null;
  return writePublicSampleAudios(samples, env);
}

function coercePublicSampleAudios(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const features = source.features && typeof source.features === "object" ? source.features : source;
  const normalized = { features: {} };
  for (const feature of PUBLIC_ACCESS_FEATURES) {
    normalized.features[feature] = coercePublicSampleAudio(features[feature]);
  }
  return normalized;
}

function coercePublicSampleAudio(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const audioBase64 = String(raw.audio_base64 || "").replace(/\s/g, "");
  if (!audioBase64) {
    return null;
  }
  if (audioBase64.length > PUBLIC_SAMPLE_AUDIO_MAX_BASE64_CHARS) {
    throw httpError(413, "sample audio is too large");
  }
  const mimeType = normalizeMimeType(raw.audio_mime_type || "audio/wav") || "audio/wav";
  if (!mimeType.startsWith("audio/")) {
    throw httpError(400, "sample audio MIME type is not supported");
  }
  return {
    title: String(raw.title || "").trim().slice(0, 80) || "サンプル音声",
    description: String(raw.description || "").trim().slice(0, 300),
    filename: safeHistoryToken(raw.filename || `sample.${extensionForMimeType(mimeType)}`),
    audio_mime_type: mimeType,
    audio_base64: audioBase64,
    size_bytes: base64ByteLength(audioBase64),
  };
}

function mergePublicAccessSettings(...items) {
  const merged = structuredClone(DEFAULT_PUBLIC_ACCESS_SETTINGS);
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(item, "google_login_required")) {
      merged.google_login_required = Boolean(item.google_login_required);
    }
    if (Object.prototype.hasOwnProperty.call(item, "admin_google_emails")) {
      merged.admin_google_emails = coerceEmailList(item.admin_google_emails);
    }
    const features = item.features && typeof item.features === "object" ? item.features : item;
    for (const feature of PUBLIC_ACCESS_FEATURES) {
      if (features[feature] && typeof features[feature] === "object") {
        merged.features[feature] = {
          ...merged.features[feature],
          ...features[feature],
        };
      }
    }
  }
  return merged;
}

function coercePublicAccessSettings(payload = {}) {
  const merged = mergePublicAccessSettings(DEFAULT_PUBLIC_ACCESS_SETTINGS, payload);
  const settings = {
    google_login_required: Boolean(merged.google_login_required),
    admin_google_emails: coerceEmailList(merged.admin_google_emails),
    features: {},
  };
  for (const feature of PUBLIC_ACCESS_FEATURES) {
    const defaults = DEFAULT_PUBLIC_ACCESS_SETTINGS.features[feature];
    const raw = merged.features[feature] || {};
    settings.features[feature] = {
      daily_limit: clampInt(raw.daily_limit, -1, 100000, defaults.daily_limit),
      total_limit: clampInt(raw.total_limit, -1, 1000000, defaults.total_limit),
      audio_max_bytes: clampInt(raw.audio_max_bytes, 0, 100_000_000, defaults.audio_max_bytes),
      text_max_chars: clampInt(raw.text_max_chars, 0, 100_000, defaults.text_max_chars || 0),
    };
    if (Object.prototype.hasOwnProperty.call(defaults, "script_max_chars")) {
      settings.features[feature].script_max_chars = clampInt(
        raw.script_max_chars,
        0,
        100_000,
        defaults.script_max_chars,
      );
    }
    if (Object.prototype.hasOwnProperty.call(defaults, "reference_url_duration_max_seconds")) {
      settings.features[feature].reference_url_duration_max_seconds = clampInt(
        raw.reference_url_duration_max_seconds,
        1,
        600,
        defaults.reference_url_duration_max_seconds,
      );
    }
  }
  return settings;
}

async function publicSessionPayload(request, env) {
  const settings = await readPublicAccessSettings(env);
  const session = await readPublicSession(request, env);
  const isAdmin = Boolean(session && isPublicAdminEmail(session.email, settings));
  return {
    google_login_required: Boolean(settings.google_login_required),
    google_login_configured: publicGoogleAuthConfigured(env),
    authenticated: Boolean(session),
    email: session?.email || "",
    name: session?.name || "",
    picture: session?.picture || "",
    is_admin: isAdmin,
    login_url: `/auth/google/login?next=${encodeURIComponent(new URL(request.url).pathname)}`,
    logout_url: "/auth/logout",
    features: settings.features,
  };
}

function coerceEmailList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return uniqueEmails(source.map(normalizeEmail).filter(Boolean));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueEmails(values) {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))].slice(0, 100);
}

function isPublicAdminEmail(email, settings) {
  return settings.admin_google_emails.includes(normalizeEmail(email));
}

async function enforcePublicFeatureAccess(request, env, feature, limits = {}) {
  const settings = await readPublicAccessSettings(env);
  const featureSettings = settings.features[feature] || {};
  validatePublicInputLimits(featureSettings, limits);
  if (!settings.google_login_required) {
    return { settings, consumed: false, authenticated: false, is_admin: false };
  }
  if (!publicGoogleAuthConfigured(env)) {
    throw httpError(503, "Google login is not configured");
  }
  const session = await readPublicSession(request, env);
  if (!session) {
    throw httpError(401, "Google login is required");
  }
  const isAdmin = isPublicAdminEmail(session.email, settings);
  if (isAdmin) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_exempt",
      email: session.email,
      feature,
      is_admin: true,
      ...requestAuditContext(request),
    });
    return { settings, consumed: false, authenticated: true, is_admin: true, email: session.email };
  }
  await consumePublicQuota(env, feature, session.email, featureSettings, request);
  return { settings, consumed: true, authenticated: true, is_admin: false, email: session.email };
}

function validatePublicInputLimits(featureSettings, limits) {
  const audioBytes = Number(limits.audioBytes || 0);
  const textChars = Number(limits.textChars || 0);
  const scriptChars = Number(limits.scriptChars || 0);
  const referenceUrlDurationSeconds = Number(limits.referenceUrlDurationSeconds || 0);
  if (featureSettings.audio_max_bytes > 0 && audioBytes > featureSettings.audio_max_bytes) {
    throw httpError(413, "audio is too large");
  }
  if (featureSettings.text_max_chars > 0 && textChars > featureSettings.text_max_chars) {
    throw httpError(413, "text is too large");
  }
  if (featureSettings.script_max_chars > 0 && scriptChars > featureSettings.script_max_chars) {
    throw httpError(413, "script is too large");
  }
  if (
    featureSettings.reference_url_duration_max_seconds > 0 &&
    referenceUrlDurationSeconds > featureSettings.reference_url_duration_max_seconds
  ) {
    throw httpError(413, "reference URL audio duration is too long");
  }
}

async function consumePublicQuota(env, feature, email, featureSettings, request = null) {
  const normalizedEmail = normalizeEmail(email);
  const dailyLimit = Number(featureSettings.daily_limit ?? -1);
  const totalLimit = Number(featureSettings.total_limit ?? -1);
  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${normalizedEmail}:${today}`;
  const totalKey = `${PUBLIC_USAGE_KV_PREFIX}${feature}:${normalizedEmail}:total`;
  const dailyUsed = await publicUsageGet(env, dailyKey);
  const totalUsed = await publicUsageGet(env, totalKey);
  if (dailyLimit >= 0 && dailyUsed >= dailyLimit) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_blocked",
      email: normalizedEmail,
      feature,
      limit_type: "daily",
      used: dailyUsed,
      limit: dailyLimit,
      ...requestAuditContext(request),
    });
    throw httpError(429, "public quota exceeded");
  }
  if (totalLimit >= 0 && totalUsed >= totalLimit) {
    await appendPublicAuditEvent(env, {
      action: "public_quota_blocked",
      email: normalizedEmail,
      feature,
      limit_type: "total",
      used: totalUsed,
      limit: totalLimit,
      ...requestAuditContext(request),
    });
    throw httpError(429, "public quota exceeded");
  }
  await publicUsagePut(env, dailyKey, dailyUsed + 1, 60 * 60 * 48);
  await publicUsagePut(env, totalKey, totalUsed + 1);
  await appendPublicAuditEvent(env, {
    action: "public_quota_consumed",
    email: normalizedEmail,
    feature,
    daily_used: dailyUsed + 1,
    daily_limit: dailyLimit,
    total_used: totalUsed + 1,
    total_limit: totalLimit,
    ...requestAuditContext(request),
  });
}

async function readPublicAuditLog(env, url = null) {
  const kv = stateKv(env);
  const requestedLimit = url ? Number(new URL(url).searchParams.get("limit") || "") : 0;
  const limit = clampInt(requestedLimit, 1, publicAuditLogLimit(env), 100);
  const events = kv ? await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []) : [];
  const normalizedEvents = Array.isArray(events) ? events : [];
  return {
    events: normalizedEvents.slice(-limit).reverse(),
    limit,
    stored: normalizedEvents.length,
  };
}

async function appendPublicAuditEvent(env, event) {
  const kv = stateKv(env);
  if (!kv) {
    return;
  }
  const now = new Date();
  const entry = sanitizePublicAuditEvent({
    id: crypto.randomUUID(),
    created_at: now.toISOString(),
    created_at_unix: Math.floor(now.getTime() / 1000),
    ...event,
  });
  try {
    const current = await kvGetJson(kv, PUBLIC_AUDIT_LOG_KV_KEY, []);
    const events = Array.isArray(current) ? current : [];
    events.push(entry);
    const limit = publicAuditLogLimit(env);
    await kv.put(PUBLIC_AUDIT_LOG_KV_KEY, JSON.stringify(events.slice(-limit)));
  } catch (_error) {
    // 監査ログ保存の失敗で、ログインや生成APIの本処理を止めない。
  }
}

function publicAuditLogLimit(env) {
  return clampInt(env.PUBLIC_AUDIT_LOG_LIMIT, 10, 5000, PUBLIC_AUDIT_LOG_DEFAULT_LIMIT);
}

function sanitizePublicAuditEvent(event) {
  const allowed = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (["email", "action", "feature", "path", "method", "limit_type", "next", "cf_country", "cf_ray"].includes(key)) {
      allowed[key] = String(value).slice(0, 256);
    } else if (["id", "created_at"].includes(key)) {
      allowed[key] = String(value).slice(0, 128);
    } else if (["is_admin"].includes(key)) {
      allowed[key] = Boolean(value);
    } else if (
      [
        "created_at_unix",
        "daily_used",
        "daily_limit",
        "total_used",
        "total_limit",
        "used",
        "limit",
      ].includes(key)
    ) {
      allowed[key] = Number(value);
    }
  }
  return allowed;
}

function requestAuditContext(request) {
  if (!request) {
    return {};
  }
  const url = new URL(request.url);
  const cf = request.cf || {};
  return {
    method: request.method,
    path: url.pathname,
    cf_country: cf.country || "",
    cf_ray: request.headers.get("cf-ray") || "",
  };
}

async function publicUsageGet(env, key) {
  const kv = stateKv(env);
  if (kv) {
    return clampInt(await kv.get(key), 0, 1_000_000_000, 0);
  }
  return clampInt(ephemeralPublicUsage.get(key), 0, 1_000_000_000, 0);
}

async function publicUsagePut(env, key, value, expirationTtl = null) {
  const kv = stateKv(env);
  if (kv) {
    const options = expirationTtl ? { expirationTtl } : undefined;
    await kv.put(key, String(value), options);
  } else {
    ephemeralPublicUsage.set(key, String(value));
  }
}

async function prepareUserSettingsForWrite(payload, env) {
  const settings = coerceUserSettings(payload);
  if (settings.joke_variation_count <= 0 || settings.joke_texts.length === 0) {
    return coerceUserSettings({ ...settings, joke_variants: [] });
  }
  const jokeVariants = await generateJokeVariants(settings.joke_texts, settings.joke_variation_count, env);
  return coerceUserSettings({ ...settings, joke_variants: jokeVariants });
}

function coerceUserSettings(payload = {}) {
  const jokeTexts = coerceTextList(payload.joke_texts ?? payload.joke_text);
  const jokeVariants = coerceTextList(payload.joke_variants);
  const effectAudios = coerceEffectAudios(payload.effect_audios);
  return {
    target_language: supportedValue(payload.target_language, ["ja-JP", "id-ID", "zh-CN", "en-US"], "ja-JP"),
    joke_text: jokeTexts.join("\n"),
    joke_texts: jokeTexts,
    joke_position: supportedValue(payload.joke_position, ["before", "after"], "after"),
    joke_selection: supportedValue(payload.joke_selection, ["rotation", "random"], "rotation"),
    joke_variation_count: clampInt(payload.joke_variation_count, 0, 5, 0),
    joke_variants: jokeVariants,
    joke_pool: [...jokeTexts, ...jokeVariants],
    effect_audios: effectAudios,
    effect_selection: supportedValue(payload.effect_selection, ["rotation", "random"], "rotation"),
    effect_insert_mode: supportedValue(payload.effect_insert_mode, ["silence_or_tail", "tail"], "silence_or_tail"),
    effect_max_insertions: clampInt(payload.effect_max_insertions, 1, 5, 1),
    effect_min_silence_ms: clampInt(payload.effect_min_silence_ms, 100, 2000, 300),
    theme: supportedValue(payload.theme, ["blue", "pop", "mint"], "blue"),
  };
}

function coerceTextList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function coerceEffectAudios(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const audioBase64 = String(item.audio_base64 || "").trim();
      if (!audioBase64 || audioBase64.length > 2_000_000) {
        return null;
      }
      return {
        id: String(item.id || `effect-${index + 1}`).trim() || `effect-${index + 1}`,
        name: String(item.name || `effect-${index + 1}.wav`).trim().slice(0, 120) || `effect-${index + 1}.wav`,
        audio_mime_type: normalizeMimeType(item.audio_mime_type || "audio/wav") || "audio/wav",
        audio_base64: audioBase64,
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

async function generateJokeVariants(jokeTexts, variationCount, env) {
  const rawText = await openAiText(env, {
    model: env.OPENAI_JOKE_VARIATION_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions:
      "You create short joke text variations for a speech conversion app. Keep each variation in the same language as its source joke. Return only strict JSON in this shape: {\"variants\":[[\"variant 1 for source 1\",\"variant 2 for source 1\"],[\"variant 1 for source 2\",\"variant 2 for source 2\"]]}. Each inner array must correspond to the source joke at the same index.",
    input: JSON.stringify({ jokes: jokeTexts, variants_per_joke: variationCount }),
  });
  return parseJokeVariantsResponse(rawText, jokeTexts.length, variationCount);
}

function parseJokeVariantsResponse(rawText, sourceCount, variationCount) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw httpError(502, "joke variation response was not valid JSON");
  }
  const variants = Array.isArray(payload) ? payload : payload?.variants;
  if (!Array.isArray(variants)) {
    throw httpError(502, "joke variation response did not include variants");
  }
  let matrix = [];
  if (variants.every((row) => Array.isArray(row))) {
    matrix = variants.slice(0, sourceCount).map((row) =>
      row.map((item) => String(item).trim()).filter(Boolean).slice(0, variationCount)
    );
  } else {
    const flat = variants.map((item) => String(item).trim()).filter(Boolean);
    matrix = Array.from({ length: sourceCount }, (_, index) =>
      flat.slice(index * variationCount, (index + 1) * variationCount)
    );
  }
  if (matrix.length < sourceCount || matrix.some((row) => row.length < variationCount)) {
    throw httpError(502, "joke variation response did not include enough variants");
  }
  const ordered = [];
  for (let variantIndex = 0; variantIndex < variationCount; variantIndex += 1) {
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      ordered.push(matrix[sourceIndex][variantIndex]);
    }
  }
  return ordered;
}

async function createTranslationJob(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const audioBytes = await audio.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBytes);
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const sourceLanguage = stringFormValue(form, "source_language", "auto");
  const targetLanguage = stringFormValue(form, "target_language", "user-auto");
  const voiceMode = stringFormValue(form, "voice_mode", "default");
  const translationBackend = stringFormValue(form, "translation_backend", "openai");
  const textTransform = optionalStringFormValue(form, "text_transform");
  const textTransformOptions = parseJsonFormValue(form, "text_transform_options", {});
  const textTransformSuffix = optionalStringFormValue(form, "text_transform_suffix");
  const textTransformUnit = stringFormValue(form, "text_transform_unit", "text");
  const jobId = `cf-${crypto.randomUUID()}`;

  await enforcePublicFeatureAccess(request, env, "fun", { audioBytes: audioBytes.byteLength });

  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: audioBase64,
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(jobId)}-input.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "translate-speech-jobs",
      translation_backend: "openai",
      source_language: sourceLanguage,
      target_language: targetLanguage,
      voice_mode: voiceMode,
      filename: audio.name || "",
      original_content_type: audio.type || audioMimeType,
      original_audio_suffix: `.${extensionForMimeType(audioMimeType)}`,
    },
  });

  const asrStarted = Date.now();
  const transcript = await openAiTranscribe(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage,
    filename: audio.name || `recording.${extensionForMimeType(audioMimeType)}`,
  });
  const asrMs = Date.now() - asrStarted;

  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript,
    sourceLanguage,
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;

  const textTransformStarted = Date.now();
  const transformedText = await transformTranslationText(env, {
    translatedText: translation.translated_text,
    targetLanguage: translation.target_language,
    textTransform,
    textTransformOptions,
    textTransformSuffix,
    textTransformUnit,
  });
  const textTransformMs = Date.now() - textTransformStarted;

  const tts = await openAiSpeech(env, transformedText);
  const result = {
    transcript,
    translated_text: translation.translated_text,
    transformed_text: transformedText,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: {
      asr: asrMs,
      translation: translationMs,
      text_transform: textTransformMs,
      ...(tts.timings_ms || {}),
      total: asrMs + translationMs + textTransformMs + Number(tts.timings_ms?.tts || 0),
    },
    providers: {
      asr: `openai-asr-${env.OPENAI_ASR_MODEL || "gpt-4o-transcribe"}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
      ...(textTransform ? { text_transform: textTransform } : {}),
    },
    warnings: [],
    target_language: translation.target_language,
    detected_source_language: translation.source_language,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "translate-speech-jobs",
    translation_backend: "openai",
    requested_translation_backend: translationBackend,
    source_language: translation.source_language || sourceLanguage,
    target_language: translation.target_language,
    voice_mode: voiceMode,
  });
  const snapshot = completedJobSnapshot(jobId, "translation", result);
  await saveTranslationJobSnapshot(env, snapshot);
  return snapshot;
}

async function createVoiceConversionJob(request, env) {
  const form = await request.formData();
  const sourceAudio = requiredBlob(form, "source_audio");
  const referenceAudio = requiredBlob(form, "reference_audio");
  await enforcePublicFeatureAccess(request, env, "voice_conversion", {
    audioBytes: Math.max(Number(sourceAudio.size || 0), Number(referenceAudio.size || 0)),
  });
  const sourceAudioBase64 = await blobToBase64(sourceAudio);
  const sourceAudioMimeType = normalizeMimeType(sourceAudio.type || guessAudioMimeType(sourceAudio.name));
  const referenceAudioBase64 = await blobToBase64(referenceAudio);
  const referenceAudioMimeType = normalizeMimeType(referenceAudio.type || guessAudioMimeType(referenceAudio.name));
  const voiceBackend = stringFormValue(form, "voice_backend", "seed-vc");
  const audioEffectAudio = optionalBlob(form, "audio_effect_audio");
  const audioEffectEnabled = optionEnabled(stringFormValue(form, "audio_effect_enabled", "false"));
  const payload = {
    operation_mode: "voice_conversion",
    source_audio_base64: sourceAudioBase64,
    source_audio_mime_type: sourceAudioMimeType,
    reference_audio_base64: referenceAudioBase64,
    reference_audio_mime_type: referenceAudioMimeType,
    voice_backend: voiceBackend,
    ...seedVcPayloadFromForm(form),
  };
  if (audioEffectEnabled && audioEffectAudio) {
    payload.audio_effect_enabled = true;
    payload.audio_effect_audio_base64 = await blobToBase64(audioEffectAudio);
    payload.audio_effect_audio_mime_type = normalizeMimeType(
      audioEffectAudio.type || guessAudioMimeType(audioEffectAudio.name),
    );
    payload.audio_effect_insert_mode = supportedValue(
      stringFormValue(form, "audio_effect_insert_mode", "silence_or_tail"),
      ["silence_or_tail", "tail"],
      "silence_or_tail",
    );
    payload.audio_effect_max_insertions = clampInt(
      stringFormValue(form, "audio_effect_max_insertions", "1"),
      1,
      5,
      1,
    );
    payload.audio_effect_min_silence_ms = clampInt(
      stringFormValue(form, "audio_effect_min_silence_ms", "300"),
      100,
      2000,
      300,
    );
  }
  const body = await submitRunpodJob(env, payload);
  const snapshot = jobSnapshotFromRunpod(body, "voice_conversion");
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, "voice_conversion")) {
    await saveRunpodVcReadyState(env, snapshot, "voice_conversion");
  }
  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: sourceAudioBase64,
    audio_mime_type: sourceAudioMimeType,
    filename: `${safeHistoryToken(snapshot.job_id || crypto.randomUUID())}-source.${extensionForMimeType(sourceAudioMimeType)}`,
    metadata: {
      endpoint: "voice-conversion-jobs",
      voice_backend: voiceBackend,
      filename: sourceAudio.name || "",
      content_type: sourceAudio.type || sourceAudioMimeType,
    },
  });
  return snapshot;
}

async function createWarmupJob(env) {
  const payload = {
    operation_mode: "warmup",
    translation_backend: env.RUNPOD_SERVERLESS_TRANSLATION_BACKEND || "openai",
    preload_translation: env.RUNPOD_WARMUP_PRELOAD_TRANSLATION !== "0",
    preload_voice_conversion: env.RUNPOD_WARMUP_PRELOAD_VOICE_CONVERSION !== "0",
  };
  const body = await submitRunpodJob(env, payload);
  const snapshot = jobSnapshotFromRunpod(body, "warmup");
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, "warmup")) {
    await saveRunpodVcReadyState(env, snapshot, "warmup");
  }
  return snapshot;
}

async function getRunpodJobSnapshot(jobId, env, kind) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/status/${encodeURIComponent(jobId)}`, { method: "GET" });
  const snapshot = jobSnapshotFromRunpod(body, kind);
  if (snapshot.status === "succeeded" && isRunpodVcReadyResult(snapshot.result, kind)) {
    await saveRunpodVcReadyState(env, snapshot, kind);
  }
  if (snapshot.status === "succeeded" && snapshot.result?.audio_base64) {
    await saveRunpodOutputHistory(env, jobId, kind, snapshot.result);
  }
  return snapshot;
}

async function cancelRunpodJob(jobId, env, kind) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const body = await runpodRequest(env, `/cancel/${encodeURIComponent(jobId)}`, { method: "POST" });
  return jobSnapshotFromRunpod(body, kind);
}

async function readRunpodVcReadyState(env) {
  const kv = stateKv(env);
  if (!kv) {
    return runpodVcReadyState(false);
  }
  const stateKey = runpodVcReadyKvKey(env);
  const state = await kvGetJson(kv, stateKey, null);
  if (!state || typeof state !== "object") {
    return runpodVcReadyState(false);
  }
  const expiresAt = Date.parse(String(state.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await kv.delete(stateKey);
    return runpodVcReadyState(false);
  }
  return runpodVcReadyState(true, state);
}

async function saveRunpodVcReadyState(env, snapshot, kind) {
  const kv = stateKv(env);
  if (!kv) {
    return;
  }
  const ttlSeconds = runpodVcReadyTtlSeconds(env);
  const state = {
    ready: true,
    source: kind,
    job_id: snapshot.job_id || "",
    checked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    providers: snapshot.result?.providers || {},
    serverless_timings_ms: snapshot.result?.serverless_timings_ms || {},
  };
  await kv.put(runpodVcReadyKvKey(env), JSON.stringify(state), { expirationTtl: ttlSeconds });
}

function runpodVcReadyKvKey(env) {
  return `${RUNPOD_VC_READY_KV_KEY_PREFIX}${env.RUNPOD_ENDPOINT_ID || "default"}`;
}

function isRunpodVcReadyResult(result, kind) {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (kind === "warmup") {
    return result.warm === true && result.providers?.voice_conversion === "seed-vc";
  }
  if (kind === "voice_conversion") {
    return Boolean(result.audio_base64);
  }
  return false;
}

function runpodVcReadyState(ready, state = {}) {
  return {
    ready: Boolean(ready),
    source: String(state.source || ""),
    job_id: String(state.job_id || ""),
    checked_at: String(state.checked_at || ""),
    expires_at: String(state.expires_at || ""),
    providers: state.providers || {},
    serverless_timings_ms: state.serverless_timings_ms || {},
  };
}

async function getTranslationJobSnapshot(jobId, env) {
  if (!jobId) {
    throw httpError(400, "job_id is required");
  }
  const snapshot = await readTranslationJobSnapshot(env, jobId);
  if (!snapshot) {
    throw httpError(404, "job not found");
  }
  return snapshot;
}

async function saveTranslationJobSnapshot(env, snapshot) {
  const kv = stateKv(env);
  if (kv) {
    await kv.put(`${TRANSLATION_JOB_KV_PREFIX}${snapshot.job_id}`, JSON.stringify(snapshot), {
      expirationTtl: numberFromEnv(env.CLOUDFLARE_TRANSLATION_JOB_TTL_SECONDS, 3600),
    });
  } else {
    ephemeralTranslationJobs.set(snapshot.job_id, snapshot);
  }
}

async function readTranslationJobSnapshot(env, jobId) {
  const kv = stateKv(env);
  if (kv) {
    return kvGetJson(kv, `${TRANSLATION_JOB_KV_PREFIX}${jobId}`, null);
  }
  return ephemeralTranslationJobs.get(jobId) || null;
}

function completedJobSnapshot(jobId, kind, result) {
  return {
    job_id: jobId,
    status: "succeeded",
    current_stage: { stage: "complete", label: "完了", provider: "" },
    stages: completedStages(kind),
    result,
    error: null,
  };
}

function jobSnapshotFromRunpod(body, kind) {
  const jobId = String(body.id || body.job_id || "");
  const status = String(body.status || "").toUpperCase();
  if (status === "COMPLETED") {
    return {
      job_id: jobId,
      status: "succeeded",
      current_stage: { stage: "complete", label: "完了", provider: "" },
      stages: completedStages(kind),
      result: body.output || null,
      error: null,
    };
  }
  if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    return {
      job_id: jobId,
      status: "failed",
      current_stage: { stage: "failed", label: "失敗", provider: "RunPod Serverless" },
      stages: plannedStages(kind),
      result: null,
      error: runpodErrorMessage(body),
    };
  }
  const queued = status === "IN_QUEUE" || status === "QUEUED" || !status;
  return {
    job_id: jobId,
    status: queued ? "queued" : "running",
    current_stage: currentStageForKind(kind, queued),
    stages: plannedStages(kind),
    result: null,
    error: null,
  };
}

function plannedStages(kind) {
  if (kind === "voice_conversion") {
    return [{ stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" }];
  }
  if (kind === "vibevoice") {
    return [
      { stage: "queued", label: "待機中", provider: "RunPod Serverless" },
      { stage: "vibevoice", label: "VibeVoice生成", provider: "RunPod Serverless" },
      { stage: "postprocess", label: "後処理", provider: "RunPod Serverless" },
    ];
  }
  if (kind === "warmup") {
    return [{ stage: "warmup", label: "準備", provider: "RunPod Serverless" }];
  }
  return [
    { stage: "asr", label: "文字起こし", provider: "RunPod Serverless" },
    { stage: "translation", label: "翻訳", provider: "RunPod Serverless" },
    { stage: "tts", label: "音声生成", provider: "RunPod Serverless" },
  ];
}

function completedStages(kind) {
  return [...plannedStages(kind), { stage: "complete", label: "完了", provider: "" }];
}

function currentStageForKind(kind, queued) {
  if (queued) {
    return { stage: "queued", label: "待機中", provider: "RunPod Serverless" };
  }
  if (kind === "voice_conversion") {
    return { stage: "voice_conversion", label: "声質変換", provider: "RunPod Serverless" };
  }
  if (kind === "vibevoice") {
    return { stage: "vibevoice", label: "VibeVoice生成", provider: "RunPod Serverless" };
  }
  if (kind === "warmup") {
    return { stage: "warmup", label: "準備", provider: "RunPod Serverless" };
  }
  return { stage: "asr", label: "RunPod推論", provider: "RunPod Serverless" };
}

async function createUserDisplayText(payload, env) {
  const text = String(payload.text || "").trim();
  const targetLanguage = String(payload.target_language || "ja-JP");
  if (!text) {
    return { kanji_text: "", hiragana_text: "", indonesian_text: "" };
  }
  if (targetLanguage === "id-ID") {
    return { kanji_text: text, hiragana_text: "", indonesian_text: text };
  }
  if (targetLanguage !== "ja-JP") {
    return { kanji_text: text, hiragana_text: "", indonesian_text: "" };
  }
  const hiragana = await openAiText(env, {
    model: env.OPENAI_TEXT_DISPLAY_MODEL || env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions:
      "Convert the Japanese sentence to hiragana only for display to language learners. Return only the hiragana text, with no notes. Keep punctuation and Arabic numerals readable.",
    input: text,
  });
  return { kanji_text: text, hiragana_text: hiragana || text, indonesian_text: "" };
}

async function createUserTextOutput(payload, env) {
  const translatedText = String(payload.translated_text || "").trim();
  if (!translatedText) {
    throw httpError(400, "translated_text is required");
  }
  const targetLanguage = String(payload.target_language || "ja-JP");
  const transformOptions = typeof payload.text_transform_options === "object" && payload.text_transform_options !== null
    ? payload.text_transform_options
    : {};
  const transformedText = await transformUserText(translatedText, targetLanguage, transformOptions, env);
  const tts = await openAiSpeech(env, transformedText);
  const result = {
    transcript: String(payload.transcript || ""),
    translated_text: translatedText,
    transformed_text: transformedText,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: tts.timings_ms,
    providers: {
      asr: "cached",
      translation: "cached",
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    warnings: [],
    target_language: targetLanguage,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "user-text-output",
    translation_backend: "openai",
    target_language: targetLanguage,
    voice_mode: "default",
  });
  return result;
}

async function createUserJokeOutput(payload, env) {
  const text = String(payload.text || "").trim();
  if (!text) {
    throw httpError(400, "text is required");
  }
  const targetLanguage = String(payload.target_language || "id-ID");
  const translatedText = await openAiText(env, {
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions: "Translate the text into natural Indonesian for a short spoken joke. Return only the translated text.",
    input: text,
  });
  const tts = await openAiSpeech(env, translatedText || text);
  const result = {
    transcript: text,
    translated_text: translatedText || text,
    transformed_text: translatedText || text,
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    timings_ms: tts.timings_ms,
    providers: {
      asr: "none",
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    warnings: [],
    target_language: targetLanguage,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "user-joke-output",
    translation_backend: "openai",
    target_language: targetLanguage,
    voice_mode: "default",
  });
  return result;
}

async function createPracticePrompt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  await enforcePublicFeatureAccess(request, env, "speakloop", { audioBytes: Number(audio.size || 0) });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: arrayBufferToBase64(audioBytes),
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(`practice-${crypto.randomUUID()}`)}-native.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "practice-prompts",
      target_language: targetLanguage,
      asr_model: asrModel,
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: "auto",
    filename: audio.name || `native.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
    includeTimestamps: true,
  });
  const transcript = transcription.text;
  const asrMs = Date.now() - asrStarted;

  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript,
    sourceLanguage: "auto",
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;

  const tts = await openAiSpeech(env, translation.translated_text);
  const result = {
    transcript,
    target_text: translation.translated_text,
    translated_text: translation.translated_text,
    transformed_text: translation.translated_text,
    target_language: targetLanguage,
    target_language_label: PRACTICE_TARGET_LANGUAGES[targetLanguage].label,
    display_text: await createPracticeDisplayText(translation.translated_text, targetLanguage, env, {
      includePinyin,
    }),
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    asr_model: asrModel,
    asr_timestamps: serializeAsrTimestamps(transcription),
    timings_ms: {
      asr: asrMs,
      translation: translationMs,
      ...(tts.timings_ms || {}),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: `openai-asr-${asrModel}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    detected_source_language: translation.source_language,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "practice-prompts",
    translation_backend: "openai",
    source_language: translation.source_language || "auto",
    target_language: targetLanguage,
    asr_model: asrModel,
    voice_mode: "default",
  });
  return result;
}

async function createPracticeRecording(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const currentTargetText = stringFormValue(form, "current_target_text", "");
  const includePinyin = targetLanguage === "zh-CN" && optionEnabled(stringFormValue(form, "include_pinyin", "false"));
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0),
    textChars: currentTargetText.trim().length,
  });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  const recordingEntry = await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: arrayBufferToBase64(audioBytes),
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(`practice-${crypto.randomUUID()}`)}-recording.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "practice-recordings",
      target_language: targetLanguage,
      asr_model: asrModel,
      current_target_text_preview: currentTargetText.slice(0, 80),
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });

  const autoStarted = Date.now();
  const autoTranscription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: "auto",
    filename: audio.name || `practice.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
    includeTimestamps: true,
  });
  const autoAsrMs = Date.now() - autoStarted;
  let targetTranscription = null;
  let targetAsrMs = 0;
  let classification = {
    kind: "prompt",
    attempt_source: "",
    target_similarity: 0,
    auto_similarity: 0,
    target_language_signal: 0,
    auto_language_signal: practiceLanguageSignal(autoTranscription.text, targetLanguage),
  };

  if (currentTargetText.trim()) {
    const targetStarted = Date.now();
    targetTranscription = await openAiTranscribeDetail(env, {
      audioBytes,
      audioMimeType,
      sourceLanguage: targetLanguage,
      filename: audio.name || `practice.${extensionForMimeType(audioMimeType)}`,
      model: asrModel,
      includeTimestamps: true,
    });
    targetAsrMs = Date.now() - targetStarted;
    classification = classifyPracticeRecording({
      targetText: currentTargetText,
      targetLanguage,
      targetRecognizedText: targetTranscription.text,
      autoRecognizedText: autoTranscription.text,
    });
  }

  if (classification.kind === "attempt" && targetTranscription) {
    const selectedTranscription = classification.attempt_source === "auto" ? autoTranscription : targetTranscription;
    const selectedAsrMs = classification.attempt_source === "auto" ? autoAsrMs : targetAsrMs;
    const evaluation = evaluatePracticeAttempt(currentTargetText, selectedTranscription.text, targetLanguage);
    const asrTimestamps = serializeAsrTimestamps(selectedTranscription);
    const result = {
      recording_kind: "attempt",
      target_language: targetLanguage,
      target_text: currentTargetText,
      recognized_text: selectedTranscription.text,
      asr_model: asrModel,
      asr_timestamps: asrTimestamps,
      ...evaluation,
      comparison_alignment: practiceComparisonAlignment({
        targetText: currentTargetText,
        recognizedText: selectedTranscription.text,
        targetLanguage,
        asrTimestamps,
      }),
      classification,
      timings_ms: {
        asr: selectedAsrMs,
        compare: 0,
        total: autoAsrMs + targetAsrMs,
      },
      providers: {
        asr: `openai-asr-${asrModel}`,
      },
    };
    await updateAudioHistoryEntryMetadata(env, recordingEntry, practiceHistoryDiagnosticsMetadata(result));
    return result;
  }

  const totalStarted = Date.now();
  const translationStarted = Date.now();
  const translation = await translateTranscript(env, {
    transcript: autoTranscription.text,
    sourceLanguage: "auto",
    targetLanguage,
  });
  const translationMs = Date.now() - translationStarted;

  const tts = await openAiSpeech(env, translation.translated_text);
  const result = {
    recording_kind: "prompt",
    transcript: autoTranscription.text,
    target_text: translation.translated_text,
    translated_text: translation.translated_text,
    transformed_text: translation.translated_text,
    target_language: targetLanguage,
    target_language_label: PRACTICE_TARGET_LANGUAGES[targetLanguage].label,
    display_text: await createPracticeDisplayText(translation.translated_text, targetLanguage, env, {
      includePinyin,
    }),
    audio_mime_type: tts.audio_mime_type,
    audio_base64: tts.audio_base64,
    asr_model: asrModel,
    asr_timestamps: serializeAsrTimestamps(autoTranscription),
    classification,
    timings_ms: {
      asr: autoAsrMs,
      translation: translationMs,
      ...(tts.timings_ms || {}),
      total: Date.now() - totalStarted + autoAsrMs + targetAsrMs,
    },
    providers: {
      asr: `openai-asr-${asrModel}`,
      translation: `openai-translation-${env.OPENAI_TRANSLATION_MODEL || "gpt-5.5"}`,
      tts: `openai-tts-${env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"}`,
    },
    detected_source_language: translation.source_language,
  };
  await savePipelineOutputHistory(env, result, {
    endpoint: "practice-recordings",
    translation_backend: "openai",
    source_language: translation.source_language || "auto",
    target_language: targetLanguage,
    asr_model: asrModel,
    voice_mode: "default",
  });
  await updateAudioHistoryEntryMetadata(env, recordingEntry, practiceHistoryDiagnosticsMetadata(result));
  return result;
}

async function createPracticeAttempt(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const targetLanguage = supportedPracticeTargetLanguage(stringFormValue(form, "target_language", "ja-JP"));
  const asrModel = supportedPracticeAsrModel(stringFormValue(form, "asr_model", OPENAI_DEFAULT_PRACTICE_ASR_MODEL));
  const targetText = stringFormValue(form, "target_text", "").trim();
  if (!targetText) {
    throw httpError(400, "target_text is required");
  }
  await enforcePublicFeatureAccess(request, env, "speakloop", {
    audioBytes: Number(audio.size || 0),
    textChars: targetText.length,
  });
  const audioBytes = await audio.arrayBuffer();
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));

  const recordingEntry = await saveAudioHistoryEntry(env, "recordings", {
    audio_base64: arrayBufferToBase64(audioBytes),
    audio_mime_type: audioMimeType,
    filename: `${safeHistoryToken(`practice-${crypto.randomUUID()}`)}-repeat.${extensionForMimeType(audioMimeType)}`,
    metadata: {
      endpoint: "practice-attempts",
      target_language: targetLanguage,
      asr_model: asrModel,
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });

  const totalStarted = Date.now();
  const asrStarted = Date.now();
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage: targetLanguage,
    filename: audio.name || `repeat.${extensionForMimeType(audioMimeType)}`,
    model: asrModel,
    includeTimestamps: true,
  });
  const recognizedText = transcription.text;
  const asrMs = Date.now() - asrStarted;
  const evaluation = evaluatePracticeAttempt(targetText, recognizedText, targetLanguage);
  const asrTimestamps = serializeAsrTimestamps(transcription);
  const result = {
    target_language: targetLanguage,
    target_text: targetText,
    recognized_text: recognizedText,
    asr_model: asrModel,
    asr_timestamps: asrTimestamps,
    ...evaluation,
    comparison_alignment: practiceComparisonAlignment({
      targetText,
      recognizedText,
      targetLanguage,
      asrTimestamps,
    }),
    timings_ms: {
      asr: asrMs,
      compare: Math.max(0, Date.now() - totalStarted - asrMs),
      total: Date.now() - totalStarted,
    },
    providers: {
      asr: `openai-asr-${asrModel}`,
    },
  };
  await updateAudioHistoryEntryMetadata(env, recordingEntry, practiceHistoryDiagnosticsMetadata(result));
  return result;
}

async function createPracticeDisplayText(text, targetLanguage, env, { includePinyin = false } = {}) {
  if (targetLanguage === "zh-CN") {
    const pinyinText = includePinyin ? createChinesePinyinText(text) : "";
    return {
      mode: "plain",
      primary_text: text,
      secondary_text: "",
      kanji_text: text,
      hiragana_text: "",
      pinyin_text: pinyinText,
      pinyin_status: pinyinText ? "ready" : (includePinyin ? "unavailable" : "disabled"),
    };
  }
  if (targetLanguage !== "ja-JP") {
    return {
      mode: "plain",
      primary_text: text,
      secondary_text: "",
      kanji_text: text,
      hiragana_text: "",
      pinyin_text: "",
      pinyin_status: "disabled",
    };
  }
  const display = await createUserDisplayText({ text, target_language: targetLanguage }, env);
  const hiraganaText = String(display.hiragana_text || "").trim();
  const kanjiText = String(display.kanji_text || text).trim();
  return {
    mode: hiraganaText ? "hiragana" : "plain",
    primary_text: hiraganaText || kanjiText,
    secondary_text: hiraganaText && hiraganaText !== kanjiText ? kanjiText : "",
    kanji_text: kanjiText,
    hiragana_text: hiraganaText,
    pinyin_text: "",
    pinyin_status: "disabled",
  };
}

async function vibeVoiceStatus(env) {
  const runpodAvailable = Boolean(env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY);
  return {
    backends: {
      local: {
        available: false,
        provider: "cloudflare-worker",
        default_model_id: "vibevoice-large-aoi-pinned",
        model_presets: vibeVoiceModelPresets(),
        cli_exists: false,
        cli_path: "Cloudflare Worker",
        comfyui_vibevoice_exists: false,
        comfyui_vibevoice_path: "RunPod Serverless",
        model_cache_found: false,
        model_cache_path: "",
        tokenizer_found: false,
        tokenizer_path: "",
        timeout_seconds: 0,
      },
      runpod_serverless: {
        available: runpodAvailable,
        provider: "runpod-serverless-vibevoice",
        configured: runpodAvailable,
        endpoint_id: env.RUNPOD_ENDPOINT_ID || "",
        request_mode: "async",
        default_model_id: "vibevoice-large-aoi-pinned",
        model_presets: vibeVoiceModelPresets(),
        reason: runpodAvailable ? "" : "RUNPOD_ENDPOINT_ID または RUNPOD_API_KEY が設定されていません。",
      },
    },
  };
}

async function createVibeVoiceReferenceAudioFromUrl(_request, _env) {
  throw httpError(501, "URL reference audio extraction is only available in the local FastAPI app");
}

async function createVibeVoiceJob(request, env) {
  const form = await request.formData();
  const originalScript = await readVibeVoiceScriptFromForm(form);
  if (!originalScript.trim()) {
    throw httpError(400, "script is required");
  }
  const scriptPlan = await prepareVibeVoiceScriptForGeneration(form, env, originalScript);
  const voiceBlobs = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const blob = optionalBlob(form, `voice_file_${slot}`);
    if (blob && Number(blob.size || 0) > 0) {
      voiceBlobs.push({ slot, blob });
      continue;
    }
    if (stringFormValue(form, `voice_url_${slot}`, "").trim()) {
      throw httpError(
        400,
        "URL reference audio is not available on the Cloudflare public demo. Upload or record reference audio instead.",
      );
    }
  }
  if (voiceBlobs.length < 1) {
    throw httpError(400, "voice sample is required");
  }
  await enforcePublicFeatureAccess(request, env, "skitvoice", {
    scriptChars: originalScript.trim().length,
    audioBytes: Math.max(0, ...voiceBlobs.map((item) => Number(item.blob.size || 0))),
  });
  const voices = [];
  for (const item of voiceBlobs) {
    const audioBytes = await item.blob.arrayBuffer();
    const audioMimeType = normalizeMimeType(item.blob.type || guessAudioMimeType(item.blob.name));
    voices.push({
      speaker: item.slot,
      filename: item.blob.name || `voice-${item.slot}.${extensionForMimeType(audioMimeType)}`,
      audio_mime_type: audioMimeType,
      audio_base64: arrayBufferToBase64(audioBytes),
    });
  }
  const body = await submitRunpodJob(env, {
    operation_mode: "vibevoice",
    script: scriptPlan.script,
    script_translation: scriptPlan.diagnostics,
    voices,
    generation: vibeVoiceGenerationPayloadFromForm(form),
    response_audio_format: stringFormValue(form, "response_audio_format", "mp3"),
  });
  return jobSnapshotFromRunpod(body, "vibevoice");
}

async function readVibeVoiceScriptFromForm(form) {
  const inline = stringFormValue(form, "script", "").trim();
  if (inline) {
    return normalizeVibeVoiceScriptLineEndings(inline);
  }
  const file = optionalBlob(form, "script_file");
  if (file && Number(file.size || 0) > 0 && typeof file.text === "function") {
    return normalizeVibeVoiceScriptLineEndings((await file.text()).trim());
  }
  return "";
}

function normalizeVibeVoiceScriptLineEndings(text) {
  return String(text || "").replace(/\r\n?/g, "\n");
}

async function prepareVibeVoiceScriptForGeneration(form, env, script) {
  const outputLanguage = supportedVibeVoiceOutputLanguage(stringFormValue(form, "output_language", "zh-CN"));
  const requested = optionEnabled(stringFormValue(form, "translate_script", "false"));
  const diagnostics = {
    requested,
    enabled: false,
    output_language: outputLanguage,
    source_language: "ja-JP",
    source_script: script,
    translated_script: script,
    model: "",
    provider: "",
  };
  if (!requested || outputLanguage === "ja-JP") {
    return { script, diagnostics };
  }
  const model = env.OPENAI_VIBEVOICE_SCRIPT_TRANSLATION_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5";
  const translated = normalizeVibeVoiceTranslatedScript(await openAiText(env, {
    model,
    instructions: [
      "Translate a Japanese skit script for speech generation.",
      `Translate only dialogue text into natural spoken ${VIBEVOICE_OUTPUT_LANGUAGES[outputLanguage].speech_name}.`,
      "Preserve speaker tags exactly.",
      "Preserve the number of non-empty lines and preserve line order.",
      "Return only the translated script with no notes.",
    ].join(" "),
    input: script,
  }));
  validateVibeVoiceTranslatedScript(script, translated);
  return {
    script: translated,
    diagnostics: {
      ...diagnostics,
      enabled: true,
      translated_script: translated,
      model,
      provider: "openai-responses",
    },
  };
}

function supportedVibeVoiceOutputLanguage(value) {
  const language = String(value || "zh-CN").trim();
  if (!Object.prototype.hasOwnProperty.call(VIBEVOICE_OUTPUT_LANGUAGES, language)) {
    throw httpError(400, `unsupported VibeVoice output language: ${language}`);
  }
  return language;
}

function normalizeVibeVoiceTranslatedScript(text) {
  let translated = String(text || "").trim();
  if (translated.startsWith("```")) {
    translated = translated.replace(/^```(?:text|txt)?/i, "").replace(/```$/i, "").trim();
  }
  return translated.split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trim();
}

function validateVibeVoiceTranslatedScript(sourceScript, translatedScript) {
  if (!translatedScript.trim()) {
    throw httpError(502, "VibeVoice script translation returned empty text");
  }
  const sourceLines = String(sourceScript || "").split(/\r?\n/).filter((line) => line.trim());
  const translatedLines = String(translatedScript || "").split(/\r?\n/).filter((line) => line.trim());
  if (sourceLines.length > 0 && sourceLines.length !== translatedLines.length) {
    throw httpError(
      502,
      `VibeVoice script translation must preserve non-empty line count: source=${sourceLines.length} translated=${translatedLines.length}`,
    );
  }
}

function vibeVoiceGenerationPayloadFromForm(form) {
  return {
    model_id: stringFormValue(form, "model_id", "vibevoice-large-aoi-pinned"),
    cfg_scale: numberFormValue(form, "cfg_scale", 1.3),
    inference_steps: clampInt(stringFormValue(form, "inference_steps", "10"), 1, 50, 10),
    seed: clampInt(stringFormValue(form, "seed", "42"), 0, 999999999, 42),
    do_sample: optionEnabled(stringFormValue(form, "do_sample", "true")),
    temperature: numberFormValue(form, "temperature", 0.95),
    top_p: numberFormValue(form, "top_p", 0.95),
    top_k: clampInt(stringFormValue(form, "top_k", "0"), 0, 1000, 0),
    max_voice_seconds: numberFormValue(form, "max_voice_seconds", 5),
    line_by_line: optionEnabled(stringFormValue(form, "line_by_line", "false")),
    line_gap: numberFormValue(form, "line_gap", 1),
    directed_line_mode: optionEnabled(stringFormValue(form, "directed_line_mode", "true")),
    directed_retry_low_score: optionEnabled(stringFormValue(form, "directed_retry_low_score", "true")),
    directed_retry_score_threshold: numberFormValue(form, "directed_retry_score_threshold", 0.65),
    directed_retry_max_multiplier: numberFormValue(form, "directed_retry_max_multiplier", 1),
  };
}

function vibeVoiceModelPresets() {
  return [
    { model_id: "vibevoice-1.5b-pinned", label: "VibeVoice 1.5B 固定版", supported_backends: ["local", "runpod_serverless"] },
    { model_id: "vibevoice-1.5b-latest", label: "VibeVoice 1.5B 最新", supported_backends: ["local", "runpod_serverless"] },
    { model_id: "vibevoice-large-aoi-pinned", label: "VibeVoice Large (RunPod)", supported_backends: ["runpod_serverless"] },
  ];
}

function createChinesePinyinText(text) {
  try {
    return pinyin(text, {
      nonZh: "removed",
      toneType: "symbol",
      type: "array",
    })
      .map((token) => String(token || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  } catch (error) {
    console.warn("practice pinyin generation failed", error);
    return "";
  }
}

async function listAudioHistory(env) {
  const kv = stateKv(env);
  const index = kv ? await readAudioHistoryIndex(env) : { recordings: [], outputs: [] };
  return {
    settings: audioHistorySettings(env),
    recordings: index.recordings.filter((entry) => !isPracticeHistoryEntry(entry)).map(serializeAudioHistoryEntry),
    outputs: index.outputs.filter((entry) => !isPracticeHistoryEntry(entry)).map(serializeAudioHistoryEntry),
  };
}

async function listPracticeHistory(env) {
  const kv = stateKv(env);
  const index = kv ? await readAudioHistoryIndex(env) : { recordings: [], outputs: [] };
  return {
    settings: audioHistorySettings(env),
    recordings: index.recordings.filter(isPracticeHistoryEntry).map(serializeAudioHistoryEntry),
    outputs: index.outputs.filter(isPracticeHistoryEntry).map(serializeAudioHistoryEntry),
  };
}

async function saveUploadedAudioHistoryOutput(request, env) {
  const form = await request.formData();
  const audio = requiredBlob(form, "audio");
  const audioMimeType = normalizeMimeType(audio.type || guessAudioMimeType(audio.name));
  const saved = await saveAudioHistoryEntry(env, "outputs", {
    audio_base64: await blobToBase64(audio),
    audio_mime_type: audioMimeType,
    metadata: {
      endpoint: stringFormValue(form, "endpoint", "manual"),
      translation_backend: stringFormValue(form, "translation_backend", ""),
      target_language: stringFormValue(form, "target_language", ""),
      filename: audio.name || "",
      content_type: audio.type || audioMimeType,
    },
  });
  return {
    saved: Boolean(saved),
    entry: saved ? serializeAudioHistoryEntry(saved) : null,
  };
}

async function getAudioHistoryFile(kind, filename, env) {
  validateAudioHistoryPath(kind, filename);
  const kv = requireStateKv(env);
  const index = await readAudioHistoryIndex(env);
  const entry = index[kind].find((item) => item.filename === filename);
  if (!entry) {
    throw httpError(404, "audio history file not found");
  }
  const audioBase64 = await kv.get(entry.audio_key);
  if (!audioBase64) {
    throw httpError(404, "audio history file not found");
  }
  return new Response(base64ToBytes(audioBase64), {
    headers: {
      "Content-Type": entry.media_type || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

async function deleteAudioHistoryFile(kind, filename, env) {
  validateAudioHistoryPath(kind, filename);
  const kv = requireStateKv(env);
  const index = await readAudioHistoryIndex(env);
  const existing = index[kind].find((entry) => entry.filename === filename);
  if (!existing) {
    throw httpError(404, "audio history file not found");
  }
  index[kind] = index[kind].filter((entry) => entry.filename !== filename);
  await kv.delete(existing.audio_key);
  await kv.put(AUDIO_HISTORY_INDEX_KV_KEY, JSON.stringify(index));
  return { deleted: true };
}

async function savePipelineOutputHistory(env, result, metadata = {}) {
  return saveAudioHistoryEntry(env, "outputs", {
    audio_base64: result.audio_base64,
    audio_mime_type: result.audio_mime_type || "audio/wav",
    metadata: {
      ...metadata,
      audio_mime_type: result.audio_mime_type || "audio/wav",
      ...historyTextMetadataFromResult(result),
    },
  });
}

async function saveRunpodOutputHistory(env, jobId, kind, result) {
  const endpoint = kind === "voice_conversion" ? "voice-conversion-jobs" : "translate-speech-jobs";
  return saveAudioHistoryEntry(env, "outputs", {
    audio_base64: result.audio_base64,
    audio_mime_type: result.audio_mime_type || "audio/wav",
    filename: `${safeHistoryToken(jobId)}-output.${extensionForMimeType(result.audio_mime_type || "audio/wav")}`,
    metadata: {
      endpoint,
      translation_backend: kind === "translation" ? "runpod_serverless" : "",
      voice_backend: kind === "voice_conversion" ? "seed-vc" : "",
      target_language: result.target_language || "",
      voice_mode: kind === "voice_conversion" ? "convert" : "",
      audio_mime_type: result.audio_mime_type || "audio/wav",
      ...historyTextMetadataFromResult(result),
    },
  });
}

async function openAiTranscribe(env, { audioBytes, audioMimeType, sourceLanguage, filename }) {
  const transcription = await openAiTranscribeDetail(env, {
    audioBytes,
    audioMimeType,
    sourceLanguage,
    filename,
    model: env.OPENAI_ASR_MODEL || "gpt-4o-transcribe",
    includeTimestamps: false,
  });
  return transcription.text;
}

async function openAiTranscribeDetail(env, {
  audioBytes,
  audioMimeType,
  sourceLanguage,
  filename,
  model,
  includeTimestamps = false,
}) {
  requireEnv(env, "OPENAI_API_KEY");
  const requestedModel = String(model || env.OPENAI_ASR_MODEL || "gpt-4o-transcribe").trim() || "gpt-4o-transcribe";
  const asrModel = includeTimestamps ? supportedPracticeAsrModel(requestedModel) : requestedModel;
  const useTimestamps = includeTimestamps && OPENAI_TIMESTAMP_ASR_MODELS.has(asrModel);
  const responseFormat = useTimestamps ? "verbose_json" : openAiAsrResponseFormat(asrModel);
  const form = new FormData();
  form.append("model", asrModel);
  form.append("response_format", responseFormat);
  if (useTimestamps) {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  }
  const language = OPENAI_LANGUAGE_CODES[sourceLanguage] || "";
  if (language) {
    form.append("language", language);
  }
  form.append(
    "file",
    new Blob([audioBytes], { type: audioMimeType || "application/octet-stream" }),
    filename || `audio.${extensionForMimeType(audioMimeType)}`,
  );
  const response = await runtimeFetch(env)("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw httpError(response.status, `OpenAI ASR failed: ${text}`);
  }
  if (responseFormat === "text") {
    return {
      text: text.trim(),
      model: asrModel,
      timestamp_granularities: [],
      words: [],
      segments: [],
    };
  }
  return transcriptionFromOpenAiJson(text, asrModel, useTimestamps ? ["word", "segment"] : []);
}

function openAiAsrResponseFormat(model) {
  return OPENAI_JSON_ONLY_ASR_MODELS.has(model) ? "json" : "text";
}

function transcriptionFromOpenAiJson(text, model, timestampGranularities) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    return {
      text: String(text || "").trim(),
      model,
      timestamp_granularities: [],
      words: [],
      segments: [],
    };
  }
  return {
    text: String(payload.text || "").trim(),
    model,
    timestamp_granularities: timestampGranularities,
    words: normalizedAsrTimingRows(payload.words, "word"),
    segments: normalizedAsrTimingRows(payload.segments, "text"),
  };
}

function normalizedAsrTimingRows(rows, textKey) {
  return (rows || []).flatMap((row) => {
    const start = Number(row?.start);
    const end = Number(row?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return [];
    }
    return [{
      text: String(row?.[textKey] ?? row?.text ?? row?.word ?? ""),
      start,
      end,
    }];
  });
}

function serializeAsrTimestamps(transcription) {
  const words = transcription?.words || [];
  const segments = transcription?.segments || [];
  return {
    available: Boolean(words.length || segments.length),
    model: transcription?.model || "",
    timestamp_granularities: transcription?.timestamp_granularities || [],
    words,
    segments,
  };
}

async function translateTranscript(env, { transcript, sourceLanguage, targetLanguage }) {
  if (!transcript.trim()) {
    return {
      source_language: sourceLanguage === "auto" ? "" : sourceLanguage,
      target_language: targetLanguage === "user-auto" ? "ja-JP" : targetLanguage,
      translated_text: "",
    };
  }
  const requestedTarget = targetLanguage === "user-auto" ? "user-auto" : supportedValue(targetLanguage, Object.keys(OPENAI_LANGUAGE_NAMES), "ja-JP");
  const instructions = requestedTarget === "user-auto"
    ? [
        "You translate a short speech transcript for a playful demo app.",
        "Detect the source language from the transcript.",
        "If the transcript is Japanese, translate it into natural Indonesian and set target_language to id-ID.",
        "If the transcript is not Japanese, translate it into natural Japanese and set target_language to ja-JP.",
        "Return only strict JSON: {\"source_language\":\"ja-JP|id-ID|zh-CN|en-US|auto\",\"target_language\":\"ja-JP|id-ID\",\"translated_text\":\"...\"}.",
      ].join(" ")
    : [
        "You translate a short speech transcript for a speech conversion app.",
        `Translate into ${OPENAI_LANGUAGE_NAMES[requestedTarget] || requestedTarget}.`,
        "Detect the source language when possible.",
        "Return only strict JSON: {\"source_language\":\"ja-JP|id-ID|zh-CN|en-US|auto\",\"target_language\":\"...\",\"translated_text\":\"...\"}.",
      ].join(" ");
  const rawText = await openAiText(env, {
    model: env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
    instructions,
    input: JSON.stringify({
      source_language: sourceLanguage,
      target_language: requestedTarget,
      transcript,
    }),
  });
  return parseTranslationResponse(rawText, sourceLanguage, requestedTarget);
}

function parseTranslationResponse(rawText, sourceLanguage, requestedTarget) {
  let text = String(rawText || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    const payload = JSON.parse(text);
    const targetLanguage = requestedTarget === "user-auto"
      ? supportedValue(payload.target_language, ["ja-JP", "id-ID"], "ja-JP")
      : supportedValue(payload.target_language, Object.keys(OPENAI_LANGUAGE_NAMES), requestedTarget);
    return {
      source_language: supportedValue(payload.source_language, ["auto", ...Object.keys(OPENAI_LANGUAGE_NAMES)], sourceLanguage),
      target_language: targetLanguage || "ja-JP",
      translated_text: String(payload.translated_text || "").trim(),
    };
  } catch (_error) {
    const fallbackTarget = requestedTarget === "user-auto" ? "ja-JP" : requestedTarget;
    return {
      source_language: sourceLanguage,
      target_language: fallbackTarget,
      translated_text: text,
    };
  }
}

async function transformTranslationText(env, {
  translatedText,
  targetLanguage,
  textTransform,
  textTransformOptions,
  textTransformSuffix,
  textTransformUnit,
}) {
  if (textTransform === "append_suffix") {
    return appendSuffix(translatedText, textTransformSuffix || String(textTransformOptions?.suffix || ""), textTransformUnit || textTransformOptions?.unit || "text");
  }
  if (textTransform === "user_effects") {
    return transformUserText(translatedText, targetLanguage, textTransformOptions || {}, env);
  }
  return translatedText;
}

function appendSuffix(text, suffix, unit) {
  if (!suffix) {
    return text;
  }
  if (unit === "text") {
    return `${text}${suffix}`;
  }
  if (unit !== "sentence") {
    throw httpError(400, `unsupported append_suffix unit: ${unit}`);
  }
  return text.replace(/([^。！？!?]+[。！？!?]?)/g, (segment) => {
    const trimmed = segment.trim();
    return trimmed ? `${segment}${suffix}` : segment;
  });
}

async function saveAudioHistoryEntry(env, kind, { audio_base64, audio_mime_type, filename = "", metadata = {} }) {
  const kv = stateKv(env);
  if (!kv || !audio_base64 || !AUDIO_HISTORY_KINDS.has(kind)) {
    return null;
  }
  const index = await readAudioHistoryIndex(env);
  const mediaType = normalizeMimeType(audio_mime_type) || "application/octet-stream";
  const safeFilename = safeHistoryFilename(
    filename || `${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomUUID()}.${extensionForMimeType(mediaType)}`,
  );
  const audioKey = `audio-history:${kind}:${safeFilename}:audio`;
  const normalizedMetadata = normalizeMetadata(metadata);
  const entry = {
    kind,
    filename: safeFilename,
    audio_key: audioKey,
    media_type: mediaType,
    size_bytes: base64ByteLength(audio_base64),
    created_at: new Date().toISOString(),
    metadata: normalizedMetadata,
  };
  await kv.put(audioKey, audio_base64);
  index[kind] = [entry, ...index[kind].filter((item) => item.filename !== safeFilename)];
  await trimAudioHistoryIndex(kv, index, kind, audioHistoryLimit(env));
  await kv.put(AUDIO_HISTORY_INDEX_KV_KEY, JSON.stringify(index));
  return entry;
}

async function updateAudioHistoryEntryMetadata(env, entry, metadata = {}) {
  const kv = stateKv(env);
  if (!kv || !entry || !AUDIO_HISTORY_KINDS.has(entry.kind)) {
    return null;
  }
  const index = await readAudioHistoryIndex(env);
  const items = index[entry.kind] || [];
  const target = items.find((item) => item.filename === entry.filename);
  if (!target) {
    return null;
  }
  target.metadata = normalizeMetadata({ ...(target.metadata || {}), ...metadata });
  await kv.put(AUDIO_HISTORY_INDEX_KV_KEY, JSON.stringify(index));
  return target;
}

async function trimAudioHistoryIndex(kv, index, kind, limit) {
  const overflow = index[kind].slice(limit);
  index[kind] = index[kind].slice(0, limit);
  await Promise.all(overflow.map((entry) => kv.delete(entry.audio_key)));
}

async function readAudioHistoryIndex(env) {
  const kv = stateKv(env);
  if (!kv) {
    return { recordings: [], outputs: [] };
  }
  const stored = await kvGetJson(kv, AUDIO_HISTORY_INDEX_KV_KEY, null);
  return {
    recordings: normalizeAudioHistoryEntries(stored?.recordings, "recordings"),
    outputs: normalizeAudioHistoryEntries(stored?.outputs, "outputs"),
  };
}

function normalizeAudioHistoryEntries(entries, kind) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((entry) => entry && typeof entry === "object" && entry.filename && entry.audio_key)
    .map((entry) => ({
      kind,
      filename: String(entry.filename),
      audio_key: String(entry.audio_key),
      media_type: normalizeMimeType(entry.media_type) || "application/octet-stream",
      size_bytes: Number(entry.size_bytes || 0),
      created_at: String(entry.created_at || ""),
      metadata: normalizeMetadata(entry.metadata || {}),
    }));
}

function serializeAudioHistoryEntry(entry) {
  const metadata = normalizeMetadata(entry.metadata || {});
  const preview = metadataTextPreview(metadata);
  return {
    kind: entry.kind,
    filename: entry.filename,
    url: `/api/audio-history/${entry.kind}/${encodeURIComponent(entry.filename)}`,
    label: audioHistoryLabel(entry.kind, metadata, preview),
    media_type: entry.media_type,
    size_bytes: entry.size_bytes,
    created_at: entry.created_at,
    metadata,
    text_preview: preview,
    tts_text: String(metadata.tts_text || ""),
    details: audioHistoryDetails(entry.kind, metadata),
    playable_hint: entry.size_bytes > 0 && entry.size_bytes < 128
      ? "音声ファイルが小さすぎます。テスト用または失敗したダミー出力の可能性があります。"
      : "",
  };
}

function audioHistorySettings(env) {
  const enabled = Boolean(stateKv(env));
  const root = enabled ? "Cloudflare Workers KV: MO_SPEECH_KV" : "Cloudflare Workers KV未設定";
  return {
    enabled,
    root,
    resolved_root: root,
    recordings_dir: "audio-history:recordings",
    outputs_dir: "audio-history:outputs",
    limit: audioHistoryLimit(env),
    env_var: "CLOUDFLARE_AUDIO_HISTORY_LIMIT",
  };
}

function audioHistoryLimit(env) {
  return clampInt(env.CLOUDFLARE_AUDIO_HISTORY_LIMIT || AUDIO_HISTORY_DEFAULT_LIMIT, 1, 100, AUDIO_HISTORY_DEFAULT_LIMIT);
}

function historyTextMetadataFromResult(result) {
  const transformed = textPreview(result.transformed_text);
  const translated = textPreview(result.translated_text);
  const transcript = textPreview(result.transcript);
  const ttsText = String(result.transformed_text || result.translated_text || "").trim();
  return {
    text_preview: transformed || translated || transcript,
    tts_text: ttsText,
    transcript_preview: transcript,
    translated_text_preview: translated,
    transformed_text_preview: transformed,
  };
}

function practiceHistoryDiagnosticsMetadata(result) {
  const diagnostics = {
    recording_kind: String(result.recording_kind || ""),
    target_language: String(result.target_language || ""),
    target_text: String(result.target_text || ""),
    recognized_text: String(result.recognized_text || ""),
    transcript: String(result.transcript || ""),
    asr_model: String(result.asr_model || ""),
    classification: result.classification || {},
    phrase_matches: result.phrase_matches || [],
    comparison_alignment: result.comparison_alignment || {},
    asr_timestamps: compactAsrTimestamps(result.asr_timestamps || {}),
    timings_ms: result.timings_ms || {},
  };
  return {
    text_preview: textPreview(result.target_text || result.recognized_text || result.transcript || ""),
    recognized_text_preview: textPreview(result.recognized_text || result.transcript || ""),
    practice_diagnostics_json: JSON.stringify(diagnostics),
  };
}

function compactAsrTimestamps(timestamps) {
  const words = Array.isArray(timestamps.words) ? timestamps.words : [];
  const segments = Array.isArray(timestamps.segments) ? timestamps.segments : [];
  return {
    available: Boolean(timestamps.available),
    model: String(timestamps.model || ""),
    timestamp_granularities: Array.isArray(timestamps.timestamp_granularities)
      ? timestamps.timestamp_granularities
      : [],
    word_count: words.length,
    segment_count: segments.length,
    words: words.slice(0, 120),
    segments: segments.slice(0, 40),
    truncated: words.length > 120 || segments.length > 40,
  };
}

function metadataTextPreview(metadata) {
  for (const key of ["text_preview", "recognized_text_preview", "transformed_text_preview", "translated_text_preview", "transcript_preview"]) {
    const value = String(metadata[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function audioHistoryLabel(kind, metadata, preview) {
  if (preview) {
    return preview;
  }
  const endpoint = String(metadata.endpoint || "");
  const filename = String(metadata.filename || metadata.audio_file || "");
  if (endpoint === "voice-conversion-jobs") {
    return kind === "outputs" ? "VC出力" : filename || "VC入力音声";
  }
  if (endpoint === "user-joke-output") {
    return "ジョーク音声";
  }
  if (endpoint === "user-text-output") {
    return "ユーザー画面TTS";
  }
  if (endpoint === "openai-realtime-streaming") {
    return "Realtime streaming出力";
  }
  if (endpoint.startsWith("translate-speech")) {
    return kind === "outputs" ? "翻訳音声" : filename || "入力音声";
  }
  return filename || (kind === "outputs" ? "出力音声" : "入力音声");
}

function audioHistoryDetails(kind, metadata) {
  const details = [String(metadata.endpoint || kind)];
  const route = audioHistoryRoute(metadata);
  if (route) {
    details.push(route);
  }
  for (const key of ["translation_backend", "tts_backend", "voice_backend"]) {
    const value = String(metadata[key] || "");
    if (value) {
      details.push(value);
    }
  }
  const filename = String(metadata.filename || "");
  if (filename) {
    details.push(filename);
  }
  return details;
}

function audioHistoryRoute(metadata) {
  const sourceLanguage = String(metadata.source_language || "");
  const targetLanguage = String(metadata.target_language || "");
  if (sourceLanguage && targetLanguage) {
    return `${sourceLanguage} -> ${targetLanguage}`;
  }
  return targetLanguage;
}

function textPreview(value) {
  const text = String(value || "").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function normalizeMetadata(metadata) {
  const normalized = {};
  if (!metadata || typeof metadata !== "object") {
    return normalized;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[key] = typeof value === "string" ? value : String(value);
  }
  return normalized;
}

function isPracticeHistoryEntry(entry) {
  return String(entry?.metadata?.endpoint || "").startsWith("practice-");
}

function validateAudioHistoryPath(kind, filename) {
  if (!AUDIO_HISTORY_KINDS.has(kind)) {
    throw httpError(400, "unsupported audio history kind");
  }
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw httpError(400, "invalid audio history filename");
  }
}

function stateKv(env) {
  return env.MO_SPEECH_KV || null;
}

function requireStateKv(env) {
  const kv = stateKv(env);
  if (!kv) {
    throw httpError(503, "MO_SPEECH_KV binding is required");
  }
  return kv;
}

async function kvGetJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === "audio/webm" || normalized === "video/webm") return "webm";
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/mp4" || normalized === "audio/m4a" || normalized === "audio/x-m4a") return "m4a";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/aac") return "aac";
  if (normalized === "audio/flac") return "flac";
  return "wav";
}

function safeHistoryToken(value) {
  return String(value || "history").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "history";
}

function safeHistoryFilename(value) {
  const filename = safeHistoryToken(value);
  return filename.includes(".") ? filename : `${filename}.wav`;
}

function base64ByteLength(base64) {
  const value = String(base64 || "").replace(/\s/g, "");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function transformUserText(text, targetLanguage, options, env) {
  if (
    targetLanguage !== "ja-JP" ||
    (!optionEnabled(options.osaka_dialect) && !optionEnabled(options.variation))
  ) {
    return text;
  }
  const instructions = [
    "You rewrite short Japanese spoken output for a playful speech conversion app.",
    "Return only the rewritten Japanese text, with no notes.",
    "Keep it concise and suitable for text-to-speech.",
  ];
  if (optionEnabled(options.osaka_dialect)) {
    instructions.push("Use natural Osaka dialect while preserving the speaker's intent.");
  }
  if (optionEnabled(options.variation)) {
    instructions.push(
      "Create a small playful variation of the request by changing a concrete number, condition, or target when that is natural; do not make it offensive or confusing.",
    );
  }
  return (
    await openAiText(env, {
      model: env.OPENAI_TEXT_TRANSFORM_MODEL || env.OPENAI_TRANSLATION_MODEL || "gpt-5.5",
      instructions: instructions.join(" "),
      input: text,
    })
  ) || text;
}

async function submitRunpodJob(env, inputPayload) {
  return runpodRequest(env, "/run", {
    method: "POST",
    payload: { input: inputPayload },
  });
}

async function submitRunpodSyncJob(env, inputPayload) {
  return runpodRequest(env, "/runsync", {
    method: "POST",
    payload: { input: inputPayload },
  });
}

function runpodSyncOutput(body, label) {
  if (body && typeof body.output === "object" && body.output !== null) {
    return body.output;
  }
  if (body && typeof body === "object" && body.audio_base64) {
    return body;
  }
  const status = String(body?.status || "").toUpperCase();
  if (RUNPOD_TERMINAL_FAILURE_STATES.has(status)) {
    throw httpError(502, runpodErrorMessage(body));
  }
  throw httpError(502, `${label} did not return output`);
}

async function runpodRequest(env, path, { method = "GET", payload = null, timeoutMs = null } = {}) {
  requireEnv(env, "RUNPOD_ENDPOINT_ID");
  requireEnv(env, "RUNPOD_API_KEY");
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await runtimeFetch(env)(`${runpodBaseUrl(env)}/${env.RUNPOD_ENDPOINT_ID}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller?.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw httpError(response.status, body.error || body.message || `RunPod request failed: ${response.status}`);
    }
    return body;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function openAiText(env, payload) {
  requireEnv(env, "OPENAI_API_KEY");
  const response = await runtimeFetch(env)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, body.error?.message || body.error || `OpenAI request failed: ${response.status}`);
  }
  return textFromOpenAiResponse(body);
}

async function openAiSpeech(env, text) {
  requireEnv(env, "OPENAI_API_KEY");
  const started = Date.now();
  const responseFormat = env.OPENAI_TTS_RESPONSE_FORMAT || "wav";
  const response = await runtimeFetch(env)("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: env.OPENAI_TTS_VOICE || "coral",
      input: text,
      instructions: env.OPENAI_TTS_INSTRUCTIONS || "Speak naturally and clearly in the target language.",
      response_format: responseFormat,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw httpError(response.status, body.error?.message || body.error || `OpenAI TTS failed: ${response.status}`);
  }
  const audio = await response.arrayBuffer();
  return {
    audio_mime_type: audioMimeFromOpenAiFormat(responseFormat),
    audio_base64: arrayBufferToBase64(audio),
    timings_ms: { tts: Date.now() - started, total: Date.now() - started },
  };
}

function textFromOpenAiResponse(body) {
  if (typeof body.output_text === "string") {
    return body.output_text.trim();
  }
  if (Array.isArray(body.output)) {
    const chunks = [];
    for (const item of body.output) {
      if (!Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (typeof content.text === "string") {
          chunks.push(content.text);
        }
      }
    }
    return chunks.join("").trim();
  }
  if (typeof body.text === "string") {
    return body.text.trim();
  }
  return "";
}

function seedVcPayloadFromForm(form) {
  return {
    ...optionalNumberPayload(form, "seed_vc_diffusion_steps", true),
    ...optionalNumberPayload(form, "seed_vc_reference_max_seconds", false),
    ...optionalNumberPayload(form, "seed_vc_length_adjust", false),
    ...optionalNumberPayload(form, "seed_vc_inference_cfg_rate", false),
    ...optionalBooleanPayload(form, "seed_vc_reference_auto_select"),
  };
}

function optionalNumberPayload(form, key, integer) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return {};
  }
  const value = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  return Number.isFinite(value) ? { [key]: value } : {};
}

function optionalBooleanPayload(form, key) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return {};
  }
  return { [key]: optionEnabled(raw) };
}

function requiredBlob(form, key) {
  const value = form.get(key);
  if (!value || typeof value.arrayBuffer !== "function") {
    throw httpError(400, `${key} is required`);
  }
  return value;
}

function optionalBlob(form, key) {
  const value = form.get(key);
  if (!value || typeof value.arrayBuffer !== "function") {
    return null;
  }
  return value;
}

function stringFormValue(form, key, fallback = "") {
  return String(form.get(key) || fallback);
}

function numberFormValue(form, key, fallback) {
  const number = Number.parseFloat(stringFormValue(form, key, String(fallback)));
  return Number.isFinite(number) ? number : fallback;
}

function optionalStringFormValue(form, key) {
  const value = form.get(key);
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function parseJsonFormValue(form, key, fallback) {
  const raw = optionalStringFormValue(form, key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

async function blobToBase64(blob) {
  return arrayBufferToBase64(await blob.arrayBuffer());
}

function arrayBufferToBase64(buffer) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function guessAudioMimeType(name = "") {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  return "audio/wav";
}

function normalizeMimeType(value = "") {
  return String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function audioMimeFromOpenAiFormat(format) {
  return {
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/wav",
  }[format] || "audio/wav";
}

function runpodVcReadyTtlSeconds(env) {
  return Math.max(30, numberFromEnv(env.RUNPOD_WARMUP_READY_TTL_SECONDS, 300));
}

function runpodBaseUrl(env) {
  return (env.RUNPOD_API_BASE_URL || RUNPOD_DEFAULT_BASE_URL).replace(/\/$/, "");
}

function runtimeFetch(env) {
  return env.__fetch || fetch;
}

function requireEnv(env, key) {
  if (!env[key]) {
    throw httpError(503, `${key} is required`);
  }
}

function runpodErrorMessage(body) {
  return String(body.error || body.message || "RunPod job failed");
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(init.status === 204 ? null : JSON.stringify(payload), { ...init, headers });
}

function httpError(status, message) {
  const error = new Error(String(message));
  error.status = status;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function supportedValue(value, supported, fallback) {
  return supported.includes(String(value)) ? String(value) : fallback;
}

function supportedPracticeTargetLanguage(value) {
  const language = String(value || "ja-JP");
  if (!Object.prototype.hasOwnProperty.call(PRACTICE_TARGET_LANGUAGES, language)) {
    throw httpError(400, `unsupported practice target language: ${language}`);
  }
  return language;
}

function supportedPracticeAsrModel(value) {
  const model = String(value || OPENAI_DEFAULT_PRACTICE_ASR_MODEL).trim() || OPENAI_DEFAULT_PRACTICE_ASR_MODEL;
  if (!OPENAI_PRACTICE_ASR_MODELS.has(model)) {
    throw httpError(400, `unsupported practice ASR model: ${model}`);
  }
  return model;
}

function evaluatePracticeAttempt(targetText, recognizedText, targetLanguage) {
  const normalizedTarget = normalizePracticeText(targetText, targetLanguage);
  const normalizedRecognized = normalizePracticeText(recognizedText, targetLanguage);
  const globalSimilarity = practiceSimilarity(normalizedTarget, normalizedRecognized);
  const phraseMatches = practicePhraseMatches(targetText, recognizedText, targetLanguage);
  const phraseSimilarity = practicePhraseSimilarity(phraseMatches);
  const similarity = Math.max(globalSimilarity, phraseSimilarity);
  const grade = practiceGrade(similarity);
  return {
    normalized_target: normalizedTarget,
    normalized_recognized: normalizedRecognized,
    global_similarity: Math.round(globalSimilarity * 1000) / 1000,
    phrase_similarity: Math.round(phraseSimilarity * 1000) / 1000,
    similarity: Math.round(similarity * 1000) / 1000,
    grade,
    grade_label: PRACTICE_GRADE_LABELS[grade],
    diff: practiceDiff(normalizedTarget, normalizedRecognized),
    phrase_matches: phraseMatches,
  };
}

function classifyPracticeRecording({ targetText, targetLanguage, targetRecognizedText, autoRecognizedText }) {
  const language = supportedPracticeTargetLanguage(targetLanguage);
  if (!String(targetText || "").trim()) {
    return {
      kind: "prompt",
      attempt_source: "",
      target_similarity: 0,
      auto_similarity: 0,
      target_language_signal: 0,
      auto_language_signal: practiceLanguageSignal(autoRecognizedText, language),
    };
  }
  const targetEvaluation = evaluatePracticeAttempt(targetText, targetRecognizedText, language);
  const autoEvaluation = evaluatePracticeAttempt(targetText, autoRecognizedText, language);
  const targetSimilarity = Number(targetEvaluation.similarity) || 0;
  const autoSimilarity = Number(autoEvaluation.similarity) || 0;
  const targetSignal = practiceLanguageSignal(targetRecognizedText, language);
  const autoSignal = practiceLanguageSignal(autoRecognizedText, language);
  const bestSimilarity = Math.max(targetSimilarity, autoSignal >= 0.35 ? autoSimilarity : 0);
  const attemptSource = targetSimilarity >= autoSimilarity ? "target" : "auto";
  const isAttempt =
    bestSimilarity >= 0.35 ||
    (targetSimilarity >= 0.25 && targetSignal >= 0.3) ||
    (autoSimilarity >= 0.25 && autoSignal >= 0.55);
  return {
    kind: isAttempt ? "attempt" : "prompt",
    attempt_source: isAttempt ? attemptSource : "",
    target_similarity: Math.round(targetSimilarity * 1000) / 1000,
    auto_similarity: Math.round(autoSimilarity * 1000) / 1000,
    target_language_signal: Math.round(targetSignal * 1000) / 1000,
    auto_language_signal: Math.round(autoSignal * 1000) / 1000,
  };
}

function splitPracticePhrases(text) {
  const normalized = String(text || "").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const matches = normalized.match(/[^。！？!?.,，、；;：:\n]+[。！？!?.,，、；;：:]?/g) || [];
  return matches.map((value) => value.trim()).filter(Boolean);
}

function practicePhraseMatches(targetText, recognizedText, targetLanguage) {
  const phrases = splitPracticePhrases(targetText);
  const recognized = normalizePracticeText(recognizedText, targetLanguage);
  let cursor = 0;
  return phrases.map((phrase, index) => {
    const normalizedTarget = normalizePracticeText(phrase, targetLanguage);
    const match = bestPracticePhraseMatch(normalizedTarget, recognized, cursor);
    const matched = Boolean(normalizedTarget) && match.similarity >= 0.45;
    if (matched) {
      cursor = match.recognized_end;
    }
    return {
      index,
      target: phrase,
      normalized_target: normalizedTarget,
      recognized_start: match.recognized_start,
      recognized_end: match.recognized_end,
      normalized_recognized: recognized.slice(match.recognized_start, match.recognized_end),
      similarity: Math.round(match.similarity * 1000) / 1000,
      matched,
    };
  });
}

function practicePhraseSimilarity(matches) {
  let weightedTotal = 0;
  let weightSum = 0;
  for (const match of matches) {
    const weight = String(match.normalized_target || "").length;
    if (weight <= 0) {
      continue;
    }
    weightedTotal += weight * (Number(match.similarity) || 0);
    weightSum += weight;
  }
  if (!weightSum) {
    return 0;
  }
  return Math.max(0, Math.min(1, weightedTotal / weightSum));
}

function practiceComparisonAlignment({ targetText, recognizedText, targetLanguage, asrTimestamps }) {
  const language = supportedPracticeTargetLanguage(targetLanguage);
  const phrases = comparisonTargetPhrases(targetText, language);
  const timestampData = asrTimestamps && typeof asrTimestamps === "object" ? asrTimestamps : {};
  const { spans: wordSpans, recognized } = asrWordSpans(timestampData.words, language);

  if (wordSpans.length && recognized) {
    const ranges = alignPhrasesToWordSpans(phrases, recognized, wordSpans, language);
    const complete = ranges.length > 0 && ranges.every((entry) => entry.available);
    return {
      available: ranges.some((entry) => entry.available),
      complete,
      mode: "target_phrase_word_alignment",
      reason: complete ? "" : "some target phrases could not be mapped to reliable word timestamps",
      target_language: language,
      recognized_normalized: recognized,
      target_phrase_count: phrases.length,
      ranges,
    };
  }

  const segments = asrSegments(timestampData.segments);
  if (phrases.length && segments.length === phrases.length) {
    const ranges = phrases.map((phrase, index) => {
      const segment = segments[index];
      const segmentText = String(segment.text || "");
      const similarity = practiceSimilarity(
        String(phrase.normalized_target || ""),
        normalizePracticeText(segmentText, language),
      );
      const available = similarity >= 0.45;
      return {
        index,
        source_index: phrase.source_index,
        target: phrase.target,
        normalized_target: phrase.normalized_target,
        available,
        matched: available,
        source: "segments",
        similarity: roundScore(similarity),
        coverage: available ? 1 : 0,
        recognized_start: null,
        recognized_end: null,
        normalized_recognized: normalizePracticeText(segmentText, language),
        matched_text: segmentText,
        audio_start: available ? segment.start : null,
        audio_end: available ? segment.end : null,
      };
    });
    const complete = ranges.every((entry) => entry.available);
    return {
      available: ranges.some((entry) => entry.available),
      complete,
      mode: "target_phrase_segment_fallback",
      reason: "word timestamps were unavailable; segment count matched target phrase count",
      target_language: language,
      recognized_normalized: normalizePracticeText(recognizedText, language),
      target_phrase_count: phrases.length,
      ranges,
    };
  }

  return {
    available: false,
    complete: false,
    mode: "unavailable",
    reason: "word timestamps were unavailable and segments could not be mapped safely",
    target_language: language,
    recognized_normalized: normalizePracticeText(recognizedText, language),
    target_phrase_count: phrases.length,
    ranges: phrases.map((phrase, index) => ({
      index,
      source_index: phrase.source_index,
      target: phrase.target,
      normalized_target: phrase.normalized_target,
      available: false,
      matched: false,
      source: "none",
      similarity: 0,
      coverage: 0,
      recognized_start: null,
      recognized_end: null,
      normalized_recognized: "",
      matched_text: "",
      audio_start: null,
      audio_end: null,
    })),
  };
}

function bestPracticePhraseMatch(normalizedTarget, recognized, cursor) {
  if (!normalizedTarget || !recognized) {
    return { recognized_start: 0, recognized_end: 0, similarity: 0 };
  }
  let best = { recognized_start: cursor, recognized_end: cursor, similarity: 0 };
  const minLength = Math.max(1, Math.floor(normalizedTarget.length * 0.45));
  const maxLength = Math.max(minLength, Math.floor(normalizedTarget.length * 1.8) + 3);
  for (let start = Math.max(0, cursor); start < recognized.length; start += 1) {
    const lastEnd = Math.min(recognized.length, start + maxLength);
    for (let end = start + minLength; end <= lastEnd; end += 1) {
      const similarity = practiceSimilarity(normalizedTarget, recognized.slice(start, end));
      if (similarity > best.similarity) {
        best = { recognized_start: start, recognized_end: end, similarity };
      }
      if (similarity >= 0.999) {
        return best;
      }
    }
  }
  return best;
}

function comparisonTargetPhrases(targetText, targetLanguage) {
  return splitPracticePhrases(targetText)
    .map((phrase, sourceIndex) => ({
      source_index: sourceIndex,
      target: phrase,
      normalized_target: normalizePracticeText(phrase, targetLanguage),
    }))
    .filter((phrase) => phrase.normalized_target && !isComparisonLabelPhrase(phrase.target, phrase.normalized_target));
}

function isComparisonLabelPhrase(phrase, normalized) {
  const label = String(phrase || "").trim().replace(/[：:]$/u, "");
  if (!label) {
    return true;
  }
  if (/^(speaker\s*\d+|[a-z]\d*|\d+)$/iu.test(label)) {
    return true;
  }
  return String(normalized || "").length <= 2 && /[：:]$/u.test(String(phrase || "").trim());
}

function asrWordSpans(words, targetLanguage) {
  if (!Array.isArray(words)) {
    return { spans: [], recognized: "" };
  }
  const spans = [];
  const pieces = [];
  let cursor = 0;
  for (const item of words) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = String(item.text || item.word || "").trim();
    const start = safeNumber(item.start);
    const end = safeNumber(item.end);
    const normalized = normalizePracticeText(text, targetLanguage);
    if (!normalized || start === null || end === null || end <= start) {
      continue;
    }
    pieces.push(normalized);
    const spanEnd = cursor + normalized.length;
    spans.push({
      text,
      normalized,
      normalized_start: cursor,
      normalized_end: spanEnd,
      audio_start: start,
      audio_end: end,
    });
    cursor = spanEnd;
  }
  return { spans, recognized: pieces.join("") };
}

function asrSegments(segments) {
  if (!Array.isArray(segments)) {
    return [];
  }
  return segments
    .map((item) => {
      const start = safeNumber(item?.start);
      const end = safeNumber(item?.end);
      if (start === null || end === null || end <= start) {
        return null;
      }
      return { text: String(item?.text || ""), start, end };
    })
    .filter(Boolean);
}

function alignPhrasesToWordSpans(phrases, recognized, wordSpans, targetLanguage) {
  let cursor = 0;
  return phrases.map((phrase, index) => {
    const normalizedTarget = String(phrase.normalized_target || "");
    const match = bestPracticePhraseMatch(normalizedTarget, recognized, cursor);
    const coverage = normalizedTarget ? (match.recognized_end - match.recognized_start) / normalizedTarget.length : 0;
    const matched = Boolean(normalizedTarget) && match.similarity >= 0.45 && coverage >= 0.5;
    const overlapping = matched ? overlappingWordSpans(wordSpans, match.recognized_start, match.recognized_end) : [];
    const available = overlapping.length > 0;
    if (available) {
      cursor = Math.max(cursor, overlapping[overlapping.length - 1].normalized_end);
    }
    return {
      index,
      source_index: phrase.source_index,
      target: phrase.target,
      normalized_target: normalizedTarget,
      available,
      matched,
      source: available ? "words" : "none",
      similarity: roundScore(match.similarity),
      coverage: roundScore(coverage),
      recognized_start: available ? match.recognized_start : null,
      recognized_end: available ? match.recognized_end : null,
      normalized_recognized: available ? recognized.slice(match.recognized_start, match.recognized_end) : "",
      matched_text: available ? joinMatchedWords(overlapping, targetLanguage) : "",
      audio_start: available ? overlapping[0].audio_start : null,
      audio_end: available ? overlapping[overlapping.length - 1].audio_end : null,
    };
  });
}

function overlappingWordSpans(wordSpans, normalizedStart, normalizedEnd) {
  return wordSpans.filter((span) => span.normalized_end > normalizedStart && span.normalized_start < normalizedEnd);
}

function joinMatchedWords(wordSpans, targetLanguage) {
  const words = wordSpans.map((span) => String(span.text || "")).filter(Boolean);
  if (targetLanguage === "ja-JP" || targetLanguage === "zh-CN") {
    return words.join("");
  }
  return words.join(" ");
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundScore(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function practiceLanguageSignal(text, targetLanguage) {
  const content = Array.from(String(text || "")).filter((char) => !/[\p{P}\p{Z}\p{S}]/u.test(char));
  if (!content.length) {
    return 0;
  }
  let matching = 0;
  if (targetLanguage === "zh-CN") {
    matching = content.filter((char) => isHanCharacter(char)).length;
  } else if (targetLanguage === "ja-JP") {
    matching = content.filter((char) => isHanCharacter(char) || /[\u3040-\u30ff]/u.test(char)).length;
  } else if (targetLanguage === "en-US") {
    matching = content.filter((char) => /[A-Za-z]/u.test(char)).length;
  }
  return Math.max(0, Math.min(1, matching / content.length));
}

function isHanCharacter(char) {
  const codePoint = String(char || "").codePointAt(0);
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
    (codePoint >= 0x20000 && codePoint <= 0x2A6DF) ||
    (codePoint >= 0x2A700 && codePoint <= 0x2B73F) ||
    (codePoint >= 0x2B740 && codePoint <= 0x2B81F) ||
    (codePoint >= 0x2B820 && codePoint <= 0x2CEAF)
  );
}

function normalizePracticeText(text, targetLanguage) {
  let normalized = String(text || "").normalize("NFKC").trim().toLowerCase();
  if (targetLanguage === "ja-JP") {
    normalized = normalized.replace(/[\u30a1-\u30f6]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    );
  }
  if (targetLanguage === "zh-CN") {
    normalized = normalizeChineseVariants(normalized);
  }
  return Array.from(normalized)
    .filter((char) => !/[\p{P}\p{Z}\p{S}]/u.test(char))
    .join("");
}

function normalizeChineseVariants(text) {
  return Array.from(String(text || ""))
    .map((char) => ZH_TRADITIONAL_TO_SIMPLIFIED[char] || char)
    .join("");
}

function practiceSimilarity(normalizedTarget, normalizedRecognized) {
  if (!normalizedTarget && !normalizedRecognized) {
    return 1;
  }
  if (!normalizedTarget || !normalizedRecognized) {
    return 0;
  }
  if (normalizedTarget === normalizedRecognized) {
    return 1;
  }
  const commonLength = longestCommonSubsequenceLength(normalizedTarget, normalizedRecognized);
  const sequenceScore = (2 * commonLength) / (normalizedTarget.length + normalizedRecognized.length);
  const containmentScore =
    normalizedTarget.includes(normalizedRecognized) || normalizedRecognized.includes(normalizedTarget)
      ? Math.min(normalizedTarget.length, normalizedRecognized.length) /
        Math.max(normalizedTarget.length, normalizedRecognized.length)
      : 0;
  return Math.max(0, Math.min(1, Math.max(sequenceScore, containmentScore)));
}

function practiceGrade(similarity) {
  if (similarity >= 0.995) {
    return "perfect";
  }
  if (similarity >= 0.95) {
    return "ok";
  }
  if (similarity >= 0.9) {
    return "almost";
  }
  return "retry";
}

function longestCommonSubsequenceLength(left, right) {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  if (!leftChars.length || !rightChars.length) {
    return 0;
  }
  let previous = new Array(rightChars.length + 1).fill(0);
  let current = new Array(rightChars.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      current[rightIndex] =
        leftChars[leftIndex - 1] === rightChars[rightIndex - 1]
          ? previous[rightIndex - 1] + 1
          : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[rightChars.length];
}

function practiceDiff(normalizedTarget, normalizedRecognized) {
  const rows = normalizedTarget.length + 1;
  const cols = normalizedRecognized.length + 1;
  const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let targetIndex = normalizedTarget.length - 1; targetIndex >= 0; targetIndex -= 1) {
    for (let recognizedIndex = normalizedRecognized.length - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
      if (normalizedTarget[targetIndex] === normalizedRecognized[recognizedIndex]) {
        lcs[targetIndex][recognizedIndex] = lcs[targetIndex + 1][recognizedIndex + 1] + 1;
      } else {
        lcs[targetIndex][recognizedIndex] = Math.max(
          lcs[targetIndex + 1][recognizedIndex],
          lcs[targetIndex][recognizedIndex + 1],
        );
      }
    }
  }
  const entries = [];
  let targetIndex = 0;
  let recognizedIndex = 0;
  while (targetIndex < normalizedTarget.length || recognizedIndex < normalizedRecognized.length) {
    const targetStart = targetIndex;
    const recognizedStart = recognizedIndex;
    let type;
    if (
      targetIndex < normalizedTarget.length &&
      recognizedIndex < normalizedRecognized.length &&
      normalizedTarget[targetIndex] === normalizedRecognized[recognizedIndex]
    ) {
      type = "equal";
      targetIndex += 1;
      recognizedIndex += 1;
    } else if (
      recognizedIndex < normalizedRecognized.length &&
      (targetIndex >= normalizedTarget.length || lcs[targetIndex][recognizedIndex + 1] >= lcs[targetIndex + 1][recognizedIndex])
    ) {
      type = "insert";
      recognizedIndex += 1;
    } else {
      type = "delete";
      targetIndex += 1;
    }
    const previous = entries[entries.length - 1];
    if (previous && previous.type === type && previous.target_end === targetStart && previous.recognized_end === recognizedStart) {
      previous.target_end = targetIndex;
      previous.recognized_end = recognizedIndex;
      previous.target = normalizedTarget.slice(previous.target_start, previous.target_end);
      previous.recognized = normalizedRecognized.slice(previous.recognized_start, previous.recognized_end);
    } else {
      entries.push({
        type,
        target: normalizedTarget.slice(targetStart, targetIndex),
        recognized: normalizedRecognized.slice(recognizedStart, recognizedIndex),
        target_start: targetStart,
        target_end: targetIndex,
        recognized_start: recognizedStart,
        recognized_end: recognizedIndex,
      });
    }
  }
  return entries.length > 0
    ? entries
    : [{
        type: "equal",
        target: "",
        recognized: "",
        target_start: 0,
        target_end: 0,
        recognized_start: 0,
        recognized_end: 0,
      }];
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function optionEnabled(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function numberFromEnv(value, fallback) {
  const number = Number.parseFloat(String(value || ""));
  return Number.isFinite(number) ? number : fallback;
}
