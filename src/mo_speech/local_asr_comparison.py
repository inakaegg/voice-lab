from __future__ import annotations

import json
import platform
import subprocess
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping, Sequence

from .local_asr_corpus import (
    CommandRunner,
    _command_version,
    _find_model_snapshot,
    _funasr_model_metadata,
    _model_cache_paths,
    _package_version,
    _required_executable,
    _run_command,
    _sha256,
    _synthesize_case,
    _temporary_environment,
    _wav_duration,
    _write_json,
    build_synthesis_plan,
)
from .practice import normalize_practice_text, practice_comparison_alignment_canonical


SUPPORTED_PLAYBACK_MODES = {"phrase", "partial_phrase", "whole"}
COMPARISON_GENERATION_REVISION = 5


def _generation_run_metadata(
    existing: Mapping[str, object],
    *,
    preserve_existing: bool,
    say_path: str,
    ffmpeg_path: str,
) -> dict[str, object]:
    if preserve_existing:
        generated_at = existing.get("generated_at")
        generator = existing.get("generator")
        if isinstance(generated_at, str) and isinstance(generator, Mapping):
            return {
                "generated_at": generated_at,
                "generator": dict(generator),
            }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "say": say_path,
            "ffmpeg": _command_version([ffmpeg_path, "-version"]),
            "praat_parselmouth": _package_version("praat-parselmouth"),
        },
    }


def comparison_provider_name(language: str) -> str:
    if language == "zh-CN":
        return "funasr"
    if language == "en-US":
        return "faster_whisper"
    raise ValueError(f"unsupported comparison language: {language}")


def select_comparison_cases(
    manifest: Mapping[str, object],
    case_limit: int | None,
) -> list[Mapping[str, object]]:
    raw_cases = manifest.get("cases")
    if not isinstance(raw_cases, list):
        raise ValueError("comparison manifest cases must be a list")
    cases = [case for case in raw_cases if isinstance(case, Mapping)]
    if case_limit is None:
        return cases
    if case_limit < 1 or case_limit > len(cases):
        raise ValueError(f"case_limit must be between 1 and {len(cases)}")
    return cases[:case_limit]


def load_comparison_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid comparison manifest JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError("comparison manifest must be an object")
    if payload.get("schema_version") != 1:
        raise ValueError("unsupported comparison manifest schema_version")
    policy = payload.get("evaluation_policy")
    if not isinstance(policy, Mapping):
        raise ValueError("comparison manifest evaluation_policy must be an object")
    minimum_range_iou = _bounded_float(
        policy.get("minimum_range_iou"),
        0.0,
        1.0,
        "minimum_range_iou",
        "evaluation_policy",
    )
    policy["minimum_range_iou"] = minimum_range_iou

    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("comparison manifest cases must be a non-empty list")
    seen_ids: set[str] = set()
    for case_index, raw_case in enumerate(cases):
        if not isinstance(raw_case, Mapping):
            raise ValueError(f"comparison case {case_index} must be an object")
        case_id = _required_text(raw_case, "id", f"case {case_index}")
        if case_id in seen_ids:
            raise ValueError(f"duplicate comparison case id: {case_id}")
        seen_ids.add(case_id)
        language = _required_text(raw_case, "language", case_id)
        if language not in {"zh-CN", "en-US"}:
            raise ValueError(f"unsupported comparison language for {case_id}: {language}")
        _required_text(raw_case, "category", case_id)
        phrases = raw_case.get("target_phrases")
        if not isinstance(phrases, list) or not 2 <= len(phrases) <= 4:
            raise ValueError(f"target_phrases must contain 2 to 4 phrases for {case_id}")
        if any(not isinstance(phrase, str) or not phrase.strip() for phrase in phrases):
            raise ValueError(f"target_phrases must contain non-empty text for {case_id}")

        side_indices: dict[str, list[int]] = {}
        for side in ("model", "attempt"):
            raw_side = raw_case.get(side)
            if not isinstance(raw_side, Mapping):
                raise ValueError(f"{side} must be an object for {case_id}")
            build_synthesis_plan({"id": f"{case_id}-{side}", "synthesis": raw_side})
            raw_segments = raw_side.get("segments")
            assert isinstance(raw_segments, list)
            indices = [
                _phrase_index(segment, phrase_count=len(phrases), case_id=case_id, side=side)
                for segment in raw_segments
            ]
            if indices != sorted(set(indices)):
                raise ValueError(
                    f"{side} phrase_index values must be unique and increasing for {case_id}"
                )
            side_indices[side] = indices
        if side_indices["model"] != list(range(len(phrases))):
            raise ValueError(f"model must cover every target phrase for {case_id}")

        expected = raw_case.get("expected")
        if not isinstance(expected, Mapping):
            raise ValueError(f"expected must be an object for {case_id}")
        model_expected = _index_list(
            expected.get("model_available_phrase_indices"),
            phrase_count=len(phrases),
            field="model_available_phrase_indices",
            case_id=case_id,
        )
        attempt_expected = _index_list(
            expected.get("attempt_available_phrase_indices"),
            phrase_count=len(phrases),
            field="attempt_available_phrase_indices",
            case_id=case_id,
        )
        paired_expected = _index_list(
            expected.get("paired_phrase_indices"),
            phrase_count=len(phrases),
            field="paired_phrase_indices",
            case_id=case_id,
        )
        if model_expected != side_indices["model"]:
            raise ValueError(f"model expected indices do not match generated segments for {case_id}")
        if attempt_expected != side_indices["attempt"]:
            raise ValueError(f"attempt expected indices do not match generated segments for {case_id}")
        if paired_expected != sorted(set(model_expected) & set(attempt_expected)):
            raise ValueError(f"paired expected indices are inconsistent for {case_id}")
        playback_mode = str(expected.get("playback_mode") or "")
        if playback_mode not in SUPPORTED_PLAYBACK_MODES:
            raise ValueError(f"unsupported playback_mode for {case_id}: {playback_mode}")
    return payload


