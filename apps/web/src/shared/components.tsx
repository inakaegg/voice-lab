import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { setLocale, useLocale, useT, type Locale } from "./i18n";

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

export function GitHubRepositoryLink({ tooltipId }: { tooltipId: string }) {
  const t = useT();
  return <a
    className="portal-github-link group"
    href="https://github.com/inakaegg/voice-lab"
    target="_blank"
    rel="noopener noreferrer"
    aria-label={t("shared.githubRepository")}
    aria-describedby={tooltipId}
  >
    <img className="portal-github-mark portal-github-mark-black" src="/react/github-invertocat-black.svg" width="98" height="96" alt="" aria-hidden="true" />
    <img className="portal-github-mark portal-github-mark-white" src="/react/github-invertocat-white.svg" width="98" height="96" alt="" aria-hidden="true" />
    <span id={tooltipId} role="tooltip" className="portal-github-tooltip">{t("shared.githubTooltip")}</span>
  </a>;
}

// languageSwitch は表示言語の切り替えを載せる画面だけ true にする。文言をまだ辞書へ移していない
// 画面に切替UIを出すと、切り替えたのに本文が日本語のままで、利用者には故障に見えるため。
export function ProductHeader({ product, title, badge, back = true, githubLink = false, languageSwitch = false }: { product: string; title: string; badge?: string; back?: boolean; githubLink?: boolean; languageSwitch?: boolean }) {
  const t = useT();
  return <header className="react-product-header">
    <div className="react-product-heading">{back && <a className="react-back-link" href="/" aria-label={t("shared.backToVoiceLab")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></svg></a>}<div><p className="react-eyebrow">{product}</p><h1>{title}{badge && <span className="ml-2 inline-block whitespace-nowrap rounded-full border border-[var(--react-border)] px-2 py-0.5 align-middle text-[0.62rem] font-bold tracking-[0.08em] text-[var(--react-muted)]">{badge}</span>}</h1></div></div>
    <div className="react-header-tools"><AuthPanel productPath={`/${product.toLowerCase()}`} /><div className="react-header-actions">{githubLink && <GitHubRepositoryLink tooltipId={`${product.toLowerCase()}-github-tooltip`} />}{languageSwitch && <LanguageSettings/>}<ThemeSettings/></div></div>
  </header>;
}

// detailsを外側クリックとEscapeで閉じる。配色設定と表示言語設定が同じ挙動を要するため共有する。
function useDetailsAutoClose(detailsRef: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      const details = detailsRef.current;
      if (event.key !== "Escape" || !details?.open) {
        return;
      }
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [detailsRef]);
}

// 表示言語の切り替え。見た目は配色設定と同じdetailsなので、スタイルは
// react-theme-settings / react-theme-menu を共有し、固有の調整だけ
// react-language-settings / react-language-menu で足す。
export function LanguageSettings() {
  const t = useT();
  const locale = useLocale();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsAutoClose(detailsRef);
  const options: ReadonlyArray<[Locale, string]> = [["ja", t("shared.languageJa")], ["en", t("shared.languageEn")]];
  return <details ref={detailsRef} className="react-theme-settings react-language-settings">
    <summary aria-label={t("shared.languageSettings")} title={t("shared.languageSettings")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/></svg></summary>
    <div className="react-theme-menu react-language-menu" role="radiogroup" aria-label={t("shared.language")}>
      {options.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={locale === value} onClick={() => setLocale(value)}>{label}</button>)}
    </div>
  </details>;
}

export function ThemeSettings() {
  const t = useT();
  const [preference, setPreference] = useState<ThemePreference>(() => storedThemePreference());
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsAutoClose(detailsRef);
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
  return <details ref={detailsRef} className="react-theme-settings">
    <summary aria-label={t("shared.themeSettings")} title={t("shared.themeSettings")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/></svg></summary>
    <div className="react-theme-menu" role="radiogroup" aria-label={t("shared.theme")}>
      {([['light', t("shared.themeLight")], ['dark', t("shared.themeDark")], ['system', t("shared.themeSystem")]] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={preference === value} onClick={() => selectTheme(value)}>{label}</button>)}
    </div>
  </details>;
}

function storedThemePreference(): ThemePreference {
  let value: string | null = null;
  try { value = window.localStorage.getItem(themeStorageKey); } catch { /* systemへfallbackする。 */ }
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function AuthPanel({ productPath }: { productPath: string }) {
  const t = useT();
  return <section className="public-auth-panel react-auth-panel" data-public-auth-panel hidden aria-label={t("shared.authPanel")}><span data-public-auth-status>{t("shared.authStatusChecking")}</span><a data-public-auth-login href={`/auth/google/login?next=${productPath}`}>{t("shared.authLogin")}</a><a data-public-auth-logout href="/auth/logout" hidden>{t("shared.authLogout")}</a></section>;
}

export function PageShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`react-page-shell ${className}`.trim()}>{children}</main>;
}

export function PrivacyNotice() {
  const t = useT();
  return <footer className="react-workflow-privacy-note" data-public-privacy-notice><p className="public-privacy-notice">{t("shared.privacyNotice")}<a href="/privacy">{t("shared.privacyPolicy")}</a></p></footer>;
}

export function TechStackNote({ items, className = "" }: { items: readonly string[]; className?: string }) {
  const t = useT();
  return <p className={`mx-auto w-full max-w-6xl px-4 pb-2 pt-1 text-center text-[0.68rem] leading-5 text-muted-foreground ${className}`.trim()} data-tech-note>{t("shared.techStack")}: {items.join(" · ")}</p>;
}

export function ToastViewport() {
  const t = useT();
  return <section id="voice-lab-toast-viewport" className="voice-lab-toast-viewport" aria-label={t("shared.toastViewport")} aria-live="polite" aria-atomic="false" />;
}

export function SampleAudio({ feature, language, label, fixedTitle = false, customControls = false }: { feature: string; language?: string; label: string; fixedTitle?: boolean; customControls?: boolean }) {
  const t = useT();
  return <section className="public-sample-audio react-sample-card" data-public-sample-feature={feature} data-public-sample-language={language} data-public-sample-fixed-title={fixedTitle || undefined} hidden aria-label={t("shared.sampleAudio", { label })}><div><p className="public-sample-kicker">Sample</p><h2 data-public-sample-title>{label}</h2><p data-public-sample-description hidden /></div><audio data-public-sample-audio data-sample-audio-custom={customControls || undefined} controls preload="metadata" /></section>;
}
