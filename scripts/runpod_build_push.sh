#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/runpod_common.sh
source "${SCRIPT_DIR}/runpod_common.sh"

RUNPOD_IMAGE_FROM_ENV="${RUNPOD_IMAGE:-}"
load_runpod_env
if [[ -n "${RUNPOD_IMAGE_FROM_ENV}" ]]; then
  RUNPOD_IMAGE="${RUNPOD_IMAGE_FROM_ENV}"
fi
require_cmd docker
require_env RUNPOD_IMAGE

cd "${REPO_ROOT}"

BUILD_PLATFORM="${RUNPOD_BUILD_PLATFORM:-linux/amd64}"
cmd=(docker buildx build --platform "${BUILD_PLATFORM}" -f Dockerfile.runpod -t "${RUNPOD_IMAGE}" --push)
if [[ -n "${RUNPOD_BASE_IMAGE:-}" ]]; then
  cmd+=(--build-arg "BASE_IMAGE=${RUNPOD_BASE_IMAGE}")
fi
cmd+=(.)
run_or_print "${cmd[@]}"
