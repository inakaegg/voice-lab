#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
require_cmd curl

if [[ -n "${RUNPOD_POD_BASE_URL:-}" ]]; then
  BASE_URL="${RUNPOD_POD_BASE_URL%/}"
else
  require_env RUNPOD_POD_ID
  BASE_URL="https://${RUNPOD_POD_ID}-${RUNPOD_FASTAPI_PORT:-8000}.proxy.runpod.net"
fi

echo "health:"
curl -fsS "${BASE_URL}/health"
printf '\n'

echo "runtime:"
curl -fsS "${BASE_URL}/api/runtime"
printf '\n'

if [[ -n "${RUNPOD_SMOKE_AUDIO:-}" ]]; then
  echo "job:"
  curl -fsS \
    -X POST "${BASE_URL}/api/translate-speech-jobs" \
    -F "audio=@${RUNPOD_SMOKE_AUDIO}" \
    -F "source_language=${RUNPOD_SMOKE_SOURCE_LANGUAGE:-id-ID}" \
    -F "target_language=${RUNPOD_SMOKE_TARGET_LANGUAGE:-ja-JP}" \
    -F "voice_mode=${RUNPOD_SMOKE_VOICE_MODE:-convert}" \
    -F "text_transform=${RUNPOD_SMOKE_TEXT_TRANSFORM:-}" \
    -F "text_transform_suffix=${RUNPOD_SMOKE_TEXT_TRANSFORM_SUFFIX:-}" \
    -F "text_transform_unit=${RUNPOD_SMOKE_TEXT_TRANSFORM_UNIT:-text}"
  printf '\n'
fi
