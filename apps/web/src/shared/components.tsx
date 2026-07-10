import type { ReactNode } from "react";

export function ProductHeader({ product, title, back = true }: { product: string; title: string; back?: boolean }) {
  return <header className="react-product-header">
    <div className="react-product-heading">{back && <a className="react-back-link" href="/" aria-label="Voice Labへ">←</a>}<div><p className="react-eyebrow">{product}</p><h1>{title}</h1></div></div>
    <AuthPanel productPath={`/${product.toLowerCase()}`} />
  </header>;
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
