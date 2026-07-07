const publicAuthPanels = [...document.querySelectorAll("[data-public-auth-panel]")];

if (publicAuthPanels.length > 0) {
  syncPublicSession();
}

async function syncPublicSession() {
  try {
    const response = await fetch("/api/public-session");
    if (!response.ok) {
      return;
    }
    const session = await response.json();
    for (const panel of publicAuthPanels) {
      renderPublicAuthPanel(panel, session);
    }
  } catch (_error) {
    // ログイン状態表示は補助UIなので、取得失敗時は生成API側のエラー表示に任せる。
  }
}

function renderPublicAuthPanel(panel, session) {
  if (!session.google_login_required) {
    panel.hidden = true;
    return;
  }
  const status = panel.querySelector("[data-public-auth-status]");
  const login = panel.querySelector("[data-public-auth-login]");
  const logout = panel.querySelector("[data-public-auth-logout]");
  panel.hidden = false;
  if (!session.google_login_configured) {
    renderText(status, "Googleログイン設定が未完了です。");
    if (login) login.hidden = true;
    if (logout) logout.hidden = true;
    return;
  }
  const next = `${window.location.pathname}${window.location.search}`;
  if (session.authenticated) {
    renderText(status, `${session.email}${session.is_admin ? "（管理者・制限なし）" : ""}`);
    if (login) login.hidden = true;
    if (logout) {
      logout.hidden = false;
      logout.href = `/auth/logout?next=${encodeURIComponent(next)}`;
    }
    return;
  }
  renderText(status, "生成にはGoogleログインが必要です。");
  if (login) {
    login.hidden = false;
    login.href = `/auth/google/login?next=${encodeURIComponent(next)}`;
  }
  if (logout) logout.hidden = true;
}

function renderText(element, text) {
  if (element) {
    element.textContent = text;
  }
}
