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
    parser = argparse.ArgumentParser(description="Run a RunPod Serverless speech translation smoke request.")
    parser.add_argument("--endpoint-id", default=os.getenv("RUNPOD_ENDPOINT_ID"))
    parser.add_argument("--api-key", default=os.getenv("RUNPOD_API_KEY"))
    parser.add_argument("--audio", required=True)
    parser.add_argument("--source-language", default=os.getenv("RUNPOD_SMOKE_SOURCE_LANGUAGE", "id-ID"))
    parser.add_argument("--target-language", default=os.getenv("RUNPOD_SMOKE_TARGET_LANGUAGE", "ja-JP"))
    parser.add_argument("--voice-mode", default=os.getenv("RUNPOD_SMOKE_VOICE_MODE", "convert"))
    parser.add_argument("--text-transform", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM"))
    parser.add_argument("--text-transform-suffix", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM_SUFFIX"))
    parser.add_argument("--text-transform-unit", default=os.getenv("RUNPOD_SMOKE_TEXT_TRANSFORM_UNIT", "text"))
    parser.add_argument("--timeout", type=int, default=int(os.getenv("RUNPOD_SMOKE_TIMEOUT_SECONDS", "1800")))
    args = parser.parse_args()

    if not args.endpoint_id:
        raise SystemExit("RUNPOD_ENDPOINT_ID or --endpoint-id is required")
    if not args.api_key:
        raise SystemExit("RUNPOD_API_KEY or --api-key is required")

    audio_path = Path(args.audio)
    mime_type = mimetypes.guess_type(audio_path.name)[0] or "audio/wav"
    payload: dict[str, Any] = {
        "input": {
            "audio_base64": base64.b64encode(audio_path.read_bytes()).decode("ascii"),
            "audio_mime_type": mime_type,
            "source_language": args.source_language,
            "target_language": args.target_language,
            "voice_mode": args.voice_mode,
            "text_transform_unit": args.text_transform_unit,
        }
    }
    if args.text_transform:
        payload["input"]["text_transform"] = args.text_transform
    if args.text_transform_suffix:
        payload["input"]["text_transform_suffix"] = args.text_transform_suffix

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
