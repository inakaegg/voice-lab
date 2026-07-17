#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

load_runpod_env

RUNPOD_ENV_PATH="${RUNPOD_ENV_FILE:-${REPO_ROOT}/.runpod.env}"
DRY_RUN="${RUNPOD_DRY_RUN:-0}"

workflow="${RUNPOD_DEPLOY_WORKFLOW:-runpod-image.yml}"
source_sha="${RUNPOD_DEPLOY_SOURCE_SHA:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
short_sha="${RUNPOD_DEPLOY_SHORT_SHA:-${source_sha:0:7}}"
git_ref="${RUNPOD_DEPLOY_REF:-$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)}"
image_name="${RUNPOD_DEPLOY_IMAGE_NAME:-${RUNPOD_IMAGE_NAME:-}}"
if [[ -z "${image_name}" ]]; then
  if [[ -n "${RUNPOD_IMAGE:-}" && "${RUNPOD_IMAGE}" == *:* ]]; then
    image_name="${RUNPOD_IMAGE%:*}"
  else
    image_name="${RUNPOD_IMAGE:-}"
  fi
fi
image_tag="${RUNPOD_DEPLOY_IMAGE_TAG:-${RUNPOD_IMAGE_TAG:-${RUNPOD_DEPLOY_IMAGE_TAG_PREFIX:-runpod-vibevoice}-${short_sha}}}"
image_visibility="${RUNPOD_DEPLOY_IMAGE_VISIBILITY:-private}"
new_image="${image_name}:${image_tag}"
template_name="${RUNPOD_DEPLOY_TEMPLATE_NAME:-mo-speech-serverless-${short_sha}}"
endpoint_id="${RUNPOD_ENDPOINT_ID:-}"
workers_max="${RUNPOD_DEPLOY_WORKERS_MAX:-1}"
workers_min="${RUNPOD_DEPLOY_WORKERS_MIN:-0}"
drain_seconds="${RUNPOD_DEPLOY_WORKER_DRAIN_SECONDS:-20}"
idle_timeout="${RUNPOD_DEPLOY_IDLE_TIMEOUT_SECONDS:-${RUNPOD_IDLE_TIMEOUT_SECONDS:-300}}"
diagnostics_timeout="${RUNPOD_DEPLOY_DIAGNOSTICS_TIMEOUT_SECONDS:-900}"
diagnostics_poll_interval="${RUNPOD_DEPLOY_DIAGNOSTICS_POLL_INTERVAL_SECONDS:-2}"
registry_auth_id="${RUNPOD_REGISTRY_AUTH_ID:-}"

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "required deploy value is missing: ${name}" >&2
    exit 1
  fi
}

ensure_pushed_head() {
  if [[ "${DRY_RUN}" == "1" || "${RUNPOD_DEPLOY_SKIP_PUSH_CHECK:-0}" == "1" || -n "${RUNPOD_DEPLOY_SOURCE_SHA:-}" ]]; then
    return 0
  fi
  local upstream
  upstream="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -z "${upstream}" ]]; then
    echo "upstream branch is not configured; set RUNPOD_DEPLOY_SKIP_PUSH_CHECK=1 to bypass" >&2
    exit 1
  fi
  local upstream_sha
  upstream_sha="$(git -C "${REPO_ROOT}" rev-parse "${upstream}")"
  if [[ "${source_sha}" != "${upstream_sha}" ]]; then
    echo "current HEAD is not pushed to ${upstream}; push first or set RUNPOD_DEPLOY_SKIP_PUSH_CHECK=1" >&2
    echo "HEAD=${source_sha}" >&2
    echo "${upstream}=${upstream_sha}" >&2
    exit 1
  fi
}

run_or_dry() {
  print_command "$@"
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  "$@"
}

find_workflow_run_id() {
  local runs_json
  runs_json="$(gh run list \
    --workflow "${workflow}" \
    --branch "${git_ref}" \
    --event workflow_dispatch \
    --limit 20 \
    --json databaseId,headSha,createdAt,status)"
  python3 -c '
import json
import sys

runs = json.load(sys.stdin)
source_sha = sys.argv[1]
for run in runs:
    if run.get("headSha") == source_sha:
        print(run["databaseId"])
        raise SystemExit(0)
raise SystemExit("workflow run for source revision was not found")
' "${source_sha}" <<< "${runs_json}"
}

