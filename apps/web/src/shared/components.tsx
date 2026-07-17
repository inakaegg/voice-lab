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
    <div className="react-product-heading">{back && <a className="react-back-link" href="/" aria-label="Voice Labへ戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg></a>}<div><p className="react-eyebrow">{product}</p><h1>{title}</h1></div></div>
    <div className="react-header-tools"><AuthPanel productPath={`/${product.toLowerCase()}`} /><ThemeSettings/></div>
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
    <summary aria-label="配色設定" title="配色設定"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/></svg></summary>
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

export function PrivacyNotice() {
  return <footer className="react-workflow-privacy-note" data-public-privacy-notice><p className="public-privacy-notice">音声は生成・評価のため外部サービスで処理されます。個人情報や機密情報を含む音声は入力しないでください。<a href="/privacy">プライバシーポリシー</a></p></footer>;
}

export function ToastViewport() {
  return <section id="voice-lab-toast-viewport" className="voice-lab-toast-viewport" aria-label="操作結果" aria-live="polite" aria-atomic="false" />;
}

export function SampleAudio({ feature, language, label, fixedTitle = false, customControls = false }: { feature: string; language?: string; label: string; fixedTitle?: boolean; customControls?: boolean }) {
  return <section className="public-sample-audio react-sample-card" data-public-sample-feature={feature} data-public-sample-language={language} data-public-sample-fixed-title={fixedTitle || undefined} hidden aria-label={`${label} サンプル音声`}><div><p className="public-sample-kicker">Sample</p><h2 data-public-sample-title>{label}</h2><p data-public-sample-description hidden /></div><audio data-public-sample-audio data-sample-audio-custom={customControls || undefined} controls preload="metadata" /></section>;
}
