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


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a RunPod Serverless speech, text-TTS, or voice-conversion smoke request.")
    parser.add_argument("--endpoint-id", default=os.getenv("RUNPOD_ENDPOINT_ID"))
    parser.add_argument("--api-key", default=os.getenv("RUNPOD_API_KEY"))
    parser.add_argument("--operation-mode", choices=("translation", "text_tts", "voice_conversion"), default="translation")
    parser.add_argument("--audio")
    parser.add_argument("--reference-audio")
    parser.add_argument("--text", default=os.getenv("RUNPOD_SMOKE_TEXT"))
    parser.add_argument("--tts-backend", default=os.getenv("RUNPOD_SMOKE_TTS_BACKEND", "google_translate"))
    parser.add_argument("--translation-backend", default=os.getenv("RUNPOD_SMOKE_TRANSLATION_BACKEND", "qwen"))
    parser.add_argument("--source-language", default=os.getenv("RUNPOD_SMOKE_SOURCE_LANGUAGE", "id-ID"))
    parser.add_argument("--target-language", default=os.getenv("RUNPOD_SMOKE_TARGET_LANGUAGE", "ja-JP"))
    parser.add_argument("--voice-mode", default=os.getenv("RUNPOD_SMOKE_VOICE_MODE", "convert"))
    parser.add_argument("--voice-backend", default=os.getenv("RUNPOD_SMOKE_VOICE_BACKEND", "seed-vc"))
    parser.add_argument("--seed-vc-diffusion-steps", type=int)
    parser.add_argument("--seed-vc-reference-max-seconds", type=float)
    parser.add_argument("--seed-vc-length-adjust", type=float)
    parser.add_argument("--seed-vc-inference-cfg-rate", type=float)
    parser.add_argument("--text-transform", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM"))
    parser.add_argument("--text-transform-suffix", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM_SUFFIX"))
    parser.add_argument("--text-transform-unit", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM_UNIT", "text"))
    parser.add_argument("--timeout", type=int, default=int(os.getenv("RUNPOD_SMOKE_TIMEOUT_SECONDS", "1800")))
    args = parser.parse_args()

    if not args.endpoint_id:
        raise SystemExit("RUNPOD_ENDPOINT_ID or --endpoint-id is required")
    if not args.api_key:
        raise SystemExit("RUNPOD_API_KEY or --api-key is required")

    if args.operation_mode == "text_tts":
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
            raise SystemExit("--audio is required for translation and voice_conversion")
        audio_path = Path(args.audio)
        mime_type = mimetypes.guess_type(audio_path.name)[0] or "audio/wav"

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
    elif args.operation_mode == "translation":
        input_payload = {
            "audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
            "audio_mime_type": mime_type,
            "translation_backend": args.translation_backend,
            "source_language": args.source_language,
            "target_language": args.target_language,
            "voice_mode": args.voice_mode,
            "text_transform_unit": args.text_transform_unit,
        }
    if args.seed_vc_diffusion_steps is not None:
        input_payload["seed_vc_diffusion_steps"] = args.seed_vc_diffusion_steps
    if args.seed_vc_reference_max_seconds is not None:
        input_payload["seed_vc_reference_max_seconds"] = args.seed_vc_reference_max_seconds
    if args.seed_vc_length_adjust is not None:
        input_payload["seed_vc_length_adjust"] = args.seed_vc_length_adjust
    if args.seed_vc_inference_cfg_rate is not None:
        input_payload["seed_vc_inference_cfg_rate"] = args.seed_vc_inference_cfg_rate
    if args.text_transform:
        input_payload["text_transform"] = args.text_transform
    if args.text_transform_suffix:
        input_payload["text_transform_suffix"] = args.text_transform_suffix

    payload: dict[str, Any] = {"input": input_payload}

    request = urllib.request.Request(
        f"https://api.runpod.ai/v2/{args.endpoint_id}/runsync",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {args.api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        sys.stderr.write(exc.read().decode("utf-8", errors="replace"))
        sys.stderr.write("\n")
        return 1

    print(json.dumps(body, ensure_ascii=False, indent=2))
    if body.get("status") in {"FAILED", "TIMED_OUT", "CANCELLED"}:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
