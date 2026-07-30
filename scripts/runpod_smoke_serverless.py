from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


PRACTICE_ASR_CONTRACT_VERSION = 3


def _optional_float_env(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return float(value)


def _optional_int_env(name: str) -> int | None:
    value = os.getenv(name)
    if value is None or value == "":
        return None
    return int(value)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a RunPod Serverless practice-ASR, text-TTS, voice-conversion, warmup, or diagnostics smoke request."
    )
    parser.add_argument("--endpoint-id", default=os.getenv("RUNPOD_ENDPOINT_ID"))
    parser.add_argument("--api-key", default=os.getenv("RUNPOD_API_KEY"))
    parser.add_argument(
        "--operation-mode",
        choices=("practice_asr", "text_tts", "voice_conversion", "warmup", "diagnostics"),
        default="diagnostics",
    )
    parser.add_argument("--request-mode", choices=("sync", "async"), default=os.getenv("RUNPOD_SMOKE_REQUEST_MODE", "sync"))
    parser.add_argument("--audio")
    parser.add_argument("--model-audio")
    parser.add_argument("--reference-audio")
    parser.add_argument("--text", default=os.getenv("RUNPOD_SMOKE_TEXT"))
    parser.add_argument("--target-text", default=os.getenv("RUNPOD_SMOKE_TARGET_TEXT"))
    parser.add_argument("--tts-backend", default=os.getenv("RUNPOD_SMOKE_TTS_BACKEND", "openai"))
    parser.add_argument("--target-language", default=os.getenv("RUNPOD_SMOKE_TARGET_LANGUAGE", "ja-JP"))
    parser.add_argument("--voice-backend", default=os.getenv("RUNPOD_SMOKE_VOICE_BACKEND", "seed-vc"))
    parser.add_argument("--seed-vc-diffusion-steps", type=int)
    parser.add_argument("--seed-vc-reference-max-seconds", type=float)
    parser.add_argument("--seed-vc-length-adjust", type=float)
    parser.add_argument("--seed-vc-inference-cfg-rate", type=float)
    parser.add_argument(
        "--preload-voice-conversion",
        action="store_true",
        default=os.getenv("RUNPOD_SMOKE_PRELOAD_VOICE_CONVERSION") == "1",
    )
    parser.add_argument(
        "--preload-practice-asr",
        action="store_true",
        default=os.getenv("RUNPOD_SMOKE_PRELOAD_PRACTICE_ASR") == "1",
    )
    parser.add_argument("--timeout", type=int, default=int(os.getenv("RUNPOD_SMOKE_TIMEOUT_SECONDS", "1800")))
    parser.add_argument("--http-timeout", type=int, default=int(os.getenv("RUNPOD_SMOKE_HTTP_TIMEOUT_SECONDS", "120")))
    parser.add_argument("--poll-interval", type=float, default=float(os.getenv("RUNPOD_SMOKE_POLL_INTERVAL_SECONDS", "1.0")))
    parser.add_argument("--print-audio-base64", action="store_true")
    args = parser.parse_args()

    if not args.endpoint_id:
        raise SystemExit("RUNPOD_ENDPOINT_ID or --endpoint-id is required")
    if not args.api_key:
        raise SystemExit("RUNPOD_API_KEY or --api-key is required")

    if args.operation_mode == "diagnostics":
        input_payload = {"operation_mode": "diagnostics"}
    elif args.operation_mode == "warmup":
        input_payload = {
            "operation_mode": "warmup",
            "preload_voice_conversion": args.preload_voice_conversion,
            "preload_practice_asr": args.preload_practice_asr,
        }
    elif args.operation_mode == "text_tts":
        if not args.text:
            raise SystemExit("--text is required for text_tts")
        input_payload = {
            "operation_mode": "text_tts",
            "text": args.text,
            "target_language": args.target_language,
            "tts_backend": args.tts_backend,
        }
    else:
        if not args.audio:
            raise SystemExit("--audio is required for practice_asr and voice_conversion")
        audio_path = Path(args.audio)
        mime_type = "audio/webm" if audio_path.suffix.lower() == ".webm" else (mimetypes.guess_type(audio_path.name)[0] or "audio/wav")

    if args.operation_mode == "voice_conversion":
        if not args.reference_audio:
            raise SystemExit("--reference-audio is required for voice_conversion")
        reference_audio_path = Path(args.reference_audio)
        reference_mime_type = mimetypes.guess_type(reference_audio_path.name)[0] or "audio/wav"
        input_payload: dict[str, Any] = {
            "operation_mode": "voice_conversion",
            "source_audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
            "source_audio_mime_type": mime_type,
            "reference_audio_base64": base64.b64encode(reference_audio_path.read_bytes()).decode("ascii"),
            "reference_audio_mime_type": reference_mime_type,
            "voice_backend": args.voice_backend,
        }
    elif args.operation_mode == "practice_asr":
        input_payload = {
            "operation_mode": "practice_asr",
            "audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
            "audio_mime_type": mime_type,
            "source_language": "zh-CN",
        }
        input_payload["align_timestamps"] = bool(args.model_audio)
        if args.model_audio:
            model_audio_path = Path(args.model_audio)
            input_payload["model_audio_base64"] = base64.b64encode(model_audio_path.read_bytes()).decode("ascii")
            input_payload["model_audio_mime_type"] = (
                mimetypes.guess_type(model_audio_path.name)[0] or "audio/wav"
            )
        if args.target_text:
            input_payload["target_text"] = args.target_text
    if args.seed_vc_diffusion_steps is not None:
        input_payload["seed_vc_diffusion_steps"] = args.seed_vc_diffusion_steps
    if args.seed_vc_reference_max_seconds is not None:
        input_payload["seed_vc_reference_max_seconds"] = args.seed_vc_reference_max_seconds
    if args.seed_vc_length_adjust is not None:
        input_payload["seed_vc_length_adjust"] = args.seed_vc_length_adjust
    if args.seed_vc_inference_cfg_rate is not None:
        input_payload["seed_vc_inference_cfg_rate"] = args.seed_vc_inference_cfg_rate
    payload: dict[str, Any] = {"input": input_payload}

    try:
        if args.request_mode == "async":
            body = _run_async_request(
                args.endpoint_id,
                args.api_key,
                payload,
                args.timeout,
                args.http_timeout,
                args.poll_interval,
            )
        else:
            body = _json_request(
                f"https://api.runpod.ai/v2/{args.endpoint_id}/runsync",
                args.api_key,
                payload,
                timeout=args.timeout,
            )
    except urllib.error.HTTPError as exc:
        sys.stderr.write(f"RunPod request failed with HTTP {exc.code}\n")
        return 1

    printable_body = body if args.print_audio_base64 else _redact_audio_base64(body)
    print(json.dumps(printable_body, ensure_ascii=False, indent=2))
    if body.get("status") in {"FAILED", "TIMED_OUT", "CANCELLED"}:
        return 1
    if args.operation_mode == "practice_asr" and args.model_audio:
        output = body.get("output")
        if not isinstance(output, dict) and isinstance(body.get("text"), str):
            output = body
        if not isinstance(output, dict):
            sys.stderr.write("practice_asr smoke did not return an output object\n")
            return 1
        if output.get("practice_asr_contract_version") != PRACTICE_ASR_CONTRACT_VERSION:
            sys.stderr.write(
                f"practice_asr contract mismatch: expected v{PRACTICE_ASR_CONTRACT_VERSION}; "
                "redeploy the current RunPod image\n"
            )
            return 1
        if not isinstance(output.get("model_transcription"), dict):
            sys.stderr.write("practice_asr smoke did not return model_transcription\n")
            return 1
    return 0


