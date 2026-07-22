import { ArrowLeft } from "lucide-react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, ThemeSettings } from "../shared/components";

activateCompactLayout();

function PrivacyPolicy() {
  return <main className="min-h-svh bg-background text-foreground">
    <header className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-5 sm:h-[4.5rem] sm:px-8">
      <a className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-foreground no-underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45" href="/">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Voice Lab
      </a>
      <ThemeSettings />
    </header>

    <article className="mx-auto w-full max-w-4xl px-5 pb-16 pt-8 sm:px-8 sm:pt-12">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">Privacy</p>
      <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">プライバシーポリシー</h1>
      <p className="mt-3 text-sm text-muted-foreground">最終更新日: 2026年7月21日</p>

      <div className="mt-10 space-y-10 text-[0.95rem] leading-7">
        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">扱う情報と目的</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>Googleログインのメールアドレスを、ログイン確認と利用回数の制限に使います。</li>
            <li>利用上限を管理するため、利用者ごとの利用回数を記録します。音声や入力内容はこの記録に含まれません。</li>
            <li>利用回数の記録と操作ログには、メールアドレスそのものではなくSHA-256で変換した識別子を保存します。</li>
            <li>ログインしたメールアドレスと日時は、運営者が管理画面で確認できる形で保存します。利用状況の把握と不正利用の確認に使います。</li>
            <li>入力した音声・テキストと生成音声を、翻訳、音声生成、発音評価のために処理します。</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">音声の取り扱い</h2>
          <p className="mt-4">Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しません。処理のため、入力音声・テキストはCloudflareを経由してOpenAIまたはRunPodへ送られます。処理結果を受け渡す短期データには生成音声が含まれる場合があり、1時間で失効します。</p>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">保持期間</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>Googleログイン用cookie: 30日。ログアウト時は直ちに削除します。</li>
            <li>処理結果の短期データ: 1時間。</li>
            <li>日ごとの利用回数は、利用日から3日以内に削除します。</li>
            <li>操作ログは、約90日間保存します。</li>
            <li>累計利用回数と対応する識別子: 利用上限を維持するため公開デモの運用中。公開デモ終了時に削除します。</li>
            <li>ログインしたメールアドレスと日時: 公開デモの運用中。公開デモ終了時に削除します。</li>
          </ul>
        </section>
      </div>
    </article>
  </main>;
}

mountPublicPage(<PrivacyPolicy />);
