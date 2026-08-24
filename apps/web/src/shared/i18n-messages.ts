// 表示言語ごとの文言。DOMもReactも触らないので、テストからそのまま読める。
// locale状態と切り替えUIは i18n.ts 側に置く。
export type Locale = "ja" | "en";

// 文言は「引数を取らない文字列」か「引数から文を組む関数」のどちらか。
// 英語だけ複数形で形が変わる文があるため、キー単位で関数を許す。i18nライブラリは入れない。
export type MessageParams = Record<string, string | number>;
export type Message = string | ((params: MessageParams) => string);

export type Dictionary = Record<string, Message>;

const ja: Dictionary = {
  "shared.backToVoiceLab": "Voice Labへ戻る",
  "shared.githubRepository": "GitHubリポジトリ",
  "shared.githubTooltip": "実際の動作を動画で確認できます",
  "shared.themeSettings": "配色設定",
  "shared.theme": "配色",
  "shared.themeLight": "明色",
  "shared.themeDark": "暗色",
  "shared.themeSystem": "システム",
  "shared.languageSettings": "表示言語の設定",
  "shared.language": "表示言語",
  "shared.languageJa": "日本語",
  "shared.languageEn": "English",
  "shared.authPanel": "公開デモのログイン状態",
  "shared.authStatusChecking": "ログイン状態を確認中です。",
  "shared.authLogin": "Googleでログイン",
  "shared.authLogout": "ログアウト",
  "shared.privacyNotice": "音声は生成・評価のため外部サービスで処理され、Voice Labの履歴には保存されません。個人情報や機密情報を含む音声は入力しないでください。",
  "shared.privacyPolicy": "プライバシーポリシー",
  "shared.techStack": "使用技術",
  "shared.toastViewport": "操作結果",
  "shared.sampleAudio": ({ label }) => `${label} サンプル音声`,

  "zoovoice.headerTitle": "声から動物を連想する",
  "zoovoice.tagline": "話すだけで、ぴったりの動物を。",
  "zoovoice.lead": "話した内容から動物を選び、その鳴き声を言葉の切れ目へ差し込みます。",
  "zoovoice.recordTitle": "声を録音する",
  "zoovoice.recordDescription": "停止すると自動で生成を開始します。60秒で自動停止した場合も送信します。",
  "zoovoice.animalCount": "動物の数",
  "zoovoice.animalCountOption": ({ count }) => `${count}種`,
  "zoovoice.intensityLabel": "アニマル度",
  "zoovoice.intensityLow": "ひかえめ",
  "zoovoice.intensityHigh": "にぎやか",
  "zoovoice.intensityAppliesNextRecording": "次の録音に反映",
  "zoovoice.intensityAppliesNextRetry": "次の再生成にも反映",
  "zoovoice.regenerate": "もう一度生成",
  "zoovoice.resultTitle": "連想された動物",
  "zoovoice.resultDescription": "聞き取った言葉と選んだ理由も確認できます。",
  "zoovoice.resultPlaceholder": "録音を止めると、選ばれた動物と鳴き声入り音声をここに表示します。",
  "zoovoice.heardWords": "聞き取った言葉",
  "zoovoice.animalReason": ({ animal }) => `${animal}を選んだ理由`,
  "zoovoice.animalJoiner": "」と「",
  "zoovoice.insertionSummary": ({ count, animals }) => `${count}か所に「${animals}」の鳴き声を差し込みました。`,
  "zoovoice.soundCreditsHeading": "鳴き声素材の出典（無音除去・トリム・音量調整を実施）",
  "zoovoice.soundCreditSource": "出典",

  "zoovoice.status.preparing": "準備しています。",
  "zoovoice.status.micPreparing": "マイクを準備しています。",
  "zoovoice.status.checkingRecording": "録音を確認しています。",
  "zoovoice.status.cancelled": "録音をキャンセルしました。音声は送信していません。",
  "zoovoice.status.tooShort": "録音が短すぎました。0.5秒以上話してください。",
  "zoovoice.status.verifying": "不正利用防止の確認を待っています。",
  "zoovoice.status.composing": "声を聞き取り、動物を連想して合成しています。",
  "zoovoice.status.fallback": "関連する動物が見つからなかったため、ランダムに選びました。",
  "zoovoice.status.success": "できあがりました。自動再生を開始します。",

  "zoovoice.error.unavailable": "Zoovoiceは現在利用できません。",
  "zoovoice.error.setupFailed": "Zoovoiceを準備できませんでした。",
  "zoovoice.error.composeFailed": "音声を生成できませんでした。もう一度お試しください。",
  "zoovoice.error.verifyTimeout": "不正利用防止の確認を完了できませんでした。ページを再読み込みするか、もう一度録音してください。",
  "zoovoice.error.micDenied": "マイクを使用できません。ブラウザの権限を確認してください。",
  "zoovoice.error.micUnavailable": "マイクを使用できません。ブラウザの設定を確認してください。",

  "zoovoice.api.configLoadFailed": "Zoovoiceの設定を読み込めませんでした。",
  "zoovoice.api.configVerifyFailed": "Zoovoiceの設定を確認できませんでした。",
  "zoovoice.api.composeFailed": "音声を生成できませんでした。",
  "zoovoice.api.resultVerifyFailed": "生成結果を確認できませんでした。",
  "zoovoice.api.networkFailed": "ネットワークに接続できませんでした。接続を確認してもう一度お試しください。",

  "zoovoice.orb.stopRecording": "録音を止める",
  "zoovoice.orb.record": "録音する",
  "zoovoice.orb.micLevel": "マイク入力レベル",
  "zoovoice.orb.cancel": "録音をキャンセル",
  "zoovoice.orb.recording": "録音中",
  "zoovoice.orb.generating": "生成中",
  "zoovoice.orb.tapToSpeak": "タップして話す",

  "zoovoice.turnstile.setupFailed": "不正利用防止の確認を準備できませんでした。ページを再読み込みしてください。",
  "zoovoice.turnstile.retrying": "不正利用防止の確認を再試行しています。",
  "zoovoice.turnstile.completeCheck": "表示されている確認を完了してください。",
  "zoovoice.turnstile.label": "不正利用防止の確認",

  "zoovoice.player.pause": "結果を一時停止",
  "zoovoice.player.play": "結果を再生",
  "zoovoice.player.position": "再生位置",
  "zoovoice.player.saveWav": "WAVを保存",
};

