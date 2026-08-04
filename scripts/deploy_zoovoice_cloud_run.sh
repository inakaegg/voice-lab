#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "$1" >&2
  exit 1
}

required_value() {
  local name=$1
  local value=$2
  [[ -n "$value" ]] || fail "$name is required"
}

script_directory=${BASH_SOURCE[0]%/*}
repository_root=$(cd "$script_directory/.." && pwd -P)

project=${ZOOVOICE_GCP_PROJECT:-}
apply=${ZOOVOICE_DEPLOY_APPLY:-0}
local_verify=${ZOOVOICE_LOCAL_VERIFY:-0}
whisper_source=${ZOOVOICE_WHISPER_SOURCE_DIR:-}
asr_model=${ZOOVOICE_ASR_MODEL_PATH:-}
conceptnet_index=${ZOOVOICE_CONCEPTNET_INDEX_PATH:-}
smoke_audio=${ZOOVOICE_SMOKE_AUDIO_PATH:-}
region=us-central1
service=zoovoice
artifact_repository=voice-lab
smoke_account_name=zoovoice-local-smoke-invoker
local_smoke_port=${ZOOVOICE_LOCAL_SMOKE_PORT:-18080}

expected_whisper_commit=5250a86fdebac4d51085fcfcd0b315cb0c6b91c9
expected_model_sha256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b
expected_index_sha256=91f5a07310b3791ebe3b0bab70cfd137c5388ff02dd291673f3fdd8313343344
expected_conceptnet_source_sha256=accd65fe94038584295574ddc26e1500c1919c8c4532bf771811cafd0948af7e
expected_transformation='Japanese ConceptNet 1-hop edges whose opposite endpoint matches a Zoovoice animal alias; duplicate weights keep the maximum'

required_value ZOOVOICE_GCP_PROJECT "$project"
if [[ ! "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  fail "ZOOVOICE_GCP_PROJECT is invalid"
fi
if [[ "$apply" != "0" && "$apply" != "1" ]]; then
  fail "ZOOVOICE_DEPLOY_APPLY must be 0 or 1"
fi
if [[ "$local_verify" != "0" && "$local_verify" != "1" ]]; then
  fail "ZOOVOICE_LOCAL_VERIFY must be 0 or 1"
fi
if [[ "$apply" == "1" && "$local_verify" == "1" ]]; then
  fail "ZOOVOICE_DEPLOY_APPLY and ZOOVOICE_LOCAL_VERIFY cannot both be 1"
fi
if [[ ! "$local_smoke_port" =~ ^[0-9]+$ ]] || ((local_smoke_port < 1024 || local_smoke_port > 65535)); then
  fail "ZOOVOICE_LOCAL_SMOKE_PORT must be an integer from 1024 to 65535"
fi

required_value ZOOVOICE_WHISPER_SOURCE_DIR "$whisper_source"
required_value ZOOVOICE_ASR_MODEL_PATH "$asr_model"
required_value ZOOVOICE_CONCEPTNET_INDEX_PATH "$conceptnet_index"
required_value ZOOVOICE_SMOKE_AUDIO_PATH "$smoke_audio"
[[ -d "$whisper_source" ]] || fail "ZOOVOICE_WHISPER_SOURCE_DIR must be a directory"
[[ -f "$whisper_source/CMakeLists.txt" && -f "$whisper_source/LICENSE" ]] || fail "whisper.cpp source is incomplete"
[[ -f "$asr_model" ]] || fail "ZOOVOICE_ASR_MODEL_PATH must be a regular file"
[[ -f "$conceptnet_index" ]] || fail "ZOOVOICE_CONCEPTNET_INDEX_PATH must be a regular file"
[[ -f "$smoke_audio" ]] || fail "ZOOVOICE_SMOKE_AUDIO_PATH must be a regular file"

whisper_commit=$(git -C "$whisper_source" rev-parse HEAD 2>/dev/null) || fail "whisper.cpp commitを確認できませんでした。"
[[ "$whisper_commit" == "$expected_whisper_commit" ]] || fail "whisper.cpp commit mismatch"
whisper_status=$(git -C "$whisper_source" status --porcelain=v1 --untracked-files=all 2>/dev/null) \
  || fail "whisper.cpp source statusを確認できませんでした。"
[[ -z "$whisper_status" ]] || fail "whisper.cpp source must be clean"
unset whisper_status
model_sha256=$(shasum -a 256 "$asr_model" | awk '{print $1}')
[[ "$model_sha256" == "$expected_model_sha256" ]] || fail "ASR model SHA-256 mismatch"
index_sha256=$(shasum -a 256 "$conceptnet_index" | awk '{print $1}')
[[ "$index_sha256" == "$expected_index_sha256" ]] || fail "ConceptNet index SHA-256 mismatch"
alias_sha256=$(shasum -a 256 "$repository_root/services/zoovoice/assets/association-aliases.json" | awk '{print $1}')

metadata=$(sqlite3 -noheader -separator '|' "$conceptnet_index" \
  "SELECT
    (SELECT value FROM metadata WHERE key='schema_version'),
    (SELECT value FROM metadata WHERE key='source_version'),
    (SELECT value FROM metadata WHERE key='license'),
    (SELECT value FROM metadata WHERE key='source_sha256'),
    (SELECT value FROM metadata WHERE key='alias_sha256'),
    (SELECT value FROM metadata WHERE key='transformation');") || fail "ConceptNet index metadataを読み取れませんでした。"
expected_metadata="1|5.7.0|CC BY-SA 4.0|${expected_conceptnet_source_sha256}|${alias_sha256}|${expected_transformation}"
[[ "$metadata" == "$expected_metadata" ]] || fail "ConceptNet index metadata mismatch"
unset metadata expected_metadata

cd "$repository_root"
branch=$(git branch --show-current)
head_sha=$(git rev-parse HEAD)
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Git HEADを確認できませんでした。"
short_sha=${head_sha:0:12}
working_tree_status=$(git status --porcelain=v1)

mode=dry-run
if [[ "$apply" == "1" ]]; then
  mode=apply
elif [[ "$local_verify" == "1" ]]; then
  mode=local-verify
fi

echo "Zoovoice Cloud Run deployment"
echo "mode: $mode"
echo "project: $project"
echo "region: $region"
echo "service: $service"
echo "artifact repository: $artifact_repository"
echo "source branch: ${branch:-detached}"
echo "source revision: $short_sha"
echo "whisper.cpp revision: ${whisper_commit:0:12}"
echo "ASR model: verified"
echo "ConceptNet index: verified"
if [[ -n "$working_tree_status" ]]; then
  echo "working tree: has changes"
else
  echo "working tree: clean"
fi

registry_host="${region}-docker.pkg.dev"
image_tag="${registry_host}/${project}/${artifact_repository}/${service}:${head_sha}"
smoke_service_account="${smoke_account_name}@${project}.iam.gserviceaccount.com"

if [[ "$mode" == "dry-run" ]]; then
  echo "[dry-run] copy verified whisper.cpp source excluding .git, build, models, and samples into a temporary context"
  echo "[dry-run] copy verified ASR model, ConceptNet index, and license into a temporary runtime context"
  echo "[dry-run] docker info"
  echo "[dry-run] docker buildx build --platform linux/amd64 --load --build-context whisper_source=<temporary-context> --build-context zoovoice_runtime=<temporary-context> --tag <local-smoke-image> --file services/zoovoice/Dockerfile ."
  echo "[dry-run] docker run --memory 2g --cpus 2 --publish 127.0.0.1:${local_smoke_port}:8080 <local-smoke-image>"
  echo "[dry-run] curl local /healthz and intensity-only /compose fixture"
  echo "[dry-run] gcloud auth print-access-token --project $project --quiet > <temporary-secret>"
  echo "[dry-run] gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com --project $project --quiet"
  echo "[dry-run] gcloud artifacts repositories create $artifact_repository --repository-format docker --location $region --project $project --quiet (only when absent)"
  echo "[dry-run] gcloud auth configure-docker $registry_host --quiet"
  echo "[dry-run] docker buildx build --platform linux/amd64 --push --build-context whisper_source=<temporary-context> --build-context zoovoice_runtime=<temporary-context> --tag $image_tag --file services/zoovoice/Dockerfile ."
  echo "[dry-run] resolve pushed image digest and deploy IMAGE@sha256:<digest>"
  echo "[dry-run] gcloud run deploy $service --image <image-by-digest> --project $project --region $region --platform managed --ingress all --no-allow-unauthenticated --cpu 2 --memory 2Gi --port 8080 --timeout 90s --concurrency 1 --min-instances 0 --max-instances 2 --quiet"
  echo "[dry-run] create or reuse smoke service account <redacted>"
  echo "[dry-run] grant roles/run.invoker on service $service only to <smoke-service-account>"
  echo "[dry-run] grant roles/iam.serviceAccountTokenCreator on <smoke-service-account> to <active-developer>"
  echo "[dry-run] verify allUsers must be absent from Cloud Run and Artifact Registry IAM policies"
  exit 0
fi

if [[ "$apply" == "1" && -n "$working_tree_status" ]]; then
  fail "Applyにはcleanなworking treeが必要です。先に変更をcommitしてください。"
fi
command -v docker >/dev/null 2>&1 || fail "Docker CLIが見つかりません。"
command -v curl >/dev/null 2>&1 || fail "curlが見つかりません。"
command -v python3 >/dev/null 2>&1 || fail "python3が見つかりません。"
if [[ "$apply" == "1" ]]; then
  command -v gcloud >/dev/null 2>&1 || fail "gcloud CLIが見つかりません。"
fi

umask 077
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/zoovoice-cloud-run-deploy.XXXXXX")
whisper_context="$temporary_directory/whisper-source"
runtime_context="$temporary_directory/runtime"
local_container_id=""
cleanup() {
  if [[ -n "$local_container_id" ]]; then
    docker rm --force "$local_container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

mkdir -p "$whisper_context" "$runtime_context"
(
  cd "$whisper_source"
  tar \
    --exclude=.git \
    --exclude=build \
    --exclude=models \
    --exclude=samples \
    --exclude='*.bin' \
    -cf - .
) | tar -xf - -C "$whisper_context"
cp "$asr_model" "$runtime_context/ggml-small.bin"
cp "$conceptnet_index" "$runtime_context/conceptnet-ja-5.7.0.sqlite"
cp services/zoovoice/LICENSE-CONCEPTNET.md "$runtime_context/LICENSE-CONCEPTNET.md"

build_arguments=(
  --platform linux/amd64
  --build-context "whisper_source=$whisper_context"
  --build-context "zoovoice_runtime=$runtime_context"
  --build-arg "WHISPER_SOURCE_COMMIT=$whisper_commit"
  --build-arg "ZOOVOICE_ASR_MODEL_SHA256=$model_sha256"
  --build-arg "ZOOVOICE_CONCEPTNET_INDEX_SHA256=$index_sha256"
  --build-arg "ZOOVOICE_ASSOCIATION_ALIASES_SHA256=$alias_sha256"
  --file services/zoovoice/Dockerfile
)

if ! docker info >/dev/null 2>"$temporary_directory/docker-info.err"; then
  fail "Docker daemonへ接続できませんでした。"
fi

local_image="zoovoice-local-smoke:${short_sha}"
docker buildx build "${build_arguments[@]}" --load --tag "$local_image" .

cold_start_started=$(python3 -c 'import time; print(time.monotonic_ns())')
local_container_id=$(docker run \
  --detach \
  --rm \
  --platform linux/amd64 \
  --memory 2g \
  --cpus 2 \
  --publish "127.0.0.1:${local_smoke_port}:8080" \
  "$local_image")
[[ -n "$local_container_id" ]] || fail "local smoke containerを起動できませんでした。"

ready=0
for _attempt in {1..180}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${local_smoke_port}/healthz" >"$temporary_directory/health.json" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" == "1" ]] || fail "local smoke containerのhealth checkがtimeoutしました。"
cold_start_finished=$(python3 -c 'import time; print(time.monotonic_ns())')

compose_started=$(python3 -c 'import time; print(time.monotonic_ns())')
if ! curl --fail --silent --show-error \
  --request POST \
  --form "audio=@${smoke_audio};type=audio/wav" \
  --form 'settings={"intensity":50}' \
  --output "$temporary_directory/compose.json" \
  "http://127.0.0.1:${local_smoke_port}/compose"; then
  fail "local smoke containerのcompose確認に失敗しました。"
fi
compose_finished=$(python3 -c 'import time; print(time.monotonic_ns())')
python3 -c '
import base64
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
audio = payload.get("audio", {})
meta = payload.get("meta", {})
selected = meta.get("selected_animal", {})
if audio.get("format") != "wav" or not base64.b64decode(audio.get("base64", ""), validate=True):
    raise SystemExit("invalid local compose audio")
if not isinstance(meta.get("transcript"), str) or not meta["transcript"].strip():
    raise SystemExit("invalid local compose transcript")
if not isinstance(selected.get("id"), str) or not selected["id"]:
    raise SystemExit("invalid local compose selected animal")
if meta.get("selection_strategy") not in {"direct", "pun", "conceptnet", "random_fallback"}:
    raise SystemExit("invalid local compose strategy")
' "$temporary_directory/compose.json"

image_size_bytes=$(docker image inspect --format '{{.Size}}' "$local_image")
container_memory=$(docker stats --no-stream --format '{{.MemUsage}}' "$local_container_id")
cold_start_ms=$(((cold_start_finished - cold_start_started) / 1000000))
compose_ms=$(((compose_finished - compose_started) / 1000000))
echo "local verification complete"
echo "image size bytes: $image_size_bytes"
echo "container memory: $container_memory"
echo "cold start ms: $cold_start_ms"
echo "real compose ms: $compose_ms"

if [[ "$local_verify" == "1" ]]; then
  exit 0
fi

if ! access_token=$(gcloud auth print-access-token --project "$project" --quiet 2>"$temporary_directory/gcloud-auth.err"); then
  fail "gcloud認証を確認できませんでした。"
fi
if [[ -z "$access_token" || ! "$access_token" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  fail "gcloud access tokenを確認できませんでした。"
fi
unset access_token

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
docker buildx build "${build_arguments[@]}" --push --tag "$image_tag" .

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
  --cpu 2 \
  --memory 2Gi \
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
