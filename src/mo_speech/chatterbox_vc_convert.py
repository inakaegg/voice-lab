from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Chatterbox voice conversion.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--model-dir")
    args = parser.parse_args()

    import torch
    import torchaudio as ta
    import perth

    if getattr(perth, "PerthImplicitWatermarker", None) is None:
        perth.PerthImplicitWatermarker = perth.DummyWatermarker

    from chatterbox.vc import ChatterboxVC

    device = _resolve_device(args.device, torch)
    if args.model_dir:
        model = ChatterboxVC.from_local(Path(args.model_dir), device)
    else:
        model = ChatterboxVC.from_pretrained(device)
    wav = model.generate(audio=args.source, target_voice_path=args.reference)
    ta.save(args.output, wav, model.sr)


def _resolve_device(requested: str, torch_module) -> str:
    if requested != "auto":
        return requested
    if torch_module.cuda.is_available():
        return "cuda"
    if torch_module.backends.mps.is_available():
        return "mps"
    return "cpu"


if __name__ == "__main__":
    main()
