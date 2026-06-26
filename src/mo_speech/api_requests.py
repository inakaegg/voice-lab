from __future__ import annotations

import json
from pathlib import Path

from fastapi import HTTPException

from .pipeline import PipelineRequest
from .providers.voice import SeedVcRuntimeSettings


def create_seed_vc_settings(
    *,
    diffusion_steps: int | None,
    length_adjust: float | None,
    inference_cfg_rate: float | None,
    reference_max_seconds: float | None,
    reference_auto_select: bool | None,
) -> SeedVcRuntimeSettings:
    validate_optional_number("seed_vc_diffusion_steps", diffusion_steps, minimum=1, maximum=80)
    validate_optional_number("seed_vc_length_adjust", length_adjust, minimum=0.25, maximum=4.0)
    validate_optional_number("seed_vc_inference_cfg_rate", inference_cfg_rate, minimum=0.0, maximum=2.0)
    validate_optional_number("seed_vc_reference_max_seconds", reference_max_seconds, minimum=0.5, maximum=30.0)
    return SeedVcRuntimeSettings(
        diffusion_steps=diffusion_steps,
        length_adjust=length_adjust,
        inference_cfg_rate=inference_cfg_rate,
        reference_max_seconds=reference_max_seconds,
        reference_auto_select=reference_auto_select,
    )


def validate_optional_number(name: str, value: float | int | None, *, minimum: float, maximum: float) -> None:
    if value is None:
        return
    if value < minimum or value > maximum:
        raise HTTPException(status_code=400, detail=f"{name} must be between {minimum} and {maximum}")


def create_pipeline_request(
    audio_path: Path,
    source_language: str,
    target_language: str,
    voice_mode: str,
    text_transform: str | None,
    text_transform_options_json: str | None,
    text_transform_suffix: str | None,
    text_transform_unit: str,
    seed_vc_diffusion_steps: int | None,
    seed_vc_length_adjust: float | None,
    seed_vc_inference_cfg_rate: float | None,
    seed_vc_reference_max_seconds: float | None,
    seed_vc_reference_auto_select: bool | None,
) -> PipelineRequest:
    options: dict[str, object] = _parse_text_transform_options(text_transform_options_json)
    if text_transform_suffix is not None:
        options["suffix"] = text_transform_suffix
    if text_transform_unit:
        options["unit"] = text_transform_unit
    return PipelineRequest(
        audio_path=audio_path,
        source_language=source_language,
        target_language=target_language,
        voice_mode=voice_mode,
        text_transform=text_transform,
        text_transform_options=options,
        voice_settings={
            "seed_vc": create_seed_vc_settings(
                diffusion_steps=seed_vc_diffusion_steps,
                length_adjust=seed_vc_length_adjust,
                inference_cfg_rate=seed_vc_inference_cfg_rate,
                reference_max_seconds=seed_vc_reference_max_seconds,
                reference_auto_select=seed_vc_reference_auto_select,
            )
        },
    )


def _parse_text_transform_options(raw_options: str | None) -> dict[str, object]:
    if raw_options is None or raw_options.strip() == "":
        return {}
    try:
        parsed = json.loads(raw_options)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="text_transform_options must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="text_transform_options must be a JSON object")
    return parsed
