import { ArrowLeft } from "lucide-react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, ThemeSettings } from "../shared/components";

activateCompactLayout();

const externalLinkProps = { target: "_blank", rel: "noreferrer" } as const;

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
      <p className="mt-3 text-sm text-muted-foreground">最終更新日: 2026年7月17日</p>

      <div className="mt-10 space-y-10 text-[0.95rem] leading-7">
        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">扱う情報と目的</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>Googleログインのメールアドレスを、ログイン確認と利用回数の制限に使います。</li>
            <li>利用回数の記録と監査ログには、メールアドレスそのものではなくSHA-256で変換した識別子を保存します。</li>
            <li>入力した音声・テキストと生成音声を、翻訳、音声生成、発音評価のために処理します。</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">音声の保存</h2>
          <p className="mt-4">Cloudflare公開版は、利用者の入力音声と生成音声をVoice Labの履歴として保存しません。処理結果を受け渡す短期データには生成音声が含まれる場合があり、1時間で失効します。外部処理事業者側の保持は各社の条件に従います。</p>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">保持期間</h2>
          <ul className="mt-4 list-disc space-y-2 pl-6">
            <li>Googleログイン用cookie: 30日。ログアウト時は直ちに削除します。</li>
            <li>処理結果の短期データ: 1時間。</li>
            <li>1日ごとの利用回数: 48時間。</li>
            <li>監査ログ: 90日。</li>
            <li>累計利用回数と対応する識別子: 利用上限を維持するため公開デモの運用中。公開デモ終了時に削除します。</li>
          </ul>
          <p className="mt-4">期限のある1日ごとの利用回数と監査ログは、Cloudflare Workerの日次処理で削除します。</p>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">外部処理事業者</h2>
          <ul className="mt-4 space-y-3">
            <li><strong>Cloudflare</strong>: Web配信、認証中継、利用回数の記録、短期データ、監査ログ。<a className="underline underline-offset-4" href="https://www.cloudflare.com/privacypolicy/" {...externalLinkProps}>プライバシーポリシー</a></li>
            <li><strong>Google</strong>: Google OAuthログイン。<a className="underline underline-offset-4" href="https://policies.google.com/privacy?hl=ja" {...externalLinkProps}>プライバシーポリシー</a></li>
            <li><strong>OpenAI</strong>: 音声認識、翻訳、テキスト加工、音声生成。<a className="underline underline-offset-4" href="https://platform.openai.com/docs/models/default-usage-policies-by-endpoint" {...externalLinkProps}>APIデータ管理</a></li>
            <li><strong>RunPod</strong>: 中国語音声認識と、利用者が選んだ場合の声質変換。<a className="underline underline-offset-4" href="https://www.runpod.io/legal/privacy-policy" {...externalLinkProps}>プライバシーポリシー</a></li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold tracking-[-0.02em]">問い合わせ</h2>
          <p className="mt-4">保存情報についての問い合わせは、GitHub repositoryのSecurity画面にある <a className="underline underline-offset-4" href="https://github.com/inakaegg/voice-lab/security/advisories/new" {...externalLinkProps}>Report a vulnerability</a> から非公開で連絡してください。削除依頼では、Googleログインに使ったメールアドレスの確認をお願いする場合があります。公開Issueへ個人情報を投稿しないでください。</p>
        </section>
      </div>
    </article>
  </main>;
}

mountPublicPage(<PrivacyPolicy />);