def compute_phrase_ranges(
    segments: Sequence[Mapping[str, object]],
    segment_durations: Sequence[float],
    *,
    segment_speech_bounds: Sequence[tuple[float, float]] | None = None,
    tempo: float = 1.0,
) -> list[dict[str, object]]:
    if len(segments) != len(segment_durations):
        raise ValueError("segments and segment_durations must have the same length")
    if segment_speech_bounds is not None and len(segments) != len(segment_speech_bounds):
        raise ValueError("segments and segment_speech_bounds must have the same length")
    if tempo <= 0:
        raise ValueError("tempo must be positive")
    cursor = 0.0
    ranges: list[dict[str, object]] = []
    for segment_index, (segment, raw_duration) in enumerate(
        zip(segments, segment_durations, strict=True)
    ):
        phrase_index = int(segment["phrase_index"])
        duration = float(raw_duration)
        if duration <= 0:
            raise ValueError("segment duration must be positive")
        speech_start, speech_end = (
            segment_speech_bounds[segment_index]
            if segment_speech_bounds is not None
            else (0.0, duration)
        )
        if not 0 <= speech_start < speech_end <= duration:
            raise ValueError("segment speech bounds must be within the segment duration")
        start = (cursor + speech_start) / tempo
        end = (cursor + speech_end) / tempo
        ranges.append(
            {
                "index": phrase_index,
                "audio_start": round(start, 6),
                "audio_end": round(end, 6),
            }
        )
        cursor += duration + (int(segment.get("pause_after_ms") or 0) / 1000)
    return ranges


def _speech_bounds_from_silences(
    duration: float,
    silence_intervals: Sequence[Mapping[str, float]],
) -> tuple[float, float]:
    start = 0.0
    end = float(duration)
    ordered = sorted(
        (
            (
                max(0.0, float(interval["start"])),
                min(end, float(interval["end"])),
            )
            for interval in silence_intervals
            if float(interval.get("end", 0.0)) > float(interval.get("start", 0.0))
        ),
        key=lambda interval: interval[0],
    )
    if ordered and ordered[0][0] <= 0.05:
        start = ordered[0][1]
    if ordered and ordered[-1][1] >= end - 0.05:
        end = ordered[-1][0]
    if end <= start:
        return 0.0, float(duration)
    return round(start, 6), round(end, 6)


