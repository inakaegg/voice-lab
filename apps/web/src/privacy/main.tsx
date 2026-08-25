import { ArrowLeft } from "lucide-react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, DisplaySettings } from "../shared/components";
import { useLocale, useT } from "../shared/i18n";

activateCompactLayout();

function PrivacyPolicy() {
  const t = useT();
  const locale = useLocale();
  return <main className="min-h-svh bg-background text-foreground">
    <header className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-5 sm:h-[4.5rem] sm:px-8">
      <a className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-foreground no-underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45" href="/">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voice Lab
      </a>
      <DisplaySettings language />
    </header>

    <article className="mx-auto w-full max-w-4xl px-5 pb-16 pt-8 sm:px-8 sm:pt-12">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">Privacy</p>
      <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">{t("privacy.heading")}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{t("privacy.lastUpdated")}</p>

      {locale === "en" && <p className="mt-4 rounded-lg border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{t("privacy.translationNotice")}</p>}

      <div className="mt-10 space-y-10 text-[0.95rem] leading-7">
        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">{t("privacy.collectHeading")}</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>{t("privacy.collectEmail")}</li>
            <li>{t("privacy.collectCount")}</li>
            <li>{t("privacy.collectHash")}</li>
            <li>{t("privacy.collectAdmin")}</li>
            <li>{t("privacy.collectAudio")}</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">{t("privacy.audioHeading")}</h2>
          <p className="mt-4">{t("privacy.audioBody")}</p>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">{t("privacy.retentionHeading")}</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>{t("privacy.retentionCookie")}</li>
            <li>{t("privacy.retentionShortLived")}</li>
            <li>{t("privacy.retentionDailyCount")}</li>
            <li>{t("privacy.retentionOperationLog")}</li>
            <li>{t("privacy.retentionCumulative")}</li>
            <li>{t("privacy.retentionEmail")}</li>
          </ul>
        </section>
      </div>
    </article>
  </main>;
}

mountPublicPage(<PrivacyPolicy />, [], { localized: true, titleKey: "privacy.pageTitle" });
