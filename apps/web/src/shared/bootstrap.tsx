import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import { applyLocaleToDocument, exposeI18nBridge, lockLocale } from "./i18n";

export function mountPublicPage(
  page: ReactNode,
  legacyScripts: string[] = [],
  options: { localized?: boolean } = {},
): void {
  const root = document.querySelector<HTMLElement>("#root");
  if (!root) throw new Error("React root is missing");
  // 表示言語を効かせるのは、文言を辞書へ移し終えた画面だけ。まだ移していない画面で共通部分だけ
  // 英語になると、利用者には壊れて見える。英語ブラウザからの直接訪問でも、辞書化済みの画面で
  // 英語を選んだ後の遷移でも同じなので、locale自体を日本語へ固定して防ぐ。移し終えたら外す。
  if (options.localized) {
    applyLocaleToDocument();
  } else {
    lockLocale("ja");
  }
  // React外のスクリプトが同じ辞書を引けるよう、後読みするスクリプトより先に橋渡しを置く。
  exposeI18nBridge();
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
