#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

script_directory=${BASH_SOURCE[0]%/*}
repository_root=$(cd "$script_directory/.." && pwd -P)

project=${ZOOVOICE_GCP_PROJECT:-}
apply=${ZOOVOICE_DEPLOY_APPLY:-0}
region=us-central1
service=zoovoice
artifact_repository=voice-lab
smoke_account_name=zoovoice-local-smoke-invoker
local_smoke_port=${ZOOVOICE_LOCAL_SMOKE_PORT:-18080}

[[ -n "$project" ]] || fail "ZOOVOICE_GCP_PROJECT is required"
if [[ ! "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  fail "ZOOVOICE_GCP_PROJECT is invalid"
fi
if [[ "$apply" != "0" && "$apply" != "1" ]]; then
  fail "ZOOVOICE_DEPLOY_APPLY must be 0 or 1"
fi
if [[ ! "$local_smoke_port" =~ ^[0-9]+$ ]] || ((local_smoke_port < 1024 || local_smoke_port > 65535)); then
  fail "ZOOVOICE_LOCAL_SMOKE_PORT must be an integer from 1024 to 65535"
fi

cd "$repository_root"
branch=$(git branch --show-current)
head_sha=$(git rev-parse HEAD)
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Git HEADを確認できませんでした。"
short_sha=${head_sha:0:12}
working_tree_status=$(git status --porcelain=v1)

echo "Zoovoice Cloud Run deployment"
echo "mode: $([[ "$apply" == "1" ]] && echo apply || echo dry-run)"
echo "project: $project"
echo "region: $region"
echo "service: $service"
echo "artifact repository: $artifact_repository"
echo "source branch: ${branch:-detached}"
echo "source revision: $short_sha"
if [[ -n "$working_tree_status" ]]; then
  echo "working tree: has changes"
else
  echo "working tree: clean"
fi

registry_host="${region}-docker.pkg.dev"
image_tag="${registry_host}/${project}/${artifact_repository}/${service}:${head_sha}"
smoke_service_account="${smoke_account_name}@${project}.iam.gserviceaccount.com"

if [[ "$apply" != "1" ]]; then
  echo "[dry-run] docker info"
  echo "[dry-run] gcloud auth print-access-token --project $project --quiet > <temporary-secret>"
  echo "[dry-run] docker buildx build --platform linux/amd64 --load --tag <local-smoke-image> --file services/zoovoice/Dockerfile ."
  echo "[dry-run] docker run --publish 127.0.0.1:${local_smoke_port}:8080 <local-smoke-image>"
  echo "[dry-run] curl local /healthz and /compose fixtures"
  echo "[dry-run] gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com --project $project --quiet"
  echo "[dry-run] gcloud artifacts repositories create $artifact_repository --repository-format docker --location $region --project $project --quiet (only when absent)"
  echo "[dry-run] gcloud auth configure-docker $registry_host --quiet"
  echo "[dry-run] docker buildx build --platform linux/amd64 --push --tag $image_tag --file services/zoovoice/Dockerfile ."
  echo "[dry-run] resolve pushed image digest and deploy IMAGE@sha256:<digest>"
  echo "[dry-run] gcloud run deploy $service --image <image-by-digest> --project $project --region $region --platform managed --ingress all --no-allow-unauthenticated --cpu 1 --memory 512Mi --port 8080 --timeout 90s --concurrency 1 --min-instances 0 --max-instances 2 --quiet"
  echo "[dry-run] create or reuse smoke service account <redacted>"
  echo "[dry-run] grant roles/run.invoker on service $service only to <smoke-service-account>"
  echo "[dry-run] grant roles/iam.serviceAccountTokenCreator on <smoke-service-account> to <active-developer>"
  echo "[dry-run] verify allUsers must be absent from Cloud Run and Artifact Registry IAM policies"
  exit 0
fi

[[ -z "$working_tree_status" ]] || fail "Applyにはcleanなworking treeが必要です。先に変更をcommitしてください。"
command -v docker >/dev/null 2>&1 || fail "Docker CLIが見つかりません。"
command -v gcloud >/dev/null 2>&1 || fail "gcloud CLIが見つかりません。"
command -v curl >/dev/null 2>&1 || fail "curlが見つかりません。"

umask 077
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/zoovoice-cloud-run-deploy.XXXXXX")
local_container_id=""
cleanup() {
  if [[ -n "$local_container_id" ]]; then
    docker rm --force "$local_container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

if ! docker info >/dev/null 2>"$temporary_directory/docker-info.err"; then
  fail "Docker daemonへ接続できませんでした。"
fi
if ! access_token=$(gcloud auth print-access-token --project "$project" --quiet 2>"$temporary_directory/gcloud-auth.err"); then
  fail "gcloud認証を確認できませんでした。"
fi
if [[ -z "$access_token" || ! "$access_token" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  fail "gcloud access tokenを確認できませんでした。"
fi
unset access_token

local_image="zoovoice-local-smoke:${short_sha}"
docker buildx build \
  --platform linux/amd64 \
  --load \
  --tag "$local_image" \
  --file services/zoovoice/Dockerfile \
  .
local_container_id=$(docker run \
  --detach \
  --rm \
  --publish "127.0.0.1:${local_smoke_port}:8080" \
  "$local_image")
[[ -n "$local_container_id" ]] || fail "local smoke containerを起動できませんでした。"

ready=0
for _attempt in {1..40}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${local_smoke_port}/healthz" >"$temporary_directory/health.json" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" == "1" ]] || fail "local smoke containerのhealth checkがtimeoutしました。"

if ! curl --fail --silent --show-error \
  --request POST \
  --form "audio=@services/zoovoice/testdata/compose-input.wav;type=audio/wav" \
  --form 'settings={"arrangement":{"opening":"rooster","gaps":"cow","ending":"rooster"},"intensity":100}' \
  --output "$temporary_directory/compose.json" \
  "http://127.0.0.1:${local_smoke_port}/compose"; then
  fail "local smoke containerのcompose確認に失敗しました。"
fi
python3 -c '
import base64
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
audio = payload.get("audio", {})
if audio.get("format") != "wav" or not base64.b64decode(audio.get("base64", ""), validate=True):
    raise SystemExit("invalid local compose response")
' "$temporary_directory/compose.json"

if ! gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  --project "$project" \
  --quiet >"$temporary_directory/services.out" 2>"$temporary_directory/services.err"; then
  fail "必要なGoogle Cloud APIを有効化できませんでした。"
fi

if ! gcloud artifacts repositories describe "$artifact_repository" \
  --location "$region" \
  --project "$project" \
  --format=json >"$temporary_directory/repository.json" 2>/dev/null; then
  if ! gcloud artifacts repositories create "$artifact_repository" \
    --repository-format docker \
    --location "$region" \
    --project "$project" \
    --description "Private Voice Lab container images" \
    --quiet >"$temporary_directory/repository-create.out" 2>"$temporary_directory/repository-create.err"; then
    fail "private Artifact Registry repositoryを作成できませんでした。"
  fi
fi

if ! gcloud auth configure-docker "$registry_host" --quiet \
  >"$temporary_directory/docker-auth.out" 2>"$temporary_directory/docker-auth.err"; then
  fail "Artifact Registry用Docker認証を設定できませんでした。"
fi
docker buildx build \
  --platform linux/amd64 \
  --push \
  --tag "$image_tag" \
  --file services/zoovoice/Dockerfile \
  .

if ! image_digest=$(gcloud artifacts docker images describe "$image_tag" \
  --project "$project" \
  --format='value(image_summary.digest)' \
  2>"$temporary_directory/image-digest.err"); then
  fail "pushしたimage digestを取得できませんでした。"
fi
if [[ ! "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "pushしたimage digestを確認できませんでした。"
fi
image_by_digest="${registry_host}/${project}/${artifact_repository}/${service}@${image_digest}"

if ! gcloud run deploy "$service" \
  --image "$image_by_digest" \
  --project "$project" \
  --region "$region" \
  --platform managed \
  --ingress all \
  --no-allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --port 8080 \
  --timeout 90s \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 2 \
  --quiet >"$temporary_directory/run-deploy.out" 2>"$temporary_directory/run-deploy.err"; then
  fail "private Cloud Run serviceをdeployできませんでした。"
fi

if ! gcloud iam service-accounts describe "$smoke_service_account" \
  --project "$project" \
  --format=json >"$temporary_directory/smoke-account.json" 2>/dev/null; then
  if ! gcloud iam service-accounts create "$smoke_account_name" \
    --project "$project" \
    --display-name "Zoovoice local smoke invoker" \
    --quiet >"$temporary_directory/smoke-account-create.out" 2>"$temporary_directory/smoke-account-create.err"; then
    fail "local smoke用service accountを作成できませんでした。"
  fi
fi

if ! gcloud run services add-iam-policy-binding "$service" \
  --project "$project" \
  --region "$region" \
  --member "serviceAccount:${smoke_service_account}" \
  --role roles/run.invoker \
  --quiet >"$temporary_directory/run-invoker.out" 2>"$temporary_directory/run-invoker.err"; then
  fail "local smoke用Cloud Run Invoker権限を設定できませんでした。"
fi

if ! developer_account=$(gcloud config get-value account --quiet 2>"$temporary_directory/gcloud-account.err"); then
  fail "active gcloud accountを確認できませんでした。"
fi
if [[ -z "$developer_account" || "$developer_account" == *[$'\r\n\t ']* || "$developer_account" != *@* ]]; then
  fail "active gcloud accountを確認できませんでした。"
fi
developer_member_type=user
if [[ "$developer_account" == *.gserviceaccount.com ]]; then
  developer_member_type=serviceAccount
fi
if ! gcloud iam service-accounts add-iam-policy-binding "$smoke_service_account" \
  --project "$project" \
  --member "${developer_member_type}:${developer_account}" \
  --role roles/iam.serviceAccountTokenCreator \
  --quiet >"$temporary_directory/token-creator.out" 2>"$temporary_directory/token-creator.err"; then
  fail "service account impersonation権限を設定できませんでした。"
fi
unset developer_account

if ! gcloud run services get-iam-policy "$service" \
  --project "$project" \
  --region "$region" \
  --format=json >"$temporary_directory/run-policy.json" 2>"$temporary_directory/run-policy.err"; then
  fail "Cloud Run IAM policyを確認できませんでした。"
fi
if ! gcloud artifacts repositories get-iam-policy "$artifact_repository" \
  --project "$project" \
  --location "$region" \
  --format=json >"$temporary_directory/repository-policy.json" 2>"$temporary_directory/repository-policy.err"; then
  fail "Artifact Registry IAM policyを確認できませんでした。"
fi
python3 -c '
import json
import pathlib
import sys

for policy_path in sys.argv[1:]:
    policy = json.loads(pathlib.Path(policy_path).read_text(encoding="utf-8"))
    members = {
        member
        for binding in policy.get("bindings", [])
        for member in binding.get("members", [])
    }
    if "allUsers" in members or "allAuthenticatedUsers" in members:
        raise SystemExit("public IAM member is present")
' "$temporary_directory/run-policy.json" "$temporary_directory/repository-policy.json"

service_url=$(gcloud run services describe "$service" \
  --project "$project" --region "$region" --format='value(status.url)' \
  2>"$temporary_directory/service-url.err")
revision=$(gcloud run services describe "$service" \
  --project "$project" --region "$region" --format='value(status.latestReadyRevisionName)' \
  2>"$temporary_directory/revision.err")
[[ "$service_url" == https://* ]] || fail "deployed service URLを確認できませんでした。"
[[ -n "$revision" && "$revision" != *[$'\r\n\t ']* ]] || fail "deployed revisionを確認できませんでした。"

echo "deployment complete"
echo "service URL: $service_url"
echo "revision: $revision"
echo "image digest: $image_digest"
echo "IAM: private (public members absent)"
