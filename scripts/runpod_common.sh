#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUNPOD_APP_ENV_KEYS=(
  MO_PROVIDER_MODE
  MO_ASR_PROVIDER
  MO_TRANSLATION_PROVIDER
  MO_TTS_PROVIDER
  MO_PRELOAD_MODELS
  MO_RUNPOD_PRELOAD_ON_START
  MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START
  MO_AUDIO_HISTORY_ENABLED
  OPENAI_API_KEY
  OPENAI_ASR_MODEL
  OPENAI_TRANSLATION_MODEL
  OPENAI_TTS_MODEL
  OPENAI_TTS_VOICE
  OPENAI_TTS_RESPONSE_FORMAT
  OPENAI_TTS_INSTRUCTIONS
  MODEL_CACHE_DIR
  HF_HOME
  HF_HUB_CACHE
  FASTER_WHISPER_CACHE_DIR
  FASTER_WHISPER_MODEL
  FASTER_WHISPER_DEVICE
  FASTER_WHISPER_COMPUTE_TYPE
  FASTER_WHISPER_LOCAL_FILES_ONLY
  QWEN_TRANSLATION_MODEL
  QWEN_TRANSLATION_DEVICE_MAP
  QWEN_TRANSLATION_DTYPE
  QWEN_TRANSLATION_LOCAL_FILES_ONLY
  QWEN_TRANSLATION_MAX_NEW_TOKENS
  QWEN_TTS_MODEL
  QWEN_TTS_DEVICE_MAP
  QWEN_TTS_DTYPE
  QWEN_TTS_ATTN
  QWEN_TTS_TIMEOUT_SECONDS
  QWEN_TTS_X_VECTOR_ONLY
  SEED_VC_WORK_DIR
  SEED_VC_REFERENCE_MAX_SECONDS
  SEED_VC_REFERENCE_SAMPLE_RATE
  SEED_VC_REFERENCE_PREPARE_TIMEOUT_SECONDS
  SEED_VC_DIFFUSION_STEPS
  SEED_VC_LENGTH_ADJUST
  SEED_VC_INFERENCE_CFG_RATE
  SEED_VC_FP16
  SEED_VC_CHECKPOINT
  SEED_VC_CONFIG
  SEED_VC_TIMEOUT_SECONDS
)