def _target_phrase_speech_bounds(
    *,
    segment_text: str,
    target_text: str,
    target_language: str,
    duration: float,
    silence_intervals: Sequence[Mapping[str, float]],
    outer_bounds: tuple[float, float],
) -> tuple[float, float]:
    spoken = normalize_practice_text(segment_text, target_language)
    target = normalize_practice_text(target_text, target_language)
    start, end = outer_bounds
    if not spoken or not target or spoken == target:
        return outer_bounds
    internal = [
        interval
        for interval in silence_intervals
        if float(interval.get("end", 0.0)) > float(interval.get("start", 0.0))
        and float(interval.get("start", 0.0)) > start + 0.05
        and float(interval.get("end", 0.0)) < end - 0.05
    ]
    if not internal:
        return outer_bounds
    if spoken.endswith(target):
        prefix_length = len(spoken) - len(target)
        if prefix_length:
            expected_ratio = prefix_length / len(spoken)
            boundary = min(
                internal,
                key=lambda interval: abs(
                    (
                        (
                            float(interval["start"])
                            + float(interval["end"])
                        )
                        / 2
                    )
                    / duration
                    - expected_ratio
                ),
            )
            start = max(start, float(boundary["end"]))
    if spoken.startswith(target):
        suffix_length = len(spoken) - len(target)
        if suffix_length:
            expected_ratio = len(target) / len(spoken)
            boundary = min(
                internal,
                key=lambda interval: abs(
                    (
                        (
                            float(interval["start"])
                            + float(interval["end"])
                        )
                        / 2
                    )
                    / duration
                    - expected_ratio
                ),
            )
            end = min(end, float(boundary["start"]))
    if end <= start:
        return outer_bounds
    return round(start, 6), round(end, 6)


