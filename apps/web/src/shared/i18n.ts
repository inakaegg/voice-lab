import { useSyncExternalStore } from "react";

import {
  isLocale,
  translateWith,
  type Locale,
  type MessageParams,
} from "./i18n-messages";

export {
  dictionaries,
  isLocale,
  locales,
  translateWith,
  type Dictionary,
  type Locale,
  type Message,
  type MessageKey,
  type MessageParams,
} from "./i18n-messages";

const localeStorageKey = "voice-lab-locale";

// 保存された選択が最優先。無ければブラウザの言語。日本語以外はすべて英語へ寄せる。
export function detectLocale(): Locale {
  if (typeof window === "undefined") return "ja";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(localeStorageKey);
  } catch {
    /* 表示言語は既定へfallbackする。 */
  }
  if (isLocale(stored)) return stored;
  const browserLanguage = window.navigator.language || "";
  return browserLanguage.toLowerCase().startsWith("ja") ? "ja" : "en";
}

// 解決は初回参照まで遅らせる。moduleを読んだだけでwindowを触ると、DOMの無い環境で落ちる。
let currentLocale: Locale | null = null;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  if (currentLocale === null) currentLocale = detectLocale();
  return currentLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// html要素のlang属性も切り替える。読み上げソフトと自動翻訳がこの属性を見るため、
// 本文だけ英語にして lang="ja" が残ると読み方が崩れる。
export function applyLocaleToDocument(locale: Locale = getLocale()): void {
  document.documentElement.lang = locale;
}

export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === getLocale()) return;
  currentLocale = next;
  try {
    window.localStorage.setItem(localeStorageKey, next);
  } catch {
    /* 選択を保存できなくても表示の切り替えは続ける。 */
  }
  applyLocaleToDocument(next);
  for (const listener of listeners) listener();
}

// 画面を段階的に辞書化する間、まだ移していない画面の表示を固定するために使う。
// localStorageの選択は書き換えないので、辞書化済みの画面へ戻れば利用者の選択が復活する。
export function lockLocale(locale: Locale): void {
  if (!isLocale(locale)) return;
  currentLocale = locale;
  applyLocaleToDocument(locale);
}

export function translate(key: string, params?: MessageParams, locale: Locale = getLocale()): string {
  return translateWith(key, locale, params);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

// React側は useT で購読する。localeが変わると呼び出し元が再renderされる。
export function useT(): (key: string, params?: MessageParams) => string {
  const locale = useLocale();
  return (key, params) => translateWith(key, locale, params);
}

// React外(SpeakLoopが後読みするvanilla JS)から同じ辞書を引くための橋渡し。
// 既存の window.voiceLabChineseScript と同じ形にそろえる。
declare global {
  interface Window {
    voiceLabI18n?: {
      t: (key: string, params?: MessageParams) => string;
      getLocale: () => Locale;
      subscribe: (listener: () => void) => () => void;
    };
  }
}

export function exposeI18nBridge(): void {
  window.voiceLabI18n = {
    t: (key, params) => translate(key, params),
    getLocale,
    subscribe: subscribeLocale,
  };
}