load_runpod_env() {
  local env_file="${RUNPOD_ENV_FILE:-${REPO_ROOT}/.runpod.env}"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

set_default_runpod_app_env() {
  export MO_PROVIDER_MODE="${MO_PROVIDER_MODE:-local}"
  export MO_ASR_PROVIDER="${MO_ASR_PROVIDER:-faster-whisper}"
  export MO_TRANSLATION_PROVIDER="${MO_TRANSLATION_PROVIDER:-qwen3}"
  export MO_TTS_PROVIDER="${MO_TTS_PROVIDER:-qwen-seed-vc}"
  export MO_PRELOAD_MODELS="${MO_PRELOAD_MODELS:-1}"
  export MO_RUNPOD_PRELOAD_ON_START="${MO_RUNPOD_PRELOAD_ON_START:-1}"
  export MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START="${MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START:-1}"
  export MO_AUDIO_HISTORY_ENABLED="${MO_AUDIO_HISTORY_ENABLED:-0}"
  export OPENAI_ASR_MODEL="${OPENAI_ASR_MODEL:-gpt-4o-transcribe}"
  export OPENAI_TRANSLATION_MODEL="${OPENAI_TRANSLATION_MODEL:-gpt-5.5}"
  export OPENAI_TTS_MODEL="${OPENAI_TTS_MODEL:-gpt-4o-mini-tts}"
  export OPENAI_TTS_VOICE="${OPENAI_TTS_VOICE:-coral}"
  export OPENAI_TTS_RESPONSE_FORMAT="${OPENAI_TTS_RESPONSE_FORMAT:-wav}"
  export MODEL_CACHE_DIR="${MODEL_CACHE_DIR:-/runpod-volume/models}"
  export HF_HOME="${HF_HOME:-/runpod-volume/huggingface}"
  export HF_HUB_CACHE="${HF_HUB_CACHE:-/runpod-volume/huggingface/hub}"
  export FASTER_WHISPER_CACHE_DIR="${FASTER_WHISPER_CACHE_DIR:-/runpod-volume/models/faster-whisper}"
  export SEED_VC_WORK_DIR="${SEED_VC_WORK_DIR:-/runpod-volume/work/seed-vc}"
  export FASTER_WHISPER_MODEL="${FASTER_WHISPER_MODEL:-mobiuslabsgmbh/faster-whisper-large-v3-turbo}"
  export FASTER_WHISPER_DEVICE="${FASTER_WHISPER_DEVICE:-cuda}"
  export FASTER_WHISPER_COMPUTE_TYPE="${FASTER_WHISPER_COMPUTE_TYPE:-float16}"
  export FASTER_WHISPER_LOCAL_FILES_ONLY="${FASTER_WHISPER_LOCAL_FILES_ONLY:-0}"
  export QWEN_TRANSLATION_MODEL="${QWEN_TRANSLATION_MODEL:-Qwen/Qwen3-4B}"
  export QWEN_TRANSLATION_DEVICE_MAP="${QWEN_TRANSLATION_DEVICE_MAP:-auto}"
  export QWEN_TRANSLATION_DTYPE="${QWEN_TRANSLATION_DTYPE:-auto}"
  export QWEN_TRANSLATION_LOCAL_FILES_ONLY="${QWEN_TRANSLATION_LOCAL_FILES_ONLY:-0}"
  export QWEN_TTS_MODEL="${QWEN_TTS_MODEL:-Qwen/Qwen3-TTS-12Hz-1.7B-Base}"
  export QWEN_TTS_DEVICE_MAP="${QWEN_TTS_DEVICE_MAP:-auto}"
  export QWEN_TTS_DTYPE="${QWEN_TTS_DTYPE:-float16}"
  export SEED_VC_FP16="${SEED_VC_FP16:-true}"
  export SEED_VC_REFERENCE_MAX_SECONDS="${SEED_VC_REFERENCE_MAX_SECONDS:-10}"
  export SEED_VC_REFERENCE_SAMPLE_RATE="${SEED_VC_REFERENCE_SAMPLE_RATE:-24000}"
  export SEED_VC_REFERENCE_PREPARE_TIMEOUT_SECONDS="${SEED_VC_REFERENCE_PREPARE_TIMEOUT_SECONDS:-90}"
  export SEED_VC_DIFFUSION_STEPS="${SEED_VC_DIFFUSION_STEPS:-30}"
  export SEED_VC_LENGTH_ADJUST="${SEED_VC_LENGTH_ADJUST:-1.0}"
  export SEED_VC_INFERENCE_CFG_RATE="${SEED_VC_INFERENCE_CFG_RATE:-0.7}"
}

require_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "required command is missing: ${name}" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "required environment variable is missing: ${name}" >&2
    exit 1
  fi
}

runpod_env_json() {
  python3 - "$@" <<'PY'
import json
import os
import sys

env = {key: os.environ[key] for key in sys.argv[1:] if os.environ.get(key)}
print(json.dumps(env, ensure_ascii=True, separators=(",", ":")))
PY
}

runpod_resolve_datetime() {
  local value="$1"
  if [[ "${value}" =~ ^([0-9]+)[hH]$ ]]; then
    local hours="${BASH_REMATCH[1]}"
    if date -u -v+"${hours}"H +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
      date -u -v+"${hours}"H +%Y-%m-%dT%H:%M:%SZ
      return 0
    fi
    date -u -d "+${hours} hours" +%Y-%m-%dT%H:%M:%SZ
    return 0
  fi
  printf '%s\n' "${value}"
}

print_command() {
  printf 'running:'
  printf ' %q' "$@"
  printf '\n'
}

run_or_print() {
  print_command "$@"
  if [[ "${RUNPOD_DRY_RUN:-0}" == "1" ]]; then
    return 0
  fi
  "$@"
}
