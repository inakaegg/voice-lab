import { useEffect, useRef, useState } from "react";

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
}: {
  siteKey: string;
  resetVersion: number;
  onToken: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null);
  const previousResetVersion = useRef(resetVersion);
  const [status, setStatus] = useState("不正利用防止の確認を待っています。");

  useEffect(() => {
    let active = true;
    if (!siteKey) {
      setStatus("不正利用防止の設定を確認できませんでした。");
      onToken("");
      return undefined;
    }
    void loadTurnstile()
      .then(() => {
        if (!active || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: "zoovoice-compose",
          theme: "auto",
          callback: (token: string) => {
            if (!active) return;
            onToken(token);
            setStatus("不正利用防止の確認が完了しました。");
          },
          "expired-callback": () => {
            if (!active) return;
            onToken("");
            setStatus("確認の有効期限が切れました。もう一度確認してください。");
          },
          "error-callback": () => {
            if (!active) return;
            onToken("");
            setStatus("不正利用防止の確認を完了できませんでした。");
          },
        });
      })
      .catch(() => {
        if (!active) return;
        onToken("");
        setStatus("不正利用防止の確認を読み込めませんでした。");
      });
    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, [onToken, siteKey]);

  useEffect(() => {
    if (previousResetVersion.current === resetVersion) return;
    previousResetVersion.current = resetVersion;
    onToken("");
    setStatus("不正利用防止の確認を待っています。");
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [onToken, resetVersion]);

  return <div className="grid justify-items-center gap-2 rounded-xl border border-border/80 bg-muted/35 px-3 py-3">
    <div ref={containerRef} aria-label="不正利用防止の確認" className="min-h-[65px] max-w-full" />
    <p role="status" className="text-center text-xs leading-5 text-muted-foreground">{status}</p>
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
