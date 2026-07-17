#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
set_default_runpod_app_env
require_env RUNPOD_SERVERLESS_TEMPLATE_ID
require_env RUNPOD_IMAGE
image_visibility="${RUNPOD_IMAGE_VISIBILITY:-private}"
if [[ "${image_visibility}" == "private" ]]; then
  require_env RUNPOD_REGISTRY_AUTH_ID
fi

ENV_JSON="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"

echo "running: PATCH https://rest.runpod.io/v1/templates/${RUNPOD_SERVERLESS_TEMPLATE_ID} image=${RUNPOD_IMAGE} containerRegistryAuthId=${RUNPOD_REGISTRY_AUTH_ID:-none} env=<env-json-redacted>"
if [[ "${RUNPOD_DRY_RUN:-0}" == "1" ]]; then
  exit 0
fi

require_env RUNPOD_API_KEY
RUNPOD_TEMPLATE_ENV_JSON="${ENV_JSON}" \
  python3 "${SCRIPT_DIR}/runpod_template_api.py" update "${RUNPOD_SERVERLESS_TEMPLATE_ID}"
