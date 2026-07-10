import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

export function mountPublicPage(page: ReactNode, legacyScripts: string[] = []): void {
  const root = document.querySelector<HTMLElement>("#root");
  if (!root) throw new Error("React root is missing");
  flushSync(() => createRoot(root).render(page));
  void loadScripts(legacyScripts);
}

async function loadScripts(sources: string[]): Promise<void> {
  for (const source of sources) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`script load failed: ${source}`));
      document.body.append(script);
    });
  }
}
