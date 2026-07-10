import type { ReactNode } from "react";

export type LayoutVariant = "compact" | "guided" | "studio";

const layoutOptions: Array<{ id: LayoutVariant; label: string; note: string }> = [
  { id: "compact", label: "コンパクト", note: "操作優先" },
  { id: "guided", label: "ガイド", note: "手順優先" },
  { id: "studio", label: "スタジオ", note: "制作画面" },
];

export function activateLayoutVariant(): LayoutVariant {
  const requested = new URLSearchParams(window.location.search).get("layout");
  const variant = layoutOptions.some((option) => option.id === requested) ? requested as LayoutVariant : "compact";
  document.body.dataset.layout = variant;
  return variant;
}

export function ProductHeader({ product, title, back = true }: { product: string; title: string; back?: boolean }) {
  return <header className="react-product-header">
    <div className="react-product-heading">{back && <a className="react-back-link" href="/" aria-label="Voice Labへ">←</a>}<div><p className="react-eyebrow">{product}</p><h1>{title}</h1></div></div>
    <div className="react-header-tools"><LayoutSwitcher/><AuthPanel productPath={`/${product.toLowerCase()}`} /></div>
  </header>;
}

export function LayoutSwitcher() {
  const current = document.body.dataset.layout || "compact";
  return <nav className="react-layout-switcher" aria-label="レイアウト候補">
    {layoutOptions.map((option) => <a key={option.id} href={`${window.location.pathname}?layout=${option.id}`} aria-current={current === option.id ? "page" : undefined}><strong>{option.label}</strong><span>{option.note}</span></a>)}
  </nav>;
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
