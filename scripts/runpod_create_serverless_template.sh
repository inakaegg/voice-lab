#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
set_default_runpod_app_env
require_cmd runpodctl
require_env RUNPOD_IMAGE

ENV_JSON="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"

cmd=(
  runpodctl template create
  --name "${RUNPOD_SERVERLESS_TEMPLATE_NAME:-mo-speech-serverless}"
  --image "${RUNPOD_IMAGE}"
  --serverless
  --container-disk-in-gb "${RUNPOD_CONTAINER_DISK_GB:-60}"
  --env "${ENV_JSON}"
  --docker-start-cmd "python,-m,mo_speech.runpod_handler"
)

run_or_print "${cmd[@]}"
