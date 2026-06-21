from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Qwen3-TTS voice clone synthesis.")
    parser.add_argument("--input-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    payload = json.loads(args.input_json.read_text(encoding="utf-8"))
    model = Qwen3TTSModel.from_pretrained(
        payload["model"],
        **_model_kwargs(payload),
    )
    wavs, sample_rate = model.generate_voice_clone(
        text=payload["text"],
        language=payload["language"],
        ref_audio=payload["reference_audio"],
        ref_text=payload["reference_text"],
        x_vector_only_mode=payload["x_vector_only_mode"],
    )
    sf.write(args.output, wavs[0], sample_rate)


def _model_kwargs(payload: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "device_map": payload.get("device_map") or "cpu",
        "dtype": _torch_dtype(payload.get("dtype") or "float32"),
    }
    if payload.get("attn_implementation"):
        kwargs["attn_implementation"] = payload["attn_implementation"]
    return kwargs


def _torch_dtype(value: str) -> torch.dtype:
    if value == "bfloat16":
        return torch.bfloat16
    if value == "float16":
        return torch.float16
    return torch.float32


if __name__ == "__main__":
    main()
