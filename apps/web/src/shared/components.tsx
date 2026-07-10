import { useEffect, useState, type ReactNode } from "react";

type ThemePreference = "light" | "dark" | "system";
const themeStorageKey = "mo-speech-theme";

export function activateCompactLayout(): void {
  document.body.dataset.layout = "compact";
  const preference = storedThemePreference();
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = preference === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
}

export function ProductHeader({ product, title, back = true }: { product: string; title: string; back?: boolean }) {
  return <header className="react-product-header">
    <div className="react-product-heading">{back && <a className="react-back-link" href="/" aria-label="Voice Labへ">←</a>}<div><p className="react-eyebrow">{product}</p><h1>{title}</h1></div></div>
    <div className="react-header-tools"><ThemeSettings/><AuthPanel productPath={`/${product.toLowerCase()}`} /></div>
  </header>;
}

export function ThemeSettings() {
  const [preference, setPreference] = useState<ThemePreference>(() => storedThemePreference());
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = preference;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  const selectTheme = (next: ThemePreference) => {
    setPreference(next);
    try { window.localStorage.setItem(themeStorageKey, next); } catch { /* 配色変更自体は継続する。 */ }
  };
  return <details className="react-theme-settings">
    <summary aria-label="配色設定" title="配色設定"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm9 4.8v-2l-2.2-.7a7 7 0 0 0-.6-1.4l1.1-2-1.4-1.4-2 1.1a7 7 0 0 0-1.4-.6L13.8 3h-2L11 5.2a7 7 0 0 0-1.4.6l-2-1.1-1.4 1.4 1.1 2a7 7 0 0 0-.6 1.4L4.5 10v2l2.2.7a7 7 0 0 0 .6 1.4l-1.1 2 1.4 1.4 2-1.1a7 7 0 0 0 1.4.6l.7 2.2h2l.7-2.2a7 7 0 0 0 1.4-.6l2 1.1 1.4-1.4-1.1-2a7 7 0 0 0 .6-1.4L21 13Z"/></svg></summary>
    <div className="react-theme-menu" role="radiogroup" aria-label="配色">
      {([['light','明色'],['dark','暗色'],['system','システム']] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={preference === value} onClick={() => selectTheme(value)}>{label}</button>)}
    </div>
  </details>;
}

function storedThemePreference(): ThemePreference {
  let value: string | null = null;
  try { value = window.localStorage.getItem(themeStorageKey); } catch { /* systemへfallbackする。 */ }
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function AuthPanel({ productPath }: { productPath: string }) {
  return <section className="public-auth-panel react-auth-panel" data-public-auth-panel hidden aria-label="公開デモのログイン状態"><span data-public-auth-status>ログイン状態を確認中です。</span><a data-public-auth-login href={`/auth/google/login?next=${productPath}`}>Googleでログイン</a><a data-public-auth-logout href="/auth/logout" hidden>ログアウト</a></section>;
}

export function PageShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`react-page-shell ${className}`.trim()}>{children}</main>;
}

export function SampleAudio({ feature, language, label }: { feature: string; language?: string; label: string }) {
  return <section className="public-sample-audio react-sample-card" data-public-sample-feature={feature} data-public-sample-language={language} hidden aria-label={`${label} サンプル音声`}><div><p className="public-sample-kicker">Sample</p><h2 data-public-sample-title>{label}</h2><p data-public-sample-description hidden /></div><audio data-public-sample-audio controls preload="metadata" /></section>;
}
