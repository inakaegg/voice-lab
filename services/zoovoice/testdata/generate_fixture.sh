#!/bin/sh
# 0.7秒の音を1.3秒の無音で2回区切った、決定的な合成fixtureを生成する。
# 実音声や第三者素材をテスト入力へ含めない。
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

ffmpeg \
  -nostdin \
  -y \
  -v error \
  -f lavfi \
  -i "aevalsrc=0.2*sin(2*PI*440*t)*(between(t\,0\,0.7)+between(t\,2.0\,2.7)+between(t\,4.0\,4.7)):s=24000:d=4.7" \
  -ar 24000 \
  -ac 1 \
  -c:a pcm_s16le \
  "$script_dir/compose-input.wav"
