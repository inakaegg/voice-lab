#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
set_default_runpod_app_env
require_cmd runpodctl
require_env RUNPOD_SERVERLESS_TEMPLATE_ID
require_env RUNPOD_GPU_ID
require_env RUNPOD_NETWORK_VOLUME_ID

cmd=(
  runpodctl serverless create
  --name "${RUNPOD_ENDPOINT_NAME:-mo-speech-inference}"
  --template-id "${RUNPOD_SERVERLESS_TEMPLATE_ID}"
  --gpu-id "${RUNPOD_GPU_ID}"
  --gpu-count "${RUNPOD_GPU_COUNT:-1}"
  --workers-min "${RUNPOD_WORKERS_MIN:-0}"
  --workers-max "${RUNPOD_WORKERS_MAX:-1}"
  --idle-timeout "${RUNPOD_IDLE_TIMEOUT_SECONDS:-600}"
  --execution-timeout "${RUNPOD_EXECUTION_TIMEOUT_SECONDS:-1800}"
  --scale-by "${RUNPOD_SCALE_BY:-delay}"
  --scale-threshold "${RUNPOD_SCALE_THRESHOLD:-5}"
)

cmd+=(--network-volume-id "${RUNPOD_NETWORK_VOLUME_ID}")
if [[ -n "${RUNPOD_DATA_CENTER_IDS:-}" ]]; then
  cmd+=(--data-center-ids "${RUNPOD_DATA_CENTER_IDS}")
fi
if [[ -n "${RUNPOD_MIN_CUDA_VERSION:-}" ]]; then
  cmd+=(--min-cuda-version "${RUNPOD_MIN_CUDA_VERSION}")
fi
if [[ "${RUNPOD_FLASH_BOOT:-}" == "1" || "${RUNPOD_FLASH_BOOT:-}" == "true" ]]; then
  cmd+=(--flash-boot)
fi

run_or_print "${cmd[@]}"
