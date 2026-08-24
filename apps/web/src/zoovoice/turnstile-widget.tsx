import { useEffect, useRef, useState } from "react";

import { useLocale, useT } from "../shared/i18n";

type TurnstileWidgetId = string;

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => TurnstileWidgetId;
  reset: (widgetId: TurnstileWidgetId) => void;
  remove: (widgetId: TurnstileWidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

export function TurnstileWidget({
  siteKey,
  resetVersion,
  onToken,
  onUnavailable,
  onInteractionChange,
}: {
  siteKey: string;
  resetVersion: number;
  onToken: (token: string) => void;
  onUnavailable: (messageKey: string) => void;
  onInteractionChange: (interactive: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null);
  const previousResetVersion = useRef(resetVersion);
  const onTokenRef = useRef(onToken);
  const onUnavailableRef = useRef(onUnavailable);
  const onInteractionChangeRef = useRef(onInteractionChange);
  // 待機中・完了・自動更新中は文言を出さない。Cloudflareのwidgetだけで足りるため、
  // 利用者の操作が必要なときと失敗したときだけ説明を表示する。
  const t = useT();
  const locale = useLocale();
  const [statusKey, setStatusKey] = useState("");
  onTokenRef.current = onToken;
  onUnavailableRef.current = onUnavailable;
  onInteractionChangeRef.current = onInteractionChange;

  useEffect(() => {
    let active = true;
    if (!siteKey) {
      const messageKey = "zoovoice.turnstile.setupFailed";
      setStatusKey(messageKey);
      onTokenRef.current("");
      onUnavailableRef.current(messageKey);
      return undefined;
    }
    void loadTurnstile()
      .then(() => {
        if (!active || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: "zoovoice-compose",
          theme: "auto",
          // widget内の文言はCloudflare側が描くので、表示言語をここで渡さないと切り替えても追随しない。
          language: locale,
          retry: "auto",
          "refresh-expired": "auto",
          "refresh-timeout": "auto",
          callback: (token: string) => {
            if (!active) return;
            onTokenRef.current(token);
            onInteractionChangeRef.current(false);
            setStatusKey("");
          },
          "expired-callback": () => {
            if (!active) return;
            onTokenRef.current("");
            setStatusKey("");
          },
          "error-callback": () => {
            if (!active) return;
            onTokenRef.current("");
            setStatusKey("zoovoice.turnstile.retrying");
          },
          "before-interactive-callback": () => {
            if (!active) return;
            onInteractionChangeRef.current(true);
            setStatusKey("zoovoice.turnstile.completeCheck");
          },
          "after-interactive-callback": () => {
            if (!active) return;
            onInteractionChangeRef.current(false);
            setStatusKey("");
          },
        });
      })
      .catch(() => {
        if (!active) return;
        const messageKey = "zoovoice.turnstile.setupFailed";
        onTokenRef.current("");
        setStatusKey(messageKey);
        onUnavailableRef.current(messageKey);
      });
    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
      onInteractionChangeRef.current(false);
    };
  }, [siteKey, locale]);

  useEffect(() => {
    if (previousResetVersion.current === resetVersion) return;
    previousResetVersion.current = resetVersion;
    onTokenRef.current("");
    setStatusKey("");
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetVersion]);

  return <div className="grid justify-items-center gap-2 rounded-xl border border-border/80 bg-muted/35 px-3 py-3">
    <div ref={containerRef} aria-label={t("zoovoice.turnstile.label")} className="min-h-[65px] max-w-full" />
    {statusKey
      ? <p role="status" className="text-center text-xs leading-5 text-muted-foreground">{t(statusKey)}</p>
      : null}
  </div>;
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  const pending = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-zoovoice-turnstile]");
    const script = existing || document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile script failed")), { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.zoovoiceTurnstile = "1";
      document.head.append(script);
    }
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  scriptPromise = pending;
  return pending;
}
