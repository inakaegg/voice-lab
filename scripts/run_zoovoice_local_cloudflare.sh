#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 {local|cloud-run}" >&2
}

fail() {
  echo "$1" >&2
  exit 1
}

required_file() {
  local name=$1
  local value=$2
  [[ -n "$value" ]] || fail "$name is required"
  [[ -f "$value" ]] || fail "$name must be a regular file"
}

canonical_file() {
  local value=$1
  local directory
  local filename
  if [[ "$value" == */* ]]; then
    directory=${value%/*}
    filename=${value##*/}
  else
    directory=.
    filename=$value
  fi
  directory=$(cd "$directory" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$directory" "$filename"
}

mode=${1:-}
case "$mode" in
  local|cloud-run) ;;
  *)
    usage
    exit 64
    ;;
esac

script_directory=${BASH_SOURCE[0]%/*}
repository_root=$(cd "$script_directory/.." && pwd -P)
persist_directory="$repository_root/tmp/zoovoice-wrangler"
dry_run=${ZOOVOICE_DRY_RUN:-0}
browser_port=${ZOOVOICE_DEV_PORT:-8787}
api_port=${ZOOVOICE_API_PORT:-8090}
[[ "$browser_port" =~ ^[0-9]{2,5}$ ]] || fail "ZOOVOICE_DEV_PORT must be a port number"
[[ "$api_port" =~ ^[0-9]{2,5}$ ]] || fail "ZOOVOICE_API_PORT must be a port number"
cloud_run_url=""
gcp_project=""
smoke_service_account=""
whisper_command=""
asr_model=""
openai_api_key=""
whisper_library_path=""
sounds_directory=""

if [[ "$mode" == "local" ]]; then
  whisper_command=${ZOOVOICE_WHISPER_COMMAND:-}
  asr_model=${ZOOVOICE_ASR_MODEL_PATH:-}
  openai_api_key=${OPENAI_API_KEY:-}
  # macOS は保護された実行ファイル（npm 経由の /bin/sh 等）を通ると DYLD_LIBRARY_PATH を捨てる。
  # そのため共有ライブラリの場所は DYLD_ 以外の名前で受け取り、API プロセスの起動時にこの場で設定する。
  whisper_library_path=${ZOOVOICE_WHISPER_LIB_PATH:-}
  sounds_directory=${ZOOVOICE_SOUNDS_DIR:-}
  required_file ZOOVOICE_WHISPER_COMMAND "$whisper_command"
  required_file ZOOVOICE_ASR_MODEL_PATH "$asr_model"
  [[ -n "$openai_api_key" ]] || fail "OPENAI_API_KEY is required"
  whisper_command=$(canonical_file "$whisper_command")
  asr_model=$(canonical_file "$asr_model")
  if [[ -n "$sounds_directory" ]]; then
    [[ -d "$sounds_directory" ]] || fail "ZOOVOICE_SOUNDS_DIR must be a directory"
    sounds_directory=$(cd "$sounds_directory" && pwd -P)
  fi
fi

if [[ "$mode" == "cloud-run" ]]; then
  cloud_run_url=${ZOOVOICE_CLOUD_RUN_URL:-}
  gcp_project=${ZOOVOICE_GCP_PROJECT:-}
  smoke_service_account=${ZOOVOICE_SMOKE_SERVICE_ACCOUNT:-}
  [[ -n "$cloud_run_url" ]] || fail "ZOOVOICE_CLOUD_RUN_URL is required"
  [[ -n "$gcp_project" ]] || fail "ZOOVOICE_GCP_PROJECT is required"
  [[ -n "$smoke_service_account" ]] || fail "ZOOVOICE_SMOKE_SERVICE_ACCOUNT is required"

  cloud_run_url=${cloud_run_url%/}
  [[ "$cloud_run_url" == https://* ]] || fail "ZOOVOICE_CLOUD_RUN_URL must be an HTTPS origin"
  cloud_run_authority=${cloud_run_url#https://}
  if [[ -z "$cloud_run_authority" || "$cloud_run_authority" == */* || "$cloud_run_authority" == *\?* || "$cloud_run_authority" == *\#* || "$cloud_run_authority" == *@* || "$cloud_run_authority" == *[$'\r\n\t ']* ]]; then
    fail "ZOOVOICE_CLOUD_RUN_URL must be an HTTPS origin"
  fi
  if [[ ! "$gcp_project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    fail "ZOOVOICE_GCP_PROJECT is invalid"
  fi
  if [[ "$smoke_service_account" != *@*.iam.gserviceaccount.com || "$smoke_service_account" == *[$'\r\n\t /']* ]]; then
    fail "ZOOVOICE_SMOKE_SERVICE_ACCOUNT is invalid"
  fi
fi

if [[ "$dry_run" == "1" ]]; then
  echo "[dry-run] npm run build:web"
  echo "[dry-run] npx wrangler d1 migrations apply MO_SPEECH_DB --local --persist-to $persist_directory"
  if [[ "$mode" == "local" ]]; then
    echo "[dry-run] env: ZOOVOICE_ORIGIN_MODE=local-origin"
    echo "[dry-run] ASR runtime artifacts and association API key: verified"
    echo "[dry-run] go build -o tmp/zoovoice-local-api ."
    echo "[dry-run] ZOOVOICE_PORT=$api_port ZOOVOICE_TIMEOUT_SECONDS=85 tmp/zoovoice-local-api"
  else
    echo "[dry-run] gcloud auth print-identity-token --impersonate-service-account=<redacted> --audiences=$cloud_run_url --project=$gcp_project --quiet"
    echo "[dry-run] env: ZOOVOICE_ORIGIN_MODE=cloud-run-smoke"
  fi
  echo "[dry-run] npx wrangler dev --local --ip 127.0.0.1 --port $browser_port --persist-to $persist_directory --env-file <temporary-dev-vars>"
  exit 0
fi

umask 077
temporary_dev_vars=$(mktemp "${TMPDIR:-/tmp}/zoovoice-wrangler-vars.XXXXXX")
temporary_error=""
go_pid=""

cleanup() {
  if [[ -n "$go_pid" ]] && kill -0 "$go_pid" 2>/dev/null; then
    kill "$go_pid" 2>/dev/null || true
    wait "$go_pid" 2>/dev/null || true
  fi
  rm -f "$temporary_dev_vars"
  if [[ -n "$temporary_error" ]]; then
    rm -f "$temporary_error"
  fi
}
trap cleanup EXIT

{
  echo "ZOOVOICE_ENABLED=1"
  echo "ZOOVOICE_LOCAL_DEV=1"
  echo "ZOOVOICE_TURNSTILE_SITE_KEY=1x00000000000000000000AA"
  echo "ZOOVOICE_TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA"
} > "$temporary_dev_vars"

if [[ "$mode" == "local" ]]; then
  {
    echo "ZOOVOICE_ORIGIN_MODE=local-origin"
    echo "ZOOVOICE_LOCAL_ORIGIN=http://127.0.0.1:$api_port"
  } >> "$temporary_dev_vars"
else
  temporary_error=$(mktemp "${TMPDIR:-/tmp}/zoovoice-gcloud-error.XXXXXX")
  if ! id_token=$(gcloud auth print-identity-token \
    --impersonate-service-account="$smoke_service_account" \
    --audiences="$cloud_run_url" \
    --project="$gcp_project" \
    --quiet 2>"$temporary_error"); then
    fail "Cloud Run smoke用の短期ID tokenを取得できませんでした。gcloud認証とimpersonation権限を確認してください。"
  fi
  if [[ -z "$id_token" || ! "$id_token" =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "Cloud Run smoke用の短期ID tokenを確認できませんでした。"
  fi
  {
    echo "ZOOVOICE_ORIGIN_MODE=cloud-run-smoke"
    echo "ZOOVOICE_CLOUD_RUN_URL=$cloud_run_url"
    echo "ZOOVOICE_GCP_ID_TOKEN=$id_token"
  } >> "$temporary_dev_vars"
  unset id_token
fi

mkdir -p "$persist_directory"
cd "$repository_root"
npm run build:web
npx wrangler d1 migrations apply MO_SPEECH_DB --local --persist-to "$persist_directory"

if [[ "$mode" == "local" ]]; then
  # go run ではなくビルドした実行ファイルを起動する。署名付きの go 経由だと
  # DYLD_LIBRARY_PATH が whisper-cli へ渡らず音声認識が起動しないため（CLI.md と同じ理由）。
  # また go run の子プロセスは親を kill しても残るので、実行ファイルを直接持つ。
  api_binary="$repository_root/tmp/zoovoice-local-api"
  (cd "$repository_root/services/zoovoice" && go build -o "$api_binary" .)
  (
    cd "$repository_root/services/zoovoice"
    exec env ZOOVOICE_PORT="$api_port" \
      ZOOVOICE_TIMEOUT_SECONDS=85 \
      ZOOVOICE_WHISPER_COMMAND="$whisper_command" \
      ZOOVOICE_ASR_MODEL_PATH="$asr_model" \
      ${sounds_directory:+ZOOVOICE_SOUNDS_DIR="$sounds_directory"} \
      ${whisper_library_path:+DYLD_LIBRARY_PATH="$whisper_library_path"} \
      OPENAI_API_KEY="$openai_api_key" \
      "$api_binary"
  ) &
  go_pid=$!

  ready=0
  for _attempt in {1..60}; do
    if curl --fail --silent --show-error "http://127.0.0.1:$api_port/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "$go_pid" 2>/dev/null; then
      fail "Zoovoice Go APIが起動前に終了しました。"
    fi
    sleep 0.5
  done
  [[ "$ready" == "1" ]] || fail "Zoovoice Go APIの起動確認がtimeoutしました。"
fi

npx wrangler dev \
  --local \
  --ip 127.0.0.1 \
  --port "$browser_port" \
  --persist-to "$persist_directory" \
  --env-file "$temporary_dev_vars"
