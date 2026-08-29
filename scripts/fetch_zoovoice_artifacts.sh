#!/usr/bin/env bash
set -euo pipefail

# GCSからZoovoiceのbuild資材を取得し、SHA-256を照合する。
# 照合に通らない資材でbuildへ進むことはない。CIとローカルの両方で使う。
# 最後に deploy script へ渡す2つのpathを出力する。

script_directory=${BASH_SOURCE[0]%/*}
# shellcheck source=scripts/zoovoice_artifacts_common.sh
source "$script_directory/zoovoice_artifacts_common.sh"

destination=${ZOOVOICE_ARTIFACTS_DIR:-}
[[ -n "$destination" ]] || zoovoice_artifacts_fail "ZOOVOICE_ARTIFACTS_DIR is required"

command -v gcloud >/dev/null 2>&1 || zoovoice_artifacts_fail "gcloud CLIが見つかりません。"
command -v tar >/dev/null 2>&1 || zoovoice_artifacts_fail "tarが見つかりません。"

mkdir -p "$destination"
model_path="$destination/ggml-small.bin"
archive_path="$destination/zoovoice-sounds.tar.gz"
sounds_path="$destination/sounds"

# 既に正しい資材があれば取り直さない。ローカルでの再実行を安くするためで、
# 判定はファイルの有無ではなくSHA-256の一致で行う。
download_if_needed() {
  local object=$1
  local target=$2
  local expected=$3
  local label=$4

  if [[ -f "$target" ]] && [[ "$(zoovoice_artifacts_sha256 "$target")" == "$expected" ]]; then
    echo "${label}: 取得済み（SHA-256一致）"
    return 0
  fi

  echo "${label}: gs://${zoovoice_artifacts_bucket}/${object} から取得します"
  if ! gcloud storage cp "gs://${zoovoice_artifacts_bucket}/${object}" "$target"; then
    zoovoice_artifacts_fail "${label}を取得できませんでした。objectの有無と権限を確認してください。"
  fi
  zoovoice_artifacts_verify_sha256 "$target" "$expected" "$label"
  echo "${label}: 取得してSHA-256を照合しました"
}

download_if_needed "$zoovoice_asr_model_object" "$model_path" "$zoovoice_asr_model_sha256" "ASRモデル"
download_if_needed "$zoovoice_sounds_object" "$archive_path" "$zoovoice_sounds_sha256" "音源セット"

rm -rf "$sounds_path"
mkdir -p "$sounds_path"
tar -xzf "$archive_path" -C "$sounds_path"
[[ -f "$sounds_path/manifest.json" ]] || zoovoice_artifacts_fail "展開した音源セットに manifest.json がありません。"

echo
echo "ZOOVOICE_ASR_MODEL_PATH=$model_path"
echo "ZOOVOICE_SOUNDS_DIR=$sounds_path"
