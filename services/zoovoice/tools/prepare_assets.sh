#!/usr/bin/env bash
#
# Zoovoice の素材を実行時形式へ規格化する。
#   1. -40 dB を閾値として先頭無音を除去する。
#   2. 0.5 秒以上の内部無音で最初の鳴き声を切り出す。
#   3. 2.5 秒を上限とし、末尾 0.35 秒を fade out する。
#   4. ピークを -1 dBFS へ正規化する。
#   5. 24 kHz / mono / signed 16-bit PCM WAV へ変換する。
#
# Usage:
#   ./tools/prepare_assets.sh <cc0-source-dir|-> <extra-source-dir|-> <output-dir>
#
# `-` を指定した素材群は処理しない。入力拡張子は ffmpeg が読める形式なら
# 問わない。出力名は入力の basename に `.wav` を付けたものになる。
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <cc0-source-dir|-> <extra-source-dir|-> <output-dir>" >&2
  exit 64
fi

for command_name in ffmpeg ffprobe awk find; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command not found: $command_name" >&2
    exit 69
  fi
done

cc0_source_dir=$1
extra_source_dir=$2
output_dir=$3
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "$script_dir/../../.." && pwd -P)
log_dir="$repository_root/logs"
log_file="$log_dir/zoovoice-prepare-assets.log"
started_epoch=$(date +%s)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/zoovoice-assets.XXXXXX")
trap 'rm -rf -- "$temporary_dir"' EXIT

mkdir -p -- "$output_dir/cc0" "$output_dir/extra"
mkdir -p -- "$log_dir" 2>/dev/null || true

jst_timestamp() {
  TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z' | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/'
}

elapsed_seconds() {
  local now
  now=$(date +%s)
  printf '%d' "$((now - started_epoch))"
}

write_log() {
  local message=$1
  local line
  line="$(jst_timestamp) elapsed=$(elapsed_seconds)s $message"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$log_file" 2>/dev/null || true
}

duration_seconds() {
  ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1"
}

less_than() {
  awk -v left="$1" -v right="$2" 'BEGIN { exit !(left < right) }'
}

greater_than() {
  awk -v left="$1" -v right="$2" 'BEGIN { exit !(left > right) }'
}

process_file() {
  local source_file=$1
  local destination_file=$2
  local trimmed_file="$temporary_dir/trimmed.wav"
  local capped_file="$temporary_dir/capped.wav"
  local trimmed_duration
  local fade_start
  local max_volume
  local gain

  ffmpeg -y -v error -i "$source_file" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_duration=0.05:stop_periods=1:stop_duration=0.5:stop_threshold=-40dB" \
    -ar 24000 -ac 1 -sample_fmt s16 "$trimmed_file"

  trimmed_duration=$(duration_seconds "$trimmed_file")
  if [[ -z "$trimmed_duration" ]] || less_than "$trimmed_duration" "0.15"; then
    write_log "fallback source=$(basename -- "$source_file") reason=trimmed_duration_under_0.15s"
    ffmpeg -y -v error -i "$source_file" -ar 24000 -ac 1 -sample_fmt s16 "$trimmed_file"
    trimmed_duration=$(duration_seconds "$trimmed_file")
  fi

  if greater_than "$trimmed_duration" "2.5"; then
    fade_start=$(awk 'BEGIN { printf "%.2f", 2.5 - 0.35 }')
    ffmpeg -y -v error -i "$trimmed_file" -t 2.5 \
      -af "afade=t=out:st=${fade_start}:d=0.35" \
      -ar 24000 -ac 1 -sample_fmt s16 "$capped_file"
  else
    cp -- "$trimmed_file" "$capped_file"
  fi

  max_volume=$(
    ffmpeg -hide_banner -nostats -i "$capped_file" -af volumedetect -f null - 2>&1 |
      awk '/max_volume:/ { print $(NF-1); found=1 } END { if (!found) exit 1 }'
  )
  if [[ "$max_volume" == "-inf" ]]; then
    cp -- "$capped_file" "$destination_file"
  else
    gain=$(awk -v max_volume="$max_volume" 'BEGIN { printf "%.4f", -1 - max_volume }')
    ffmpeg -y -v error -i "$capped_file" -af "volume=${gain}dB" \
      -ar 24000 -ac 1 -sample_fmt s16 "$destination_file"
  fi
}

process_directory() {
  local source_dir=$1
  local destination_dir=$2
  local category=$3
  local count=0

  if [[ "$source_dir" == "-" ]]; then
    write_log "skip category=$category reason=disabled"
    return
  fi
  if [[ ! -d "$source_dir" ]]; then
    echo "source directory not found: $source_dir" >&2
    exit 66
  fi

  while IFS= read -r -d '' source_file; do
    local source_name
    local destination_name
    source_name=$(basename -- "$source_file")
    destination_name="${source_name%.*}.wav"
    process_file "$source_file" "$destination_dir/$destination_name"
    count=$((count + 1))
  done < <(
    find "$source_dir" -maxdepth 1 -type f \
      \( -iname '*.mp3' -o -iname '*.wav' -o -iname '*.flac' -o -iname '*.m4a' \
      -o -iname '*.ogg' -o -iname '*.aac' -o -iname '*.opus' \) \
      -print0
  )

  write_log "complete category=$category files=$count output=$destination_dir"
}

write_log "start cc0_source=$cc0_source_dir extra_source=$extra_source_dir output=$output_dir"
process_directory "$cc0_source_dir" "$output_dir/cc0" "cc0"
process_directory "$extra_source_dir" "$output_dir/extra" "extra"
write_log "finish"