def generate_comparison_pairs(
    manifest_path: Path,
    output_dir: Path,
    *,
    case_limit: int | None = None,
    command_runner: CommandRunner | None = None,
) -> dict[str, object]:
    manifest = load_comparison_manifest(manifest_path)
    selected_cases = select_comparison_cases(manifest, case_limit)
    runner = command_runner or _run_command
    say_path = _required_executable("say")
    ffmpeg_path = _required_executable("ffmpeg")
    raw_dir = output_dir / "raw"
    audio_dir = output_dir / "audio"
    raw_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    existing_generation: Mapping[str, object] = {}
    existing_by_id: dict[str, Mapping[str, object]] = {}
    existing_path = output_dir / "generation.json"
    if existing_path.is_file():
        try:
            existing = json.loads(existing_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
        if (
            isinstance(existing, Mapping)
            and existing.get("manifest_sha256") == _sha256(manifest_path)
        ):
            existing_generation = existing
            existing_by_id = {
                str(case["id"]): case
                for case in existing.get("cases", [])
                if isinstance(case, Mapping) and case.get("id")
            }

    exact_existing_selection = [
        str(case.get("id"))
        for case in existing_generation.get("cases", [])
        if isinstance(case, Mapping)
    ] == [str(case["id"]) for case in selected_cases]
    regenerated_any_audio = False
    generated_cases: list[dict[str, object]] = []
    for raw_case in selected_cases:
        case = dict(raw_case)
        existing_case = existing_by_id.get(str(case["id"]))
        case_audio_is_reusable = (
            existing_case is not None
            and _generated_case_audio_is_reusable(existing_case, output_dir)
        )
        generated_case: dict[str, object] = {
            "id": case["id"],
            "language": case["language"],
            "category": case["category"],
            "target_phrases": case["target_phrases"],
            "target_text": _target_text(case["target_phrases"], str(case["language"])),
        }
        for side in ("model", "attempt"):
            raw_side = case[side]
            assert isinstance(raw_side, Mapping)
            plan = build_synthesis_plan(
                {"id": f"{case['id']}-{side}", "synthesis": raw_side}
            )
            synthesis_id = f"{case['id']}-{side}"
            audio_path = audio_dir / f"{synthesis_id}.wav"
            segment_paths = [
                raw_dir
                / (
                    f"{synthesis_id}-{index:02d}-pitch.wav"
                    if plan.segments[index].pitch_contour
                    else f"{synthesis_id}-{index:02d}.wav"
                )
                for index in range(len(plan.segments))
            ]
            if not (
                case_audio_is_reusable
                and audio_path.is_file()
                and all(path.is_file() for path in segment_paths)
            ):
                regenerated_any_audio = True
                _synthesize_case(
                    case_id=synthesis_id,
                    plan=plan,
                    raw_dir=raw_dir,
                    audio_path=audio_path,
                    say_path=say_path,
                    ffmpeg_path=ffmpeg_path,
                    runner=runner,
                )
            raw_segments = raw_side["segments"]
            assert isinstance(raw_segments, list)
            segment_durations = [
                _wav_duration(path)
                for path in segment_paths
            ]
            from .providers.funasr import detect_audio_silence_intervals

            segment_speech_bounds = []
            segment_full_speech_bounds = []
            for index, duration in enumerate(segment_durations):
                segment_path = segment_paths[index]
                detected_duration, silence_intervals = detect_audio_silence_intervals(
                    segment_path
                )
                effective_duration = min(duration, detected_duration)
                outer_bounds = _speech_bounds_from_silences(
                    effective_duration,
                    silence_intervals,
                )
                segment_full_speech_bounds.append(outer_bounds)
                phrase_index = int(raw_segments[index]["phrase_index"])
                segment_speech_bounds.append(
                    _target_phrase_speech_bounds(
                        segment_text=str(raw_segments[index]["text"]),
                        target_text=str(case["target_phrases"][phrase_index]),
                        target_language=str(case["language"]),
                        duration=effective_duration,
                        silence_intervals=silence_intervals,
                        outer_bounds=outer_bounds,
                    )
                )
            phrase_ranges = compute_phrase_ranges(
                raw_segments,
                segment_durations,
                segment_speech_bounds=segment_speech_bounds,
                tempo=plan.tempo,
            )
            full_phrase_ranges = compute_phrase_ranges(
                raw_segments,
                segment_durations,
                segment_speech_bounds=segment_full_speech_bounds,
                tempo=plan.tempo,
            )
            for phrase_range, full_phrase_range in zip(
                phrase_ranges,
                full_phrase_ranges,
                strict=True,
            ):
                if (
                    phrase_range["audio_start"] != full_phrase_range["audio_start"]
                    or phrase_range["audio_end"] != full_phrase_range["audio_end"]
                ):
                    phrase_range["acceptable_audio_ranges"] = [
                        {
                            "audio_start": full_phrase_range["audio_start"],
                            "audio_end": full_phrase_range["audio_end"],
                        }
                    ]
            generated_case[side] = {
                "audio_path": str(audio_path.relative_to(output_dir)),
                "audio_sha256": _sha256(audio_path),
                "duration_seconds": _wav_duration(audio_path),
                "phrase_ranges": phrase_ranges,
                "synthesis": {
                    **asdict(plan),
                    "segments": raw_segments,
                },
            }
        generated_cases.append(generated_case)

    run_metadata = _generation_run_metadata(
        existing_generation,
        preserve_existing=exact_existing_selection and not regenerated_any_audio,
        say_path=say_path,
        ffmpeg_path=ffmpeg_path,
    )
    result: dict[str, object] = {
        "schema_version": 1,
        "generation_revision": COMPARISON_GENERATION_REVISION,
        "generated_at": run_metadata["generated_at"],
        "manifest_path": str(manifest_path),
        "manifest_sha256": _sha256(manifest_path),
        "case_limit": len(selected_cases),
        "generator": run_metadata["generator"],
        "cases": generated_cases,
    }
    _write_json(output_dir / "generation.json", result)
    return result


def evaluate_comparison_pairs(
    manifest_path: Path,
    output_dir: Path,
    *,
    model_cache_dir: Path,
    whisper_model: str = "turbo",
    case_limit: int | None = None,
    project_root: Path | None = None,
) -> dict[str, object]:
    manifest = load_comparison_manifest(manifest_path)
    selected_cases = select_comparison_cases(manifest, case_limit)
    generation_path = output_dir / "generation.json"
    generation = json.loads(generation_path.read_text(encoding="utf-8"))
    if generation.get("manifest_sha256") != _sha256(manifest_path):
        raise ValueError("comparison generation manifest hash does not match current manifest")
    generated_by_id = {
        str(case["id"]): case
        for case in generation.get("cases", [])
        if isinstance(case, dict) and case.get("id")
    }
    missing = [
        str(case["id"])
        for case in selected_cases
        if str(case["id"]) not in generated_by_id
    ]
    if missing:
        raise ValueError(f"generated comparison audio is missing: {', '.join(missing)}")

    cache_paths = _model_cache_paths(model_cache_dir)
    for path in cache_paths.values():
        path.mkdir(parents=True, exist_ok=True)
    environment = {
        "HF_HOME": str(cache_paths["huggingface"]),
        "HF_HUB_CACHE": str(cache_paths["huggingface_hub"]),
        "HUGGINGFACE_HUB_CACHE": str(cache_paths["huggingface_hub"]),
        "MODELSCOPE_CACHE": str(cache_paths["modelscope"]),
    }
    minimum_range_iou = float(manifest["evaluation_policy"]["minimum_range_iou"])
    rows: list[dict[str, object]] = []
    languages = {str(case["language"]) for case in selected_cases}
    with _temporary_environment(environment):
        from .providers.funasr import FunAsrPracticeProvider
        from .providers.local import FasterWhisperAsrProvider

        whisper = (
            FasterWhisperAsrProvider(
                model_name=whisper_model,
                cache_dir=cache_paths["faster_whisper"],
                device="cpu",
                compute_type="int8",
                local_files_only=False,
            )
            if "en-US" in languages
            else None
        )
        funasr = FunAsrPracticeProvider(device="cpu", hub="hf") if "zh-CN" in languages else None
        try:
            for raw_case in selected_cases:
                case = dict(raw_case)
                generated = generated_by_id[str(case["id"])]
                provider_rows: dict[str, object] = {}
                provider_name = comparison_provider_name(str(case["language"]))
                provider = funasr if provider_name == "funasr" else whisper
                assert provider is not None
                provider_rows[provider_name] = _evaluate_provider_pair(
                        case,
                        generated,
                        output_dir,
                        provider,
                        provider_name=provider_name,
                        minimum_range_iou=minimum_range_iou,
                        project_root=project_root,
                    )
                rows.append(
                    {
                        "id": case["id"],
                        "language": case["language"],
                        "category": case["category"],
                        "target_phrases": case["target_phrases"],
                        "target_text": generated["target_text"],
                        "expected": case["expected"],
                        "model": generated["model"],
                        "attempt": generated["attempt"],
                        "providers": provider_rows,
                    }
                )
        finally:
            if whisper is not None:
                whisper.release()
            if funasr is not None:
                funasr.release()

    model_metadata: dict[str, object] = {}
    if "en-US" in languages:
        model_metadata["faster_whisper"] = {
            "model": whisper_model,
            "device": "cpu",
            "compute_type": "int8",
            "snapshot": _find_model_snapshot(cache_paths["faster_whisper"]),
        }
    if "zh-CN" in languages:
        assert funasr is not None
        model_metadata["funasr"] = _funasr_model_metadata(
            funasr,
            cache_paths["huggingface_hub"],
        )
    result: dict[str, object] = {
        "schema_version": 1,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "manifest_sha256": _sha256(manifest_path),
        "generation_sha256": _sha256(generation_path),
        "case_limit": len(selected_cases),
        "model_cache_dir": str(model_cache_dir),
        "minimum_range_iou": minimum_range_iou,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "packages": {
                "faster-whisper": _package_version("faster-whisper"),
                "ctranslate2": _package_version("ctranslate2"),
                "funasr": _package_version("funasr"),
                "torch": _package_version("torch"),
            },
        },
        "models": model_metadata,
        "cases": rows,
        "summary": _comparison_summary(rows),
    }
    _write_json(output_dir / "comparison-results.json", result)
    (output_dir / "report.md").write_text(
        render_comparison_report(result),
        encoding="utf-8",
    )
    return result


