#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
set_default_runpod_app_env
require_cmd runpodctl
require_env RUNPOD_IMAGE
require_env RUNPOD_GPU_ID
require_env RUNPOD_NETWORK_VOLUME_ID

ENV_JSON="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"

cmd=(
  runpodctl pod create
  --name "${RUNPOD_POD_NAME:-mo-speech-gpu-smoke}"
  --image "${RUNPOD_IMAGE}"
  --gpu-id "${RUNPOD_GPU_ID}"
  --gpu-count "${RUNPOD_GPU_COUNT:-1}"
  --container-disk-in-gb "${RUNPOD_CONTAINER_DISK_GB:-60}"
  --volume-mount-path "${RUNPOD_VOLUME_MOUNT_PATH:-/runpod-volume}"
  --ports "${RUNPOD_PORTS:-8000/http}"
  --env "${ENV_JSON}"
)

cmd+=(--network-volume-id "${RUNPOD_NETWORK_VOLUME_ID}")
if [[ -n "${RUNPOD_DATA_CENTER_IDS:-}" ]]; then
  cmd+=(--data-center-ids "${RUNPOD_DATA_CENTER_IDS}")
fi
if [[ -n "${RUNPOD_MIN_CUDA_VERSION:-}" ]]; then
  cmd+=(--min-cuda-version "${RUNPOD_MIN_CUDA_VERSION}")
fi
if [[ -n "${RUNPOD_STOP_AFTER:-}" ]]; then
  cmd+=(--stop-after "$(runpod_resolve_datetime "${RUNPOD_STOP_AFTER}")")
fi
if [[ -n "${RUNPOD_REGISTRY_AUTH_ID:-}" ]]; then
  cmd+=(--registry-auth-id "${RUNPOD_REGISTRY_AUTH_ID}")
fi

run_or_print "${cmd[@]}"
