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

print_command "${cmd[@]}"
if [[ "${RUNPOD_DRY_RUN:-0}" == "1" ]]; then
  exit 0
fi

"${cmd[@]}" | python3 -c '
import json
import re
import sys

SECRET_KEYS = {"OPENAI_API_KEY"}


def redact(value):
    if isinstance(value, dict):
        return {key: ("<redacted>" if key in SECRET_KEYS else redact(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


text = sys.stdin.read()
try:
    print(json.dumps(redact(json.loads(text)), ensure_ascii=False, indent=2))
except json.JSONDecodeError:
    for key in SECRET_KEYS:
        text = re.sub(rf"({re.escape(key)}[\"=:\s]+)[^\",\s]+", rf"\1<redacted>", text)
    print(text, end="")
'