def score_comparison_result(
    case: Mapping[str, object],
    generated: Mapping[str, object],
    model_alignment: Mapping[str, object],
    attempt_alignment: Mapping[str, object],
    playback_plan: Mapping[str, object],
    *,
    minimum_range_iou: float,
) -> dict[str, object]:
    expected = case.get("expected")
    if not isinstance(expected, Mapping):
        raise ValueError("comparison case expected must be an object")
    expected_model = [int(value) for value in expected["model_available_phrase_indices"]]  # type: ignore[index]
    expected_attempt = [int(value) for value in expected["attempt_available_phrase_indices"]]  # type: ignore[index]
    expected_paired = [int(value) for value in expected["paired_phrase_indices"]]  # type: ignore[index]
    actual_model = _available_indices(model_alignment)
    actual_attempt = _available_indices(attempt_alignment)
    actual_paired = [
        int(row["index"])
        for row in playback_plan.get("ranges", [])  # type: ignore[union-attr]
        if isinstance(row, Mapping) and row.get("index") is not None
    ]
    model_iou = _minimum_range_iou(
        _phrase_ranges(generated, "model"),
        model_alignment,
        expected_model,
    )
    attempt_iou = _minimum_range_iou(
        _phrase_ranges(generated, "attempt"),
        attempt_alignment,
        expected_attempt,
    )
    model_ranges_safe = _ranges_exclude_other_phrase_speech(
        _phrase_ranges(generated, "model"),
        model_alignment,
        expected_model,
    )
    attempt_ranges_safe = _ranges_exclude_other_phrase_speech(
        _phrase_ranges(generated, "attempt"),
        attempt_alignment,
        expected_attempt,
    )
    checks = {
        "model_available_phrase_indices_exact": actual_model == expected_model,
        "attempt_available_phrase_indices_exact": actual_attempt == expected_attempt,
        "paired_phrase_indices_exact": actual_paired == expected_paired,
        "playback_mode_exact": playback_plan.get("mode") == expected.get("playback_mode"),
        "model_ranges_meet_iou": model_iou >= minimum_range_iou,
        "attempt_ranges_meet_iou": attempt_iou >= minimum_range_iou,
        "model_ranges_exclude_other_phrase_speech": model_ranges_safe,
        "attempt_ranges_exclude_other_phrase_speech": attempt_ranges_safe,
    }
    return {
        "passed": all(checks.values()),
        **checks,
        "actual_model_available_phrase_indices": actual_model,
        "actual_attempt_available_phrase_indices": actual_attempt,
        "actual_paired_phrase_indices": actual_paired,
        "actual_playback_mode": playback_plan.get("mode"),
        "minimum_model_range_iou": round(model_iou, 3),
        "minimum_attempt_range_iou": round(attempt_iou, 3),
    }