const en: Dictionary = {
  "shared.backToVoiceLab": "Back to Voice Lab",
  "shared.githubRepository": "GitHub repository",
  "shared.githubTooltip": "See it running in a short video",
  "shared.themeSettings": "Theme settings",
  "shared.theme": "Theme",
  "shared.themeLight": "Light",
  "shared.themeDark": "Dark",
  "shared.themeSystem": "System",
  "shared.languageSettings": "Display language settings",
  "shared.language": "Display language",
  "shared.languageJa": "日本語",
  "shared.languageEn": "English",
  "shared.authPanel": "Sign-in state for the public demo",
  "shared.authStatusChecking": "Checking your sign-in state.",
  "shared.authLogin": "Sign in with Google",
  "shared.authLogout": "Sign out",
  "shared.privacyNotice": "Your audio is processed by external services to generate and score the result, and it is not kept in Voice Lab's history. Do not record anything personal or confidential.",
  "shared.privacyPolicy": "Privacy policy",
  "shared.techStack": "Built with",
  "shared.toastViewport": "Action result",
  "shared.sampleAudio": ({ label }) => `${label} sample audio`,

  "zoovoice.headerTitle": "Animals conjured from your voice",
  "zoovoice.tagline": "Just speak, and meet your animal.",
  "zoovoice.lead": "We pick animals from what you said and splice their calls in at the word boundaries.",
  "zoovoice.recordTitle": "Record your voice",
  "zoovoice.recordDescription": "Generation starts as soon as you stop. A recording that auto-stops at 60 seconds is sent too.",
  "zoovoice.animalCount": "How many animals",
  "zoovoice.animalCountOption": ({ count }) => Number(count) === 1 ? "1 kind" : `${count} kinds`,
  "zoovoice.intensityLabel": "Animal level",
  "zoovoice.intensityLow": "Subtle",
  "zoovoice.intensityHigh": "Lively",
  "zoovoice.intensityAppliesNextRecording": "Applies to your next recording",
  "zoovoice.intensityAppliesNextRetry": "Applies to the next take as well",
  "zoovoice.regenerate": "Generate again",
  "zoovoice.resultTitle": "The animal we picked",
  "zoovoice.resultDescription": "You can also see what we heard and why this animal came up.",
  "zoovoice.resultPlaceholder": "Stop the recording and the chosen animal, with your voice mixed, appears here.",
  "zoovoice.heardWords": "What we heard",
  "zoovoice.animalReason": ({ animal }) => `Why ${animal}`,
  "zoovoice.animalJoiner": " and ",
  "zoovoice.insertionSummary": ({ count, animals }) => Number(count) === 1
    ? `Spliced in one ${animals} call at a single word boundary.`
    : `Spliced in ${animals} calls at ${count} word boundaries.`,
  "zoovoice.soundCreditsHeading": "Sources for the animal calls (silence removed, trimmed, volume adjusted)",
  "zoovoice.soundCreditSource": "Source",

  "zoovoice.status.preparing": "Getting ready.",
  "zoovoice.status.micPreparing": "Preparing the microphone.",
  "zoovoice.status.checkingRecording": "Checking the recording.",
  "zoovoice.status.cancelled": "Recording cancelled. Nothing was sent.",
  "zoovoice.status.tooShort": "That recording was too short. Please speak for at least half a second.",
  "zoovoice.status.verifying": "Waiting for the anti-abuse check.",
  "zoovoice.status.composing": "Transcribing your voice, picking an animal, and mixing the audio.",
  "zoovoice.status.fallback": "No related animal came up, so one was picked at random.",
  "zoovoice.status.success": "Done. Playing it back now.",

  "zoovoice.error.unavailable": "zoovoice is unavailable right now.",
  "zoovoice.error.setupFailed": "Could not set up zoovoice.",
  "zoovoice.error.composeFailed": "Could not generate the audio. Please try again.",
  "zoovoice.error.verifyTimeout": "The anti-abuse check could not be completed. Reload the page, or record again.",
  "zoovoice.error.micDenied": "The microphone is unavailable. Check your browser permissions.",
  "zoovoice.error.micUnavailable": "The microphone is unavailable. Check your browser settings.",

  "zoovoice.api.configLoadFailed": "Could not load the zoovoice settings.",
  "zoovoice.api.configVerifyFailed": "Could not verify the zoovoice settings.",
  "zoovoice.api.composeFailed": "Could not generate the audio.",
  "zoovoice.api.resultVerifyFailed": "Could not verify the generated result.",
  "zoovoice.api.networkFailed": "Could not reach the network. Check your connection and try again.",

  "zoovoice.orb.stopRecording": "Stop recording",
  "zoovoice.orb.record": "Record",
  "zoovoice.orb.micLevel": "Microphone input level",
  "zoovoice.orb.cancel": "Cancel recording",
  "zoovoice.orb.recording": "Recording",
  "zoovoice.orb.generating": "Generating",
  "zoovoice.orb.tapToSpeak": "Tap and speak",

  "zoovoice.turnstile.setupFailed": "Could not set up the anti-abuse check. Please reload the page.",
  "zoovoice.turnstile.retrying": "Retrying the anti-abuse check.",
  "zoovoice.turnstile.completeCheck": "Please complete the check shown here.",
  "zoovoice.turnstile.label": "Anti-abuse check",

  "zoovoice.player.pause": "Pause the result",
  "zoovoice.player.play": "Play the result",
  "zoovoice.player.position": "Playback position",
  "zoovoice.player.saveWav": "Save as WAV",
};

export const dictionaries: Record<Locale, Dictionary> = { ja, en };

export type MessageKey = keyof typeof ja;

export const locales: readonly Locale[] = ["ja", "en"];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

// 辞書に無いキーは日本語辞書、それも無ければキー自体を返す。画面が空白になるより、
// どのキーが未登録なのか分かる方が直しやすい。
export function translateWith(
  key: string,
  locale: Locale,
  params?: MessageParams,
): string {
  const message = dictionaries[locale][key] ?? dictionaries.ja[key];
  if (message === undefined) return key;
  return typeof message === "function" ? message(params ?? {}) : message;
}
