#!/usr/bin/env bash
set -euo pipefail

image_name="${1:-}"
expected_visibility="${2:-private}"

if [[ -z "${image_name}" ]]; then
  echo "usage: $0 docker.io/<namespace>/<repository> <private|public>" >&2
  exit 2
fi

if [[ "${expected_visibility}" != "private" && "${expected_visibility}" != "public" ]]; then
  echo "expected visibility must be private or public" >&2
  exit 2
fi

repository_path="${image_name#docker.io/}"
repository_path="${repository_path#index.docker.io/}"
if [[ "${repository_path}" == "${image_name}" || ! "${repository_path}" =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]]; then
  echo "image name must be an untagged Docker Hub repository: docker.io/<namespace>/<repository>" >&2
  exit 2
fi

namespace="${repository_path%%/*}"
repository="${repository_path#*/}"

if [[ "${RUNPOD_DRY_RUN:-0}" == "1" && -n "${DOCKERHUB_REPOSITORY_VISIBILITY:-}" ]]; then
  actual_visibility="${DOCKERHUB_REPOSITORY_VISIBILITY}"
else
  : "${DOCKERHUB_USERNAME:?DOCKERHUB_USERNAME is required}"
  : "${DOCKERHUB_TOKEN:?DOCKERHUB_TOKEN is required}"

  auth_response="$({
    jq -n \
      --arg identifier "${DOCKERHUB_USERNAME}" \
      --arg secret "${DOCKERHUB_TOKEN}" \
      '{identifier: $identifier, secret: $secret}'
  } | curl --fail --silent --show-error \
    --request POST \
    --header "Content-Type: application/json" \
    --data-binary @- \
    "https://hub.docker.com/v2/auth/token")"
  access_token="$(jq -er '.access_token' <<<"${auth_response}")"

  repository_response="$(curl --fail --silent --show-error \
    --header "Authorization: Bearer ${access_token}" \
    "https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repository}/")"
  is_private="$(jq -er '.is_private' <<<"${repository_response}")"
  if [[ "${is_private}" == "true" ]]; then
    actual_visibility="private"
  else
    actual_visibility="public"
  fi
fi

if [[ "${actual_visibility}" != "private" && "${actual_visibility}" != "public" ]]; then
  echo "Docker Hub returned an unsupported repository visibility: ${actual_visibility}" >&2
  exit 1
fi

if [[ "${actual_visibility}" != "${expected_visibility}" ]]; then
  echo "Docker Hub repository is ${actual_visibility}, but the workflow expected ${expected_visibility}." >&2
  echo "Change the repository visibility or select the actual visibility explicitly before pushing." >&2
  exit 1
fi

echo "Docker Hub repository visibility verified: ${namespace}/${repository} is ${actual_visibility}."