def _run_async_request(
    endpoint_id: str,
    api_key: str,
    payload: dict[str, Any],
    timeout: int,
    http_timeout: int,
    poll_interval: float,
) -> dict[str, Any]:
    started = _monotonic_seconds()
    body = _json_request(f"https://api.runpod.ai/v2/{endpoint_id}/run", api_key, payload, timeout=http_timeout)
    job_id = body.get("id")
    if not job_id:
        return body
    sys.stderr.write(f"RunPod job id: {job_id}\n")
    while True:
        status_body = _json_request(
            f"https://api.runpod.ai/v2/{endpoint_id}/status/{job_id}",
            api_key,
            None,
            timeout=http_timeout,
            method="GET",
        )
        status = status_body.get("status")
        if status in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            return status_body
        if _monotonic_seconds() - started >= timeout:
            return {"id": job_id, "status": "TIMED_OUT", "error": f"polling timed out after {timeout}s"}
        import time

        time.sleep(poll_interval)


def _json_request(
    url: str,
    api_key: str,
    payload: dict[str, Any] | None,
    *,
    timeout: int,
    method: str = "POST",
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _monotonic_seconds() -> float:
    import time

    return time.monotonic()


def _redact_audio_base64(value: Any) -> Any:
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, item in value.items():
            if key.endswith("audio_base64") and isinstance(item, str):
                output[key] = f"<{key} {len(item)} chars>"
            else:
                output[key] = _redact_audio_base64(item)
        return output
    if isinstance(value, list):
        return [_redact_audio_base64(item) for item in value]
    return value


if __name__ == "__main__":
    raise SystemExit(main())
