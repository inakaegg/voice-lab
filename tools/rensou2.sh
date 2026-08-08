#!/bin/bash
# 現行方式とEmbedding方式を連想経緯つきで比較する。
# 使い方: ./tools/rensou2.sh "日本語の文" [候補数]
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/rensou_compare.py" "$@"
