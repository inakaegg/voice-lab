import { ArrowRight, FlaskConical } from "lucide-react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, ProductHeader } from "../shared/components";

activateCompactLayout();

function SkitVoiceClosed() {
  return <PageShell className="vibevoice-shell react-skit-shell">
    <ProductHeader product="SkitVoice" title="研究機能" />
    <main className="mx-auto grid w-full max-w-3xl flex-1 place-items-center px-4 py-10 sm:px-6">
      <section className="w-full rounded-[1.75rem] border border-border/75 bg-card/90 p-6 shadow-[0_24px_70px_rgba(31,38,50,0.10)] sm:p-9" aria-labelledby="skitvoice-closed-title">
        <span className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true"><FlaskConical className="size-5" /></span>
        <p className="react-step-label">PRIVATE RESEARCH</p>
        <h2 id="skitvoice-closed-title" className="mt-2 text-2xl font-bold tracking-[-0.035em] sm:text-3xl">研究機能は一般公開していません</h2>
        <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">SkitVoiceは参照音声を扱う研究機能として、現在は管理者専用で検証しています。ここから音声の生成やサンプル再生はできません。</p>
        <a className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-foreground px-5 py-3 font-bold text-background no-underline shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45" href="/speakloop">SpeakLoopで練習する<ArrowRight className="size-4" aria-hidden="true" /></a>
      </section>
    </main>
  </PageShell>;
}

mountPublicPage(<SkitVoiceClosed />);