def run_playback_plan(
    options: Mapping[str, object],
    *,
    project_root: Path | None = None,
) -> dict[str, object]:
    root = project_root or Path(__file__).resolve().parents[2]
    runner = root / "scripts" / "local_asr_comparison_playback.mjs"
    completed = subprocess.run(
        ["node", str(runner)],
        input=json.dumps(options, ensure_ascii=False),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"comparison playback runner failed: {detail}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("comparison playback runner returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("comparison playback runner must return an object")
    return payload


def render_comparison_report(result: Mapping[str, object]) -> str:
    lines = [
        "# ローカルASR比較再生 paired pilot結果",
        "",
        "| provider | cases | passed | failed |",
        "| --- | ---: | ---: | ---: |",
    ]
    summary = result.get("summary")
    if isinstance(summary, Mapping):
        for provider, raw_metrics in summary.items():
            metrics = raw_metrics if isinstance(raw_metrics, Mapping) else {}
            lines.append(
                "| "
                + " | ".join(
                    [
                        _markdown_cell(provider),
                        _markdown_cell(metrics.get("case_count")),
                        _markdown_cell(metrics.get("passed")),
                        _markdown_cell(metrics.get("failed")),
                    ]
                )
                + " |"
            )
    lines.extend(
        [
            "",
            "## Cases",
            "",
            "| case | provider | pass | expected mode | actual mode | expected paired | actual paired | model min IoU | attempt min IoU | attempt ASR |",
            "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |",
        ]
    )
    cases = result.get("cases")
    if isinstance(cases, list):
        for raw_case in cases:
            if not isinstance(raw_case, Mapping):
                continue
            expected = raw_case.get("expected")
            expected = expected if isinstance(expected, Mapping) else {}
            providers = raw_case.get("providers")
            if not isinstance(providers, Mapping):
                continue
            for provider, raw_provider in providers.items():
                provider_result = raw_provider if isinstance(raw_provider, Mapping) else {}
                score = provider_result.get("score")
                score = score if isinstance(score, Mapping) else {}
                attempt_transcription = provider_result.get("attempt_transcription")
                attempt_transcription = (
                    attempt_transcription
                    if isinstance(attempt_transcription, Mapping)
                    else {}
                )
                lines.append(
                    "| "
                    + " | ".join(
                        [
                            _markdown_cell(raw_case.get("id")),
                            _markdown_cell(provider),
                            "yes" if score.get("passed") is True else "no",
                            _markdown_cell(expected.get("playback_mode")),
                            _markdown_cell(score.get("actual_playback_mode")),
                            _markdown_cell(expected.get("paired_phrase_indices")),
                            _markdown_cell(score.get("actual_paired_phrase_indices")),
                            _markdown_cell(score.get("minimum_model_range_iou")),
                            _markdown_cell(score.get("minimum_attempt_range_iou")),
                            _markdown_cell(attempt_transcription.get("text")),
                        ]
                    )
                    + " |"
                )
    return "\n".join(lines) + "\n"


def _evaluate_provider_pair(
    case: Mapping[str, object],
    generated: Mapping[str, object],
    output_dir: Path,
    provider: object,
    *,
    provider_name: str,
    minimum_range_iou: float,
    project_root: Path | None,
) -> dict[str, object]:
    model_data = generated.get("model")
    attempt_data = generated.get("attempt")
    if not isinstance(model_data, Mapping) or not isinstance(attempt_data, Mapping):
        raise ValueError(f"generated pair is incomplete for {case.get('id')}")
    language = str(case["language"])
    target_text = str(generated["target_text"])
    model_transcription = _transcribe_provider(
        provider,
        output_dir / str(model_data["audio_path"]),
        language,
        target_text=target_text,
    )
    attempt_transcription = _transcribe_provider(
        provider,
        output_dir / str(attempt_data["audio_path"]),
        language,
        target_text=target_text,
    )
    model_alignment = practice_comparison_alignment_canonical(
        target_text=target_text,
        recognized_text=str(model_transcription["text"]),
        target_language=language,
        asr_timestamps=_timestamp_payload(model_transcription),
    )
    attempt_alignment = practice_comparison_alignment_canonical(
        target_text=target_text,
        recognized_text=str(attempt_transcription["text"]),
        target_language=language,
        asr_timestamps=_timestamp_payload(attempt_transcription),
    )
    playback_plan = run_playback_plan(
        {
            "modelReady": True,
            "repeatReady": True,
            "resultVisible": True,
            "outcome": "evaluated",
            "recognizedLanguageMatches": True,
            "attemptAlignment": attempt_alignment,
            "modelAlignment": model_alignment,
            "modelDuration": model_data["duration_seconds"],
            "repeatDuration": attempt_data["duration_seconds"],
        },
        project_root=project_root,
    )
    score = score_comparison_result(
        case,
        generated,
        model_alignment,
        attempt_alignment,
        playback_plan,
        minimum_range_iou=minimum_range_iou,
    )
    return {
        "provider": provider_name,
        "model_transcription": model_transcription,
        "attempt_transcription": attempt_transcription,
        "model_alignment": model_alignment,
        "attempt_alignment": attempt_alignment,
        "playback_plan": playback_plan,
        "score": score,
    }


def _transcribe_provider(
    provider: object,
    audio_path: Path,
    language: str,
    *,
    target_text: str,
) -> dict[str, object]:
    started = perf_counter()
    transcription = provider.transcribe_detail(  # type: ignore[attr-defined]
        audio_path,
        language,
        include_timestamps=True,
    )
    refine = getattr(provider, "refine_timestamps_for_target", None)
    if callable(refine):
        transcription = refine(
            transcription,
            audio_path,
            target_text=target_text,
            target_language=language,
        )
    return {
        "model": str(getattr(transcription, "model", "") or ""),
        "text": str(getattr(transcription, "text", "") or ""),
        "words": list(getattr(transcription, "words", []) or []),
        "segments": list(getattr(transcription, "segments", []) or []),
        "timestamp_granularities": list(
            getattr(transcription, "timestamp_granularities", []) or []
        ),
        "elapsed_ms": round((perf_counter() - started) * 1000, 3),
    }


def _timestamp_payload(transcription: Mapping[str, object]) -> dict[str, object]:
    words = transcription.get("words")
    segments = transcription.get("segments")
    safe_words = words if isinstance(words, list) else []
    safe_segments = segments if isinstance(segments, list) else []
    granularities = transcription.get("timestamp_granularities")
    return {
        "available": bool(safe_words or safe_segments),
        "model": transcription.get("model"),
        "timestamp_granularities": granularities if isinstance(granularities, list) else [],
        "words": safe_words,
        "segments": safe_segments,
        "raw_timestamp_word_count": len(safe_words),
        "raw_timestamp_segment_count": len(safe_segments),
    }


def _comparison_summary(rows: Sequence[Mapping[str, object]]) -> dict[str, object]:
    by_provider: dict[str, list[Mapping[str, object]]] = {}
    for row in rows:
        providers = row.get("providers")
        if not isinstance(providers, Mapping):
            continue
        for provider, raw_result in providers.items():
            if not isinstance(raw_result, Mapping):
                continue
            score = raw_result.get("score")
            if isinstance(score, Mapping):
                by_provider.setdefault(str(provider), []).append(score)
    return {
        provider: {
            "case_count": len(scores),
            "passed": sum(score.get("passed") is True for score in scores),
            "failed": sum(score.get("passed") is not True for score in scores),
        }
        for provider, scores in by_provider.items()
    }


def _target_text(phrases: object, language: str) -> str:
    if not isinstance(phrases, list):
        raise ValueError("target_phrases must be a list")
    separator = " " if language == "en-US" else ""
    return separator.join(str(phrase).strip() for phrase in phrases)


def _generated_case_audio_is_reusable(
    generated_case: Mapping[str, object],
    output_dir: Path,
) -> bool:
    for side in ("model", "attempt"):
        raw_side = generated_case.get(side)
        if not isinstance(raw_side, Mapping):
            return False
        audio_path = output_dir / str(raw_side.get("audio_path") or "")
        expected_sha = str(raw_side.get("audio_sha256") or "")
        if not audio_path.is_file() or not expected_sha or _sha256(audio_path) != expected_sha:
            return False
    return True


def _available_indices(alignment: Mapping[str, object]) -> list[int]:
    phrases = alignment.get("phrases")
    if not isinstance(phrases, list):
        return []
    return [
        int(phrase["index"])
        for phrase in phrases
        if isinstance(phrase, Mapping)
        and phrase.get("available") is True
        and phrase.get("index") is not None
    ]


def _phrase_ranges(generated: Mapping[str, object], side: str) -> list[Mapping[str, object]]:
    raw_side = generated.get(side)
    if not isinstance(raw_side, Mapping):
        raise ValueError(f"generated {side} data is missing")
    ranges = raw_side.get("phrase_ranges")
    if not isinstance(ranges, list):
        raise ValueError(f"generated {side} phrase_ranges are missing")
    return [row for row in ranges if isinstance(row, Mapping)]


def _minimum_range_iou(
    expected_ranges: Sequence[Mapping[str, object]],
    alignment: Mapping[str, object],
    expected_indices: Sequence[int],
) -> float:
    if not expected_indices:
        return 1.0
    expected_by_index = {int(row["index"]): row for row in expected_ranges}
    actual_phrases = alignment.get("phrases")
    actual_by_index = {
        int(row["index"]): row
        for row in actual_phrases
        if isinstance(row, Mapping) and row.get("index") is not None
    } if isinstance(actual_phrases, list) else {}
    values: list[float] = []
    for index in expected_indices:
        expected = expected_by_index.get(index)
        actual = actual_by_index.get(index)
        if expected is None or actual is None or actual.get("available") is not True:
            values.append(0.0)
            continue
        raw_alternatives = expected.get("acceptable_audio_ranges")
        alternatives = (
            [
                option
                for option in raw_alternatives
                if isinstance(option, Mapping)
                and option.get("audio_start") is not None
                and option.get("audio_end") is not None
            ]
            if isinstance(raw_alternatives, list)
            else []
        )
        values.append(
            max(
                _range_iou(
                    float(option["audio_start"]),
                    float(option["audio_end"]),
                    float(actual["audio_start"]),
                    float(actual["audio_end"]),
                )
                for option in [expected, *alternatives]
            )
        )
    return min(values, default=0.0)


def _ranges_exclude_other_phrase_speech(
    expected_ranges: Sequence[Mapping[str, object]],
    alignment: Mapping[str, object],
    expected_indices: Sequence[int],
    *,
    tolerance_seconds: float = 0.02,
) -> bool:
    expected_by_index = {int(row["index"]): row for row in expected_ranges}
    actual_phrases = alignment.get("phrases")
    actual_by_index = {
        int(row["index"]): row
        for row in actual_phrases
        if isinstance(row, Mapping) and row.get("index") is not None
    } if isinstance(actual_phrases, list) else {}
    for index in expected_indices:
        actual = actual_by_index.get(index)
        if actual is None or actual.get("available") is not True:
            continue
        actual_start = float(actual["audio_start"])
        actual_end = float(actual["audio_end"])
        for other_index, other in expected_by_index.items():
            if other_index == index:
                continue
            overlap = max(
                0.0,
                min(actual_end, float(other["audio_end"]))
                - max(actual_start, float(other["audio_start"])),
            )
            if overlap > tolerance_seconds:
                return False
    return True


def _range_iou(expected_start: float, expected_end: float, actual_start: float, actual_end: float) -> float:
    intersection = max(0.0, min(expected_end, actual_end) - max(expected_start, actual_start))
    union = max(expected_end, actual_end) - min(expected_start, actual_start)
    return intersection / union if union > 0 else 0.0


def _markdown_cell(value: object) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _phrase_index(
    segment: object,
    *,
    phrase_count: int,
    case_id: str,
    side: str,
) -> int:
    if not isinstance(segment, Mapping):
        raise ValueError(f"{side} segment must be an object for {case_id}")
    value = segment.get("phrase_index")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{side} phrase_index must be an integer for {case_id}")
    if value < 0 or value >= phrase_count:
        raise ValueError(f"{side} phrase_index is out of range for {case_id}: {value}")
    return value


def _index_list(value: object, *, phrase_count: int, field: str, case_id: str) -> list[int]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list for {case_id}")
    indices: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int):
            raise ValueError(f"{field} must contain integers for {case_id}")
        if item < 0 or item >= phrase_count:
            raise ValueError(f"{field} contains an out-of-range index for {case_id}: {item}")
        indices.append(item)
    if indices != sorted(set(indices)):
        raise ValueError(f"{field} must be unique and increasing for {case_id}")
    return indices


def _required_text(value: Mapping[str, object], field: str, context: str) -> str:
    text = str(value.get(field) or "").strip()
    if not text:
        raise ValueError(f"{field} is required for {context}")
    return text


def _bounded_float(
    value: object,
    minimum: float,
    maximum: float,
    field: str,
    context: str,
) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number for {context}")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number for {context}") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} is out of range for {context}: {parsed}")
    return parsed