create_template() {
  export RUNPOD_IMAGE="${new_image}"
  export RUNPOD_SERVERLESS_TEMPLATE_NAME="${template_name}"
  set_default_runpod_app_env

  local env_json
  env_json="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"
  echo "running: POST https://rest.runpod.io/v1/templates image=${RUNPOD_IMAGE} containerRegistryAuthId=${registry_auth_id:-none} env=<env-json-redacted>" >&2
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf 'dry-run-template-%s\n' "${short_sha}"
    return 0
  fi

  local template_json
  template_json="$(
    RUNPOD_TEMPLATE_ENV_JSON="${env_json}" \
      python3 "${SCRIPT_DIR}/runpod_template_api.py" create
  )"
  python3 -m json.tool <<< "${template_json}" >&2
  python3 -c '
import json
import sys

data = json.load(sys.stdin)
template_id = data.get("id")
if not template_id:
    raise SystemExit("template create response did not include id")
print(template_id)
' <<< "${template_json}"
}

find_existing_template_id() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  local templates_json
  templates_json="$(runpodctl template list --type user --limit "${RUNPOD_DEPLOY_TEMPLATE_LIST_LIMIT:-1000}")" || return 0
  python3 -c '
import json
import sys


def iter_items(value):
    if isinstance(value, list):
        yield from value
        return
    if not isinstance(value, dict):
        return
    for key in ("templates", "items", "data", "results"):
        child = value.get(key)
        if isinstance(child, list):
            yield from child
            return
    yield value


target_name = sys.argv[1]
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    raise SystemExit(0)
for item in iter_items(data):
    if not isinstance(item, dict):
        continue
    name = item.get("name") or item.get("templateName")
    template_id = item.get("id") or item.get("templateId")
    if name == target_name and template_id:
        print(template_id)
        raise SystemExit(0)
' "${template_name}" <<< "${templates_json}"
}

update_template() {
  local template_id="$1"
  export RUNPOD_IMAGE="${new_image}"
  export RUNPOD_SERVERLESS_TEMPLATE_NAME="${template_name}"
  set_default_runpod_app_env

  local env_json
  env_json="$(runpod_env_json "${RUNPOD_APP_ENV_KEYS[@]}")"
  echo "running: PATCH https://rest.runpod.io/v1/templates/${template_id} image=${RUNPOD_IMAGE} containerRegistryAuthId=${registry_auth_id:-none} env=<env-json-redacted>" >&2
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi

  local template_json
  template_json="$(
    RUNPOD_TEMPLATE_ENV_JSON="${env_json}" \
      python3 "${SCRIPT_DIR}/runpod_template_api.py" update "${template_id}"
  )"
  python3 -m json.tool <<< "${template_json}" >&2
}

create_or_update_template() {
  local existing_template_id
  existing_template_id="$(find_existing_template_id)"
  if [[ -n "${existing_template_id}" ]]; then
    echo "template already exists; reusing ${template_name} (${existing_template_id})" >&2
    update_template "${existing_template_id}"
    printf '%s\n' "${existing_template_id}"
    return 0
  fi
  create_template
}

