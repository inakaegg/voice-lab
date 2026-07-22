const publicUsersRoots = [...document.querySelectorAll("[data-public-users]")];
const PUBLIC_USERS_REQUEST_LIMIT = 2000;
let publicUsersInitialLoadStarted = false;
let publicUsersRequestGeneration = 0;

if (publicUsersRoots.length > 0) {
  const panels = new Set();
  for (const root of publicUsersRoots) {
    root.querySelector("[data-public-users-reload]")?.addEventListener("click", () => {
      void loadPublicUsers();
    });
    const panel = root.closest("details");
    if (panel) {
      panels.add(panel);
    }
  }
  for (const panel of panels) {
    panel.addEventListener("toggle", () => {
      if (panel.open) {
        loadPublicUsersOnce();
      }
    });
  }
  if (publicUsersRoots.some((root) => !root.closest("details") || root.closest("details").open)) {
    loadPublicUsersOnce();
  }
}

function loadPublicUsersOnce() {
  if (publicUsersInitialLoadStarted) {
    return;
  }
  publicUsersInitialLoadStarted = true;
  void loadPublicUsers();
}

async function loadPublicUsers() {
  const requestGeneration = ++publicUsersRequestGeneration;
  setPublicUsersStatus("読み込み中です。");
  try {
    const response = await fetch(`/api/public-users?limit=${PUBLIC_USERS_REQUEST_LIMIT}`);
    if (requestGeneration !== publicUsersRequestGeneration) {
      return;
    }
    if (!response.ok) {
      throw new Error(publicUsersResponseMessage(response.status));
    }
    const payload = await response.json();
    if (requestGeneration !== publicUsersRequestGeneration) {
      return;
    }
    const users = Array.isArray(payload.users) ? payload.users : [];
    const stored = Math.max(users.length, Number(payload.stored) || 0);
    for (const root of publicUsersRoots) {
      renderPublicUsers(root, users);
    }
    setPublicUsersStatus(publicUsersLoadedStatus(users.length, stored));
  } catch (error) {
    if (requestGeneration !== publicUsersRequestGeneration) {
      return;
    }
    for (const root of publicUsersRoots) {
      renderPublicUsers(root, []);
    }
    setPublicUsersStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function publicUsersLoadedStatus(displayed, stored) {
  if (stored === 0) {
    return "まだ記録がありません。";
  }
  if (stored > displayed) {
    return `全${stored}件中${displayed}件を表示しています。`;
  }
  return `${displayed}件を表示しています。`;
}

function renderPublicUsers(root, users) {
  const body = root.querySelector("[data-public-users-body]");
  if (!body) {
    return;
  }
  body.replaceChildren();
  for (const user of users) {
    const item = document.createElement("li");
    item.className = "public-users-item";
    item.append(publicUsersHeading(user), publicUsersMeta(user));
    body.append(item);
  }
}

function publicUsersHeading(user) {
  const heading = document.createElement("p");
  heading.className = "public-users-email";
  heading.textContent = user.email || "(記録前の利用者)";
  if (user.is_admin) {
    const badge = document.createElement("span");
    badge.className = "public-users-admin-badge";
    badge.textContent = "管理者";
    heading.append(" ", badge);
  }
  return heading;
}

function publicUsersMeta(user) {
  const meta = document.createElement("dl");
  meta.className = "public-users-meta";
  const rows = [
    ["最終ログイン", formatPublicUsersDate(user.last_login_at)],
    ["初回記録", formatPublicUsersDate(user.created_at)],
    ["最終利用", formatPublicUsersDate(user.last_seen_at)],
    ["利用回数", formatPublicUsersUsage(user.usage)],
  ];
  for (const [label, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    meta.append(term, description);
  }
  return meta;
}

function formatPublicUsersDate(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) {
    return "なし";
  }
  return new Date(time).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPublicUsersUsage(usage) {
  const entries = Object.entries(usage || {}).filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) {
    return "0";
  }
  return entries.map(([feature, count]) => `${feature}: ${count}`).join(" / ");
}

function publicUsersResponseMessage(status) {
  if (status === 401) {
    return "Googleログインが必要です。";
  }
  if (status === 403) {
    return "このGoogleアカウントには管理権限がありません。";
  }
  if (status === 404) {
    return "この環境では利用者一覧を提供していません。Cloudflare公開版で確認してください。";
  }
  return `利用者一覧を取得できませんでした: ${status}`;
}

function setPublicUsersStatus(text, state = "") {
  for (const root of publicUsersRoots) {
    const status = root.querySelector("[data-public-users-status]");
    if (!status) {
      continue;
    }
    status.textContent = text;
    status.dataset.state = state;
  }
}
