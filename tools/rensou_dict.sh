#!/bin/bash
# 各辞書を順に引いて連想経路を確認する。使い方: ./tools/rensou_dict.sh "単語または文"
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/rensou_dict.py" "$@"
