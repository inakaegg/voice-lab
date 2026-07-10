#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env
set_default_runpod_app_env
require_env RUNPOD_SERVERLESS_TEMPLATE_ID
require_env RUNPOD_IMAGE

ENV_JSON="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"

cmd=(
  runpodctl template update
  "${RUNPOD_SERVERLESS_TEMPLATE_ID}"
  --image "${RUNPOD_IMAGE}"
  --container-disk-in-gb "${RUNPOD_CONTAINER_DISK_GB:-60}"
  --env "${ENV_JSON}"
)

print_command "${cmd[@]}"
if [[ "${RUNPOD_DRY_RUN:-0}" == "1" ]]; then
  exit 0
fi

require_cmd runpodctl
"${cmd[@]}" | python3 -c '
import json
import re
import sys

SECRET_KEY_SUFFIXES = ("_KEY", "_TOKEN", "_SECRET", "_PASSWORD")
SECRET_KEYS = {"OPENAI_API_KEY"}


def is_secret_key(key):
    return key in SECRET_KEYS or key.endswith(SECRET_KEY_SUFFIXES)


def redact(value):
    if isinstance(value, dict):
        return {key: ("<redacted>" if is_secret_key(key) else redact(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


text = sys.stdin.read()
try:
    print(json.dumps(redact(json.loads(text)), ensure_ascii=False, indent=2))
except json.JSONDecodeError:
    for key in SECRET_KEYS:
        text = re.sub(rf"({re.escape(key)}[\"=:\s]+)[^\",\s]+", rf"\1<redacted>", text)
    text = re.sub(r"([A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)[\"=:\s]+)[^\",\s]+", r"\1<redacted>", text)
    print(text, end="")
'
