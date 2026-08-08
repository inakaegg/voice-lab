#!/bin/bash
# ConceptNet方式とEmbedding方式をpilot.pyで続けて実行する。使い方: TEXT="単語" ./tools/rensou.sh
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${ZOOVOICE_MODELS_DIR:-/Volumes/1T/pj/models/zoovoice}"

"$MODELS_DIR/embedding-pilot-venv/bin/python" \
  services/zoovoice/tools/embedding_pilot/pilot.py associate \
  --method conceptnet \
  --text "$TEXT" \
  --go-binary tmp/embedding-pilot/bin/zoovoice \
  --lexicon services/zoovoice/assets/animal-lexicon.json \
  --index "$MODELS_DIR/conceptnet-ja-5.7.0-schema2.sqlite" \
  --output -

"$MODELS_DIR/embedding-pilot-venv/bin/python" \
  services/zoovoice/tools/embedding_pilot/pilot.py associate \
  --method embedding \
  --text "$TEXT" \
  --go-binary tmp/embedding-pilot/bin/zoovoice \
  --model "$MODELS_DIR/embedding/hotchpotch-static-embedding-japanese/95b3d9c80a7ccf604e2b5daee7b1b3eed6b1a9d3" \
  --precomputed tmp/embedding-pilot/precomputed-static-256 \
  --top-k 5 \
  --output -
