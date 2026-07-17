import { ArrowUpRight, AudioWaveform, Mic2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, ThemeSettings } from "../shared/components";

import "./styles.css";

activateCompactLayout();

const products = [
  {
    number: "01",
    name: "SpeakLoop",
    title: "言いたいことで発音練習",
    description: "母国語で話し、模範音声を聞いて、学習対象言語で復唱します。",
    action: "練習をはじめる",
    href: "/speakloop",
    icon: Mic2,
    tone: "portal-product-link-speak",
  },
] as const;

function Portal() {
  return <main className="relative isolate flex min-h-svh min-w-0 flex-col overflow-clip bg-background text-foreground" aria-label="Voice Lab">
    <div className="portal-atmosphere" aria-hidden="true" />
    <header className="relative z-20 mx-auto flex h-16 w-full max-w-[1180px] shrink-0 items-center justify-between px-5 sm:h-[4.5rem] sm:px-8">
      <div className="flex items-center gap-2.5 font-semibold tracking-[-0.02em]">
        <span className="flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card/75 text-foreground shadow-sm backdrop-blur-xl" aria-hidden="true"><AudioWaveform className="size-[1.15rem]" strokeWidth={1.9} /></span>
        <span>Voice Lab</span>
      </div>
      <ThemeSettings />
    </header>

    <section className="relative z-10 mx-auto grid w-full max-w-[1180px] min-w-0 flex-1 content-center gap-6 px-5 pb-7 pt-2 sm:px-8 sm:pb-9 min-[900px]:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] min-[900px]:items-center min-[900px]:gap-12 min-[900px]:py-8 lg:gap-16">
      <header className="min-w-0 max-w-[34rem]">
        <p className="mb-4 text-[0.72rem] font-bold uppercase tracking-[0.2em] text-muted-foreground sm:mb-5">Voice Lab · AI voice playground</p>
        <h1 className="text-[clamp(2.65rem,5.6vw,4rem)] font-bold leading-[0.94] tracking-[-0.065em] text-balance">
          <span className="block">声から、</span>
          <span className="block">ことばの体験を</span>
          <span className="block">つくる。</span>
        </h1>
        <p className="mt-5 max-w-[31rem] text-[0.95rem] leading-7 text-muted-foreground sm:mt-6 sm:text-base sm:leading-8">自分が言いたいことを、学びたい言語の発音練習へ。話して、聞いて、まねして、比べられます。</p>
      </header>

      <nav className="min-w-0" aria-label="アプリを選ぶ">
        <Card className="gap-0 overflow-hidden rounded-[1.75rem] border-border/75 bg-card/85 py-0 shadow-[0_28px_80px_rgba(31,38,50,0.11)] backdrop-blur-xl dark:shadow-[0_28px_80px_rgba(0,0,0,0.28)]">
          <CardContent className="p-0">
            {products.map(({ number, name, title, description, action, href, icon: Icon, tone }) => <a
              className={`portal-product-link group relative grid min-h-[10.2rem] min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] items-center gap-3 px-[1.125rem] py-5 text-foreground no-underline transition-colors duration-200 before:absolute before:inset-y-5 before:left-0 before:w-1 before:rounded-r-full before:bg-[var(--product-accent)] hover:bg-muted/45 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/45 motion-reduce:transition-none sm:min-h-[10.6rem] sm:grid-cols-[3rem_minmax(0,1fr)_2.75rem] sm:gap-4 sm:px-6 sm:py-6 ${tone}`}
              href={href}
              key={href}
            >
              <span className="flex size-11 items-center justify-center rounded-2xl bg-[var(--product-soft)] text-[var(--product-accent)] sm:size-12" aria-hidden="true"><Icon className="size-5 sm:size-[1.35rem]" strokeWidth={1.8} /></span>
              <span className="min-w-0">
                <span className="mb-1.5 flex items-center gap-2 text-[0.7rem] font-bold uppercase tracking-[0.14em] text-muted-foreground"><span>{number}</span><span aria-hidden="true">·</span><span>{name}</span></span>
                <h2 className="m-0 break-keep text-[1.25rem] font-bold leading-tight tracking-[-0.035em] sm:text-[1.45rem]">{name === "SpeakLoop" ? <>言いたいことで<wbr />発音練習</> : title}</h2>
                <span className="mt-2 block text-[0.82rem] leading-[1.65] text-muted-foreground sm:text-[0.9rem]">{description}</span>
                <span className="mt-2.5 inline-flex items-center gap-1 text-[0.78rem] font-bold text-[var(--product-accent)] sm:text-[0.82rem]">{action}<ArrowUpRight className="size-3.5" aria-hidden="true" /></span>
              </span>
              <span className="flex size-10 items-center justify-center rounded-full border border-border/80 bg-background/65 text-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-reduce:transition-none sm:size-11" aria-hidden="true"><ArrowUpRight className="size-[1.1rem]" strokeWidth={1.8} /></span>
            </a>)}
          </CardContent>
        </Card>
      </nav>
    </section>
  </main>;
}

mountPublicPage(<Portal />);
