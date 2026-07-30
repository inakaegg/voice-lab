from __future__ import annotations

from fastapi import HTTPException

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