update_endpoint() {
  local template_id="$1"
  local max_workers="$2"
  local timeout_seconds="$3"
  local url="https://rest.runpod.io/v1/endpoints/${endpoint_id}/update"
  echo "running: POST ${url} templateId=${template_id} workersMin=${workers_min} workersMax=${max_workers} idleTimeout=${timeout_seconds}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  RUNPOD_DEPLOY_TEMPLATE_ID="${template_id}" \
  RUNPOD_DEPLOY_WORKERS_MIN="${workers_min}" \
  RUNPOD_DEPLOY_WORKERS_MAX="${max_workers}" \
  RUNPOD_DEPLOY_IDLE_TIMEOUT="${timeout_seconds}" \
  python3 - <<'PY'
import json
import os
import urllib.request

endpoint_id = os.environ["RUNPOD_ENDPOINT_ID"]
api_key = os.environ["RUNPOD_API_KEY"]
payload = {
    "templateId": os.environ["RUNPOD_DEPLOY_TEMPLATE_ID"],
    "workersMin": int(os.environ["RUNPOD_DEPLOY_WORKERS_MIN"]),
    "workersMax": int(os.environ["RUNPOD_DEPLOY_WORKERS_MAX"]),
    "idleTimeout": int(os.environ["RUNPOD_DEPLOY_IDLE_TIMEOUT"]),
}
request = urllib.request.Request(
    f"https://rest.runpod.io/v1/endpoints/{endpoint_id}/update",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    data = json.loads(response.read().decode("utf-8"))
keys = ["id", "name", "templateId", "workersMin", "workersMax", "idleTimeout", "flashboot", "networkVolumeIds"]
print(json.dumps({key: data.get(key) for key in keys}, ensure_ascii=False, indent=2))
PY
}

update_env_file() {
  local template_id="$1"
  echo "updating ${RUNPOD_ENV_PATH}: RUNPOD_IMAGE, RUNPOD_SERVERLESS_TEMPLATE_NAME, RUNPOD_SERVERLESS_TEMPLATE_ID"
  if [[ "${DRY_RUN}" == "1" || "${RUNPOD_DEPLOY_UPDATE_ENV_FILE:-1}" == "0" ]]; then
    return 0
  fi
  python3 - "${RUNPOD_ENV_PATH}" \
    "RUNPOD_IMAGE=${new_image}" \
    "RUNPOD_SERVERLESS_TEMPLATE_NAME=${template_name}" \
    "RUNPOD_SERVERLESS_TEMPLATE_ID=${template_id}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
updates = dict(arg.split("=", 1) for arg in sys.argv[2:])
lines = path.read_text(encoding="utf-8").splitlines()
seen = set()
output = []
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.split("=", 1)[0]
        if key in updates:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
    output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
path.write_text("\n".join(output) + "\n", encoding="utf-8")
PY
}

run_diagnostics() {
  if [[ "${RUNPOD_DEPLOY_RUN_DIAGNOSTICS:-1}" == "0" ]]; then
    return 0
  fi
  local cmd=(
    python scripts/runpod_smoke_serverless.py
    --operation-mode diagnostics
    --request-mode async
    --timeout "${diagnostics_timeout}"
    --poll-interval "${diagnostics_poll_interval}"
  )
  print_command "${cmd[@]}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  local output_file
  output_file="$(mktemp)"
  "${cmd[@]}" > "${output_file}"
  python3 - "${output_file}" "${source_sha}" "${new_image}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
source_sha = sys.argv[2]
expected_image = sys.argv[3]
data = json.loads(path.read_text(encoding="utf-8"))
output = data.get("output") or {}
image = output.get("image") or {}
revision = image.get("revision")
tag = image.get("tag")
summary = {
    "id": data.get("id"),
    "status": data.get("status"),
    "workerId": data.get("workerId"),
    "revision": revision,
    "tag": tag,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
if data.get("status") != "COMPLETED":
    raise SystemExit("diagnostics did not complete")
if revision != source_sha:
    raise SystemExit(f"diagnostics revision mismatch: {revision} != {source_sha}")
if tag != expected_image:
    raise SystemExit(f"diagnostics image tag mismatch: {tag} != {expected_image}")
PY
}

require_value RUNPOD_IMAGE_NAME "${image_name}"
require_value RUNPOD_ENDPOINT_ID "${endpoint_id}"
if [[ "${image_visibility}" == "private" ]]; then
  require_value RUNPOD_REGISTRY_AUTH_ID "${registry_auth_id}"
fi
if [[ "${DRY_RUN}" != "1" ]]; then
  require_cmd gh
  require_cmd runpodctl
  require_env RUNPOD_API_KEY
fi
ensure_pushed_head

echo "Deploying RunPod Serverless image"
echo "  ref: ${git_ref}"
echo "  source: ${source_sha}"
echo "  image: ${new_image}"
echo "  image visibility: ${image_visibility}"
echo "  template: ${template_name}"
echo "  endpoint: ${endpoint_id}"

run_or_dry gh workflow run "${workflow}" \
  --ref "${git_ref}" \
  -f "image_name=${image_name}" \
  -f "expected_visibility=${image_visibility}" \
  -f "image_tag=${image_tag}"

if [[ "${DRY_RUN}" != "1" && "${RUNPOD_DEPLOY_WAIT_WORKFLOW:-1}" != "0" ]]; then
  sleep "${RUNPOD_DEPLOY_RUN_DISCOVERY_DELAY_SECONDS:-3}"
  run_id="$(find_workflow_run_id)"
  echo "watching GitHub Actions run: ${run_id}"
  gh run watch "${run_id}" --exit-status
fi

template_id="$(create_or_update_template)"
update_endpoint "${template_id}" 0 5
if [[ "${DRY_RUN}" != "1" ]]; then
  sleep "${drain_seconds}"
fi
update_endpoint "${template_id}" "${workers_max}" "${idle_timeout}"
update_env_file "${template_id}"
run_diagnostics

echo "RunPod Serverless deploy completed"
echo "  image: ${new_image}"
echo "  template id: ${template_id}"
echo "  endpoint: ${endpoint_id}"
