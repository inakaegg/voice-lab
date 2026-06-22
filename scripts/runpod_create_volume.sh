#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
require_cmd runpodctl
require_env RUNPOD_VOLUME_NAME
require_env RUNPOD_VOLUME_SIZE_GB
require_env RUNPOD_DATA_CENTER_ID

cmd=(
  runpodctl network-volume create
  --name "${RUNPOD_VOLUME_NAME}"
  --size "${RUNPOD_VOLUME_SIZE_GB}"
  --data-center-id "${RUNPOD_DATA_CENTER_ID}"
)
run_or_print "${cmd[@]}"
