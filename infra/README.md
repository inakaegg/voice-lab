# infra — Terraformの使い方

更新日: 2026-08-24

CloudflareとGoogle Cloudのクラウド構成は、このディレクトリのTerraformを正本とする。構成の全体像は [docs/deployment/ARCHITECTURE.md](../docs/deployment/ARCHITECTURE.md) を参照する。`infra/cloudflare/` と `infra/gcp/` は独立しており、片方の適用はもう片方へ波及しない。

この文書はTerraformを実行する開発者向けの手順である。`docs/` ではなくここへ置くのは、読者がinfraを触る人に限られ、コードと同じ場所で保守するためである。

## 管理対象

- Cloudflare: KV `MO_SPEECH_KV`、D1 `mo-speech-demo-db`、R2 bucket 2つ（`mo-speech-audio`・`mo-speech-audio-preview`）、Turnstile widget `voice-lab-zoovoice`
- Google Cloud: Cloud Run service `zoovoice` の設定、Artifact Registry `voice-lab`、必要APIの有効化
- Google Cloud（続き）: Secret Manager `zoovoice-openai-api-key` の入れ物とアクセス権、invoker用service account 2つと関連IAM

## 管理対象外

- Workerスクリプト本体とbinding（`wrangler deploy` と `wrangler.toml` が正）
- secretの値（`wrangler secret put` と `gcloud secrets versions add` が正）
- Cloud Runのimage digest（配備scriptが入れ替える。Terraformはimage差分を無視する）

## 認証

Cloudflare側は環境変数 `CLOUDFLARE_API_TOKEN` を使う。対象を絞ったAPI tokenをdashboardで発行するのが安全である。専用tokenを作らない場合は、`wrangler login` 済みのOAuth tokenを流用できる。OAuth tokenは約1時間で切れるため、先に `npx wrangler whoami` で更新してから読み出す。次の抽出コマンドはmacOSの例で、wranglerの内部ファイル形式に依存する暫定手段である。

```sh
export CLOUDFLARE_API_TOKEN=$(grep -m1 '^oauth_token' \
  ~/Library/Preferences/.wrangler/config/default.toml | sed 's/.*= *"\(.*\)"/\1/')
```

Google Cloud側は環境変数 `GOOGLE_OAUTH_ACCESS_TOKEN` を使う。こちらも約1時間で切れる。

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
```

## 使い方

各ディレクトリで `terraform init` の後、`terraform plan` で実物との差分を確認する。既存資産の取り込み定義は `imports.tf` にあり、stateへの取り込みは `terraform import` で行う。planまでは自由に実行してよい。`terraform apply` はクラウド設定の変更にあたるため、そのターンの明示許可を必要とする。

`infra/gcp/` は変数 `smoke_invoker_principal` を必要とする。これはsmoke用service accountの短期tokenを取れる開発者のprincipalであり、値は `infra/gcp/terraform.tfvars` へ書く。個人アカウントを公開リポジトリへ残さないため、`*.tfvars` はgitで管理しない。

```text
smoke_invoker_principal = "user:あなたのGoogleアカウント"
```

stateはローカルファイル（`terraform.tfstate`）で、gitでは管理しない。リモートbackendへ移す場合は、置き場（Cloud Storage bucket等）を明示許可の上で作成し、`terraform { backend }` blockを追加して `terraform init -migrate-state` を実行する。
