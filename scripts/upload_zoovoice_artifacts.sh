#!/usr/bin/env bash
set -euo pipefail

# Zoovoiceのbuild資材をGCSへ置く。手作業を残さないため、初回の配置もscriptで行う。
# 既定はdry-runで、ZOOVOICE_ARTIFACTS_UPLOAD_APPLY=1 のときだけ実際に書き込む。
# 既存objectは上書きしない。資材を差し替えるときは
# zoovoice_artifacts_common.sh のobject pathとSHA-256を先に更新する。

script_directory=${BASH_SOURCE[0]%/*}
# shellcheck source=scripts/zoovoice_artifacts_common.sh
source "$script_directory/zoovoice_artifacts_common.sh"

model_source=${ZOOVOICE_ASR_MODEL_PATH:-}
sounds_source=${ZOOVOICE_SOUNDS_DIR:-}
apply=${ZOOVOICE_ARTIFACTS_UPLOAD_APPLY:-0}

[[ -n "$model_source" ]] || zoovoice_artifacts_fail "ZOOVOICE_ASR_MODEL_PATH is required"
[[ -n "$sounds_source" ]] || zoovoice_artifacts_fail "ZOOVOICE_SOUNDS_DIR is required"
[[ -f "$model_source" ]] || zoovoice_artifacts_fail "ZOOVOICE_ASR_MODEL_PATH must be a regular file"
[[ -d "$sounds_source" ]] || zoovoice_artifacts_fail "ZOOVOICE_SOUNDS_DIR must be a directory"
if [[ "$apply" != "0" && "$apply" != "1" ]]; then
  zoovoice_artifacts_fail "ZOOVOICE_ARTIFACTS_UPLOAD_APPLY must be 0 or 1"
fi

command -v gcloud >/dev/null 2>&1 || zoovoice_artifacts_fail "gcloud CLIが見つかりません。"
command -v python3 >/dev/null 2>&1 || zoovoice_artifacts_fail "python3が見つかりません。"

# 送る前に、手元の資材が期待する内容かを確かめる。
zoovoice_artifacts_verify_sha256 "$model_source" "$zoovoice_asr_model_sha256" "ASRモデル"

umask 077
work_directory=$(mktemp -d "${TMPDIR:-/tmp}/zoovoice-artifacts-upload.XXXXXX")
trap 'rm -rf "$work_directory"' EXIT
archive_path="$work_directory/sounds.tar.gz"
python3 "$script_directory/build_zoovoice_sounds_archive.py" "$sounds_source" "$archive_path" >/dev/null
zoovoice_artifacts_verify_sha256 "$archive_path" "$zoovoice_sounds_sha256" "音源セットのアーカイブ"

model_target="gs://${zoovoice_artifacts_bucket}/${zoovoice_asr_model_object}"
sounds_target="gs://${zoovoice_artifacts_bucket}/${zoovoice_sounds_object}"

echo "Zoovoice build資材のアップロード"
echo "mode: $([[ "$apply" == "1" ]] && echo apply || echo dry-run)"
echo "bucket: $zoovoice_artifacts_bucket"
echo "ASRモデル: $model_target"
echo "音源セット: $sounds_target"

if [[ "$apply" != "1" ]]; then
  echo "[dry-run] gcloud storage cp --no-clobber <verified model> $model_target"
  echo "[dry-run] gcloud storage cp --no-clobber <verified archive> $sounds_target"
  exit 0
fi

# --no-clobber で既存objectを保護する。差し替えは新しいpathへ置く運用のため、
# 同じpathへの再書き込みは事故とみなす。
gcloud storage cp --no-clobber "$model_source" "$model_target"
gcloud storage cp --no-clobber "$archive_path" "$sounds_target"

echo "アップロードしました"
