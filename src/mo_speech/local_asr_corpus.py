from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import wave
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from time import perf_counter
from typing import Any, Callable, Iterator, Mapping, Sequence

from .practice import normalize_practice_text, practice_similarity


SUPPORTED_LANGUAGES = {"zh-CN", "en-US"}
SUPPORTED_SOURCE_KINDS = {
    "apple_tts_native",
    "apple_tts_text_substitution",
    "apple_tts_pitch_manipulated",
    "apple_tts_cross_language_phonetic",
    "apple_tts_acoustic_variant",
}
SUPPORTED_FIDELITIES = {
    "native_synthetic",
    "controlled_pronunciation_proxy",
    "controlled_acoustic_proxy",
    "experimental_accent_proxy",
}
SUPPORTED_PITCH_CONTOURS = {"flat", "rising", "falling", "dip", "high_flat", "low_flat"}
PITCH_CONTOUR_FACTORS: dict[str, tuple[float, ...]] = {
    "flat": (1.0, 1.0),
    "rising": (0.82, 1.18),
    "falling": (1.18, 0.82),
    "dip": (1.05, 0.78, 1.05),
    "high_flat": (1.18, 1.18),
    "low_flat": (0.82, 0.82),
}


@dataclass(frozen=True)
class SynthesisSegment:
    text: str
    pause_after_ms: int = 0
    pitch_contour: str | None = None


@dataclass(frozen=True)
class SynthesisPlan:
    voice: str
    rate_wpm: int
    segments: tuple[SynthesisSegment, ...]
    tempo: float = 1.0
    noise_amplitude: float = 0.0
    volume_db: float = 0.0
    lowpass_hz: int | None = None
    echo_delay_ms: int = 0
    echo_decay: float = 0.0


CommandRunner = Callable[[Sequence[str]], None]


def load_corpus_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid corpus manifest JSON: {path}") from exc

    if not isinstance(payload, dict):
        raise ValueError("corpus manifest must be an object")
    if payload.get("schema_version") != 1:
        raise ValueError("unsupported corpus manifest schema_version")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("corpus manifest cases must be a non-empty list")

    seen_ids: set[str] = set()
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise ValueError(f"case {index} must be an object")
        case_id = _required_text(case, "id", index=index)
        if case_id in seen_ids:
            raise ValueError(f"duplicate case id: {case_id}")
        seen_ids.add(case_id)

        language = _required_text(case, "language", index=index)
        if language not in SUPPORTED_LANGUAGES:
            raise ValueError(f"unsupported language for {case_id}: {language}")
        source_kind = _required_text(case, "source_kind", index=index)
        if source_kind not in SUPPORTED_SOURCE_KINDS:
            raise ValueError(f"unsupported source_kind for {case_id}: {source_kind}")
        fidelity = _required_text(case, "fidelity", index=index)
        if fidelity not in SUPPORTED_FIDELITIES:
            raise ValueError(f"unsupported fidelity for {case_id}: {fidelity}")

        _required_text(case, "category", index=index)
        _required_text(case, "target_text", index=index)
        _required_text(case, "expected_spoken_text", index=index)
        build_synthesis_plan(case)

    return payload


def build_synthesis_plan(case: Mapping[str, object]) -> SynthesisPlan:
    case_id = str(case.get("id") or "<unknown>")
    synthesis = case.get("synthesis")
    if not isinstance(synthesis, Mapping):
        raise ValueError(f"synthesis must be an object for {case_id}")

    voice = str(synthesis.get("voice") or "").strip()
    if not voice:
        raise ValueError(f"synthesis voice is required for {case_id}")

    rate_wpm = _bounded_int(synthesis.get("rate_wpm", 180), 80, 350, "rate_wpm", case_id)
    tempo = _bounded_float(synthesis.get("tempo", 1.0), 0.5, 2.0, "tempo", case_id)
    noise_amplitude = _bounded_float(
        synthesis.get("noise_amplitude", 0.0),
        0.0,
        0.2,
        "noise_amplitude",
        case_id,
    )
    volume_db = _bounded_float(
        synthesis.get("volume_db", 0.0),
        -30.0,
        12.0,
        "volume_db",
        case_id,
    )
    lowpass_value = synthesis.get("lowpass_hz")
    lowpass_hz = (
        _bounded_int(lowpass_value, 1_000, 7_500, "lowpass_hz", case_id)
        if lowpass_value is not None
        else None
    )
    echo_delay_ms = _bounded_int(
        synthesis.get("echo_delay_ms", 0),
        0,
        500,
        "echo_delay_ms",
        case_id,
    )
    echo_decay = _bounded_float(
        synthesis.get("echo_decay", 0.0),
        0.0,
        0.9,
        "echo_decay",
        case_id,
    )
    if bool(echo_delay_ms) != bool(echo_decay):
        raise ValueError(
            f"echo_delay_ms and echo_decay must be enabled together for {case_id}"
        )

    segment_rows = synthesis.get("segments")
    if not isinstance(segment_rows, list) or not segment_rows:
        raise ValueError(f"synthesis segments must be a non-empty list for {case_id}")
    segments: list[SynthesisSegment] = []
    for index, row in enumerate(segment_rows):
        if not isinstance(row, Mapping):
            raise ValueError(f"synthesis segment {index} must be an object for {case_id}")
        text = str(row.get("text") or "").strip()
        if not text:
            raise ValueError(f"synthesis segment {index} text is required for {case_id}")
        if not any(character.isalnum() for character in text):
            raise ValueError(
                f"synthesis segment {index} must not be punctuation-only for {case_id}"
            )
        pause_after_ms = _bounded_int(
            row.get("pause_after_ms", 0),
            0,
            3_000,
            "pause_after_ms",
            case_id,
        )
        contour_value = row.get("pitch_contour")
        pitch_contour = str(contour_value).strip() if contour_value is not None else None
        if pitch_contour and pitch_contour not in SUPPORTED_PITCH_CONTOURS:
            raise ValueError(f"unsupported pitch_contour for {case_id}: {pitch_contour}")
        segments.append(
            SynthesisSegment(
                text=text,
                pause_after_ms=pause_after_ms,
                pitch_contour=pitch_contour,
            )
        )

    return SynthesisPlan(
        voice=voice,
        rate_wpm=rate_wpm,
        segments=tuple(segments),
        tempo=tempo,
        noise_amplitude=noise_amplitude,
        volume_db=volume_db,
        lowpass_hz=lowpass_hz,
        echo_delay_ms=echo_delay_ms,
        echo_decay=echo_decay,
    )


def evaluate_transcription(case: Mapping[str, object], transcription: str) -> dict[str, object]:
    language = str(case["language"])
    target_text = str(case["target_text"])
    reference_text = str(case["expected_spoken_text"])
    normalized_transcription = normalize_practice_text(transcription, language)
    normalized_target = normalize_practice_text(target_text, language)
    normalized_reference = normalize_practice_text(reference_text, language)

    reference_similarity = practice_similarity(normalized_reference, normalized_transcription)
    target_similarity = practice_similarity(normalized_target, normalized_transcription)
    expected_textual_error = normalized_reference != normalized_target
    return {
        "normalized_transcription": normalized_transcription,
        "normalized_reference": normalized_reference,
        "normalized_target": normalized_target,
        "reference_similarity": round(reference_similarity, 3),
        "target_similarity": round(target_similarity, 3),
        "error_was_observable": (
            reference_similarity > target_similarity if expected_textual_error else None
        ),
    }


def generate_corpus(
    manifest_path: Path,
    output_dir: Path,
    *,
    command_runner: CommandRunner | None = None,
) -> dict[str, object]:
    manifest = load_corpus_manifest(manifest_path)
    runner = command_runner or _run_command
    say_path = _required_executable("say")
    ffmpeg_path = _required_executable("ffmpeg")
    raw_dir = output_dir / "raw"
    audio_dir = output_dir / "audio"
    raw_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    generated_cases: list[dict[str, object]] = []
    for raw_case in manifest["cases"]:
        case = dict(raw_case)
        plan = build_synthesis_plan(case)
        audio_path = audio_dir / f"{case['id']}.wav"
        _synthesize_case(
            case_id=str(case["id"]),
            plan=plan,
            raw_dir=raw_dir,
            audio_path=audio_path,
            say_path=say_path,
            ffmpeg_path=ffmpeg_path,
            runner=runner,
        )
        generated_cases.append(
            {
                "id": case["id"],
                "language": case["language"],
                "category": case["category"],
                "source_kind": case["source_kind"],
                "fidelity": case["fidelity"],
                "target_text": case["target_text"],
                "expected_spoken_text": case["expected_spoken_text"],
                "audio_path": str(audio_path.relative_to(output_dir)),
                "audio_sha256": _sha256(audio_path),
                "duration_seconds": _wav_duration(audio_path),
                "synthesis": asdict(plan),
            }
        )

    result: dict[str, object] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "manifest_sha256": _sha256(manifest_path),
        "generator": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "say": say_path,
            "ffmpeg": _command_version([ffmpeg_path, "-version"]),
            "praat_parselmouth": _package_version("praat-parselmouth"),
        },
        "cases": generated_cases,
    }
    _write_json(output_dir / "generation.json", result)
    return result


def transcribe_corpus(
    manifest_path: Path,
    output_dir: Path,
    *,
    model_cache_dir: Path,
    whisper_model: str = "turbo",
) -> dict[str, object]:
    manifest = load_corpus_manifest(manifest_path)
    generation_path = output_dir / "generation.json"
    generation = json.loads(generation_path.read_text(encoding="utf-8"))
    manifest_sha256 = _sha256(manifest_path)
    if generation.get("manifest_sha256") != manifest_sha256:
        raise ValueError("generation manifest hash does not match current manifest")
    generated_by_id = {
        str(case["id"]): case
        for case in generation.get("cases", [])
        if isinstance(case, dict) and case.get("id")
    }
    missing = [
        str(case["id"])
        for case in manifest["cases"]
        if str(case["id"]) not in generated_by_id
    ]
    if missing:
        raise ValueError(f"generated audio is missing for cases: {', '.join(missing)}")

    cache_paths = _model_cache_paths(model_cache_dir)
    for path in cache_paths.values():
        path.mkdir(parents=True, exist_ok=True)

    environment = {
        "HF_HOME": str(cache_paths["huggingface"]),
        "HF_HUB_CACHE": str(cache_paths["huggingface_hub"]),
        "HUGGINGFACE_HUB_CACHE": str(cache_paths["huggingface_hub"]),
        "MODELSCOPE_CACHE": str(cache_paths["modelscope"]),
    }
    with _temporary_environment(environment):
        from .providers.funasr import FunAsrPracticeProvider
        from .providers.local import FasterWhisperAsrProvider

        whisper = FasterWhisperAsrProvider(
            model_name=whisper_model,
            cache_dir=cache_paths["faster_whisper"],
            device="cpu",
            compute_type="int8",
            local_files_only=False,
        )
        funasr = FunAsrPracticeProvider(device="cpu", hub="hf")

        rows: list[dict[str, object]] = []
        try:
            for raw_case in manifest["cases"]:
                case = dict(raw_case)
                generated = generated_by_id[str(case["id"])]
                audio_path = output_dir / str(generated["audio_path"])
                provider_results: dict[str, object] = {}
                provider_results["faster_whisper"] = _transcribe_with_provider(
                    whisper,
                    audio_path,
                    str(case["language"]),
                    case,
                )
                if case["language"] == "zh-CN":
                    provider_results["funasr"] = _transcribe_with_provider(
                        funasr,
                        audio_path,
                        "zh-CN",
                        case,
                    )
                rows.append(
                    {
                        **generated,
                        "providers": provider_results,
                    }
                )
        finally:
            whisper.release()
            funasr.release()

    result: dict[str, object] = {
        "schema_version": 1,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "manifest_sha256": manifest_sha256,
        "generation_sha256": _sha256(generation_path),
        "model_cache_dir": str(model_cache_dir),
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
        "models": {
            "faster_whisper": {
                "model": whisper_model,
                "device": "cpu",
                "compute_type": "int8",
                "snapshot": _find_model_snapshot(cache_paths["faster_whisper"]),
            },
            "funasr": _funasr_model_metadata(
                funasr,
                cache_paths["huggingface_hub"],
            ),
        },
        "cases": rows,
        "summary": summarize_results(rows),
    }
    _write_json(output_dir / "transcriptions.json", result)
    (output_dir / "report.md").write_text(render_markdown_report(result), encoding="utf-8")
    return result


def summarize_results(rows: Sequence[Mapping[str, object]]) -> dict[str, object]:
    provider_metrics: dict[str, list[float]] = {}
    observable: dict[str, list[bool]] = {}
    for row in rows:
        providers = row.get("providers")
        if not isinstance(providers, Mapping):
            continue
        for provider, raw_result in providers.items():
            if not isinstance(raw_result, Mapping):
                continue
            metrics = raw_result.get("metrics")
            if not isinstance(metrics, Mapping):
                continue
            provider_metrics.setdefault(str(provider), []).append(
                float(metrics.get("reference_similarity", 0.0))
            )
            observed = metrics.get("error_was_observable")
            if isinstance(observed, bool):
                observable.setdefault(str(provider), []).append(observed)

    return {
        provider: {
            "case_count": len(values),
            "mean_reference_similarity": round(sum(values) / len(values), 3) if values else None,
            "textual_error_case_count": len(observable.get(provider, [])),
            "observable_textual_error_count": sum(observable.get(provider, [])),
        }
        for provider, values in provider_metrics.items()
    }


def render_markdown_report(result: Mapping[str, object]) -> str:
    lines = [
        "# ローカルASR pilot結果",
        "",
        "この表では、合成音声で発話させた `expected spoken` と、練習画面の正解文 `target` を分ける。",
        "",
        "## Provider summary",
        "",
        "| provider | cases | mean reference similarity | textual error cases | observable errors |",
        "| --- | ---: | ---: | ---: | ---: |",
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
                        _markdown_cell(metrics.get("mean_reference_similarity")),
                        _markdown_cell(metrics.get("textual_error_case_count")),
                        _markdown_cell(metrics.get("observable_textual_error_count")),
                    ]
                )
                + " |"
            )

    lines.extend(
        [
            "",
            "## Cases",
            "",
            "| case | category | provider | target | expected spoken | ASR text | reference similarity | target similarity | error observable |",
            "| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |",
        ]
    )
    cases = result.get("cases")
    if isinstance(cases, Sequence) and not isinstance(cases, (str, bytes)):
        for raw_case in cases:
            if not isinstance(raw_case, Mapping):
                continue
            providers = raw_case.get("providers")
            if not isinstance(providers, Mapping):
                continue
            for provider, raw_provider_result in providers.items():
                provider_result = (
                    raw_provider_result if isinstance(raw_provider_result, Mapping) else {}
                )
                raw_metrics = provider_result.get("metrics")
                metrics = raw_metrics if isinstance(raw_metrics, Mapping) else {}
                observed = metrics.get("error_was_observable")
                observed_label = "yes" if observed is True else "no" if observed is False else "n/a"
                lines.append(
                    "| "
                    + " | ".join(
                        [
                            _markdown_cell(raw_case.get("id")),
                            _markdown_cell(raw_case.get("category")),
                            _markdown_cell(provider),
                            _markdown_cell(raw_case.get("target_text")),
                            _markdown_cell(raw_case.get("expected_spoken_text")),
                            _markdown_cell(provider_result.get("text")),
                            _markdown_cell(metrics.get("reference_similarity")),
                            _markdown_cell(metrics.get("target_similarity")),
                            observed_label,
                        ]
                    )
                    + " |"
                )
    return "\n".join(lines) + "\n"


def _transcribe_with_provider(
    provider: object,
    audio_path: Path,
    language: str,
    case: Mapping[str, object],
) -> dict[str, object]:
    started = perf_counter()
    transcription = provider.transcribe_detail(  # type: ignore[attr-defined]
        audio_path,
        language,
        include_timestamps=True,
    )
    elapsed_ms = (perf_counter() - started) * 1000
    text = str(getattr(transcription, "text", "") or "")
    return {
        "model": str(getattr(transcription, "model", "") or ""),
        "text": text,
        "words": list(getattr(transcription, "words", []) or []),
        "segments": list(getattr(transcription, "segments", []) or []),
        "timestamp_granularities": list(
            getattr(transcription, "timestamp_granularities", []) or []
        ),
        "elapsed_ms": round(elapsed_ms, 3),
        "metrics": evaluate_transcription(case, text),
    }


def _synthesize_case(
    *,
    case_id: str,
    plan: SynthesisPlan,
    raw_dir: Path,
    audio_path: Path,
    say_path: str,
    ffmpeg_path: str,
    runner: CommandRunner,
) -> None:
    parts: list[Path] = []
    for index, segment in enumerate(plan.segments):
        aiff_path = raw_dir / f"{case_id}-{index:02d}.aiff"
        wav_path = raw_dir / f"{case_id}-{index:02d}.wav"
        runner(
            [
                say_path,
                "-v",
                plan.voice,
                "-r",
                str(plan.rate_wpm),
                "-o",
                str(aiff_path),
                segment.text,
            ]
        )
        runner(
            [
                ffmpeg_path,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(aiff_path),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ]
        )
        if segment.pitch_contour:
            pitched_path = raw_dir / f"{case_id}-{index:02d}-pitch.wav"
            _apply_pitch_contour(wav_path, pitched_path, segment.pitch_contour)
            wav_path = pitched_path
        parts.append(wav_path)
        if segment.pause_after_ms:
            silence_path = raw_dir / f"{case_id}-{index:02d}-pause.wav"
            runner(
                [
                    ffmpeg_path,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=16000:cl=mono",
                    "-t",
                    f"{segment.pause_after_ms / 1000:.3f}",
                    "-c:a",
                    "pcm_s16le",
                    str(silence_path),
                ]
            )
            parts.append(silence_path)

    concatenated = raw_dir / f"{case_id}-joined.wav"
    if len(parts) == 1:
        shutil.copyfile(parts[0], concatenated)
    else:
        concat_path = raw_dir / f"{case_id}-concat.txt"
        concat_path.write_text(
            "".join(f"file '{_ffmpeg_concat_path(path)}'\n" for path in parts),
            encoding="utf-8",
        )
        runner(
            [
                ffmpeg_path,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_path),
                "-c:a",
                "pcm_s16le",
                str(concatenated),
            ]
        )

    command = [
        ffmpeg_path,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(concatenated),
    ]
    audio_filters = _audio_filter_chain(plan)
    if plan.noise_amplitude:
        command.extend(
            [
                "-f",
                "lavfi",
                "-i",
                f"anoisesrc=color=pink:amplitude={plan.noise_amplitude}:sample_rate=16000",
            ]
        )
        voice_filter = ",".join(audio_filters) if audio_filters else "anull"
        command.extend(
            [
                "-filter_complex",
                f"[0:a]{voice_filter}[voice];"
                "[voice][1:a]amix=inputs=2:duration=first:dropout_transition=0[mixed]",
                "-map",
                "[mixed]",
            ]
        )
    elif audio_filters:
        command.extend(["-af", ",".join(audio_filters)])
    command.extend(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(audio_path)])
    runner(command)


def _audio_filter_chain(plan: SynthesisPlan) -> list[str]:
    filters: list[str] = []
    if plan.tempo != 1.0:
        filters.append(f"atempo={plan.tempo:.6f}")
    if plan.volume_db != 0.0:
        filters.append(f"volume={plan.volume_db:.3f}dB")
    if plan.lowpass_hz is not None:
        filters.append(f"lowpass=f={plan.lowpass_hz}")
    if plan.echo_delay_ms and plan.echo_decay:
        filters.append(
            f"aecho=0.8:0.88:{plan.echo_delay_ms}:{plan.echo_decay:.3f}"
        )
    return filters


def _apply_pitch_contour(input_path: Path, output_path: Path, contour: str) -> None:
    try:
        import numpy as np
        import parselmouth
        from parselmouth.praat import call
    except ImportError as exc:
        raise RuntimeError(
            "pitch contour synthesis requires praat-parselmouth; install the asr-eval extra"
        ) from exc

    sound = parselmouth.Sound(str(input_path))
    pitch = sound.to_pitch(time_step=0.01, pitch_floor=75, pitch_ceiling=600)
    frequencies = pitch.selected_array["frequency"]
    voiced = frequencies > 0
    if not np.any(voiced):
        raise RuntimeError(f"pitch contour could not find voiced frames: {input_path}")
    times = pitch.xs()[voiced]
    median_hz = float(np.median(frequencies[voiced]))
    start = float(times[0])
    end = float(times[-1])
    if end <= start:
        raise RuntimeError(f"pitch contour voiced range is empty: {input_path}")

    manipulation = call(sound, "To Manipulation", 0.01, 75, 600)
    pitch_tier = call(manipulation, "Extract pitch tier")
    call(pitch_tier, "Remove points between", start, end)
    factors = PITCH_CONTOUR_FACTORS[contour]
    for index, factor in enumerate(factors):
        fraction = index / (len(factors) - 1) if len(factors) > 1 else 0.5
        call(pitch_tier, "Add point", start + ((end - start) * fraction), median_hz * factor)
    call([pitch_tier, manipulation], "Replace pitch tier")
    synthesized = call(manipulation, "Get resynthesis (overlap-add)")
    synthesized.save(str(output_path), parselmouth.SoundFileFormat.WAV)


def _required_text(case: Mapping[str, object], field: str, *, index: int) -> str:
    value = str(case.get(field) or "").strip()
    if not value:
        raise ValueError(f"case {index} field is required: {field}")
    return value


def _bounded_int(value: object, minimum: int, maximum: int, field: str, case_id: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer for {case_id}")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer for {case_id}") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} is out of range for {case_id}: {parsed}")
    return parsed


def _bounded_float(
    value: object,
    minimum: float,
    maximum: float,
    field: str,
    case_id: str,
) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number for {case_id}")
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number for {case_id}") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} is out of range for {case_id}: {parsed}")
    return parsed


def _required_executable(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise RuntimeError(f"required executable is missing: {name}")
    return executable


def _run_command(command: Sequence[str]) -> None:
    subprocess.run(list(command), check=True)


def _command_version(command: Sequence[str]) -> str:
    result = subprocess.run(
        list(command),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return result.stdout.splitlines()[0].strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as stream:
        return round(stream.getnframes() / stream.getframerate(), 3)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _markdown_cell(value: object) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _ffmpeg_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")


def _package_version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "not-installed"


def _model_cache_paths(root: Path) -> dict[str, Path]:
    return {
        "faster_whisper": root / "faster-whisper",
        "huggingface": root / "huggingface",
        "huggingface_hub": root / "huggingface" / "hub",
        "modelscope": root / "modelscope",
    }


@contextmanager
def _temporary_environment(values: Mapping[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value


def _find_model_snapshot(cache_dir: Path) -> str | None:
    revisions = [
        revision
        for repository in sorted(cache_dir.glob("models--*"))
        if (revision := _cached_huggingface_revision(repository))
    ]
    return revisions[-1] if revisions else None


def _funasr_model_metadata(provider: Any, cache_dir: Path) -> dict[str, object]:
    model_ids = (
        str(provider.model),
        str(provider.vad_model),
        str(provider.punc_model),
    )
    snapshots: dict[str, str] = {}
    for model_id in dict.fromkeys(model_ids):
        repository = cache_dir / f"models--{model_id.replace('/', '--')}"
        revision = _cached_huggingface_revision(repository)
        if revision:
            snapshots[model_id] = revision
    return {
        "model": model_ids[0],
        "vad_model": model_ids[1],
        "punc_model": model_ids[2],
        "device": str(provider.device),
        "hub": str(provider.hub),
        "batch_size_s": int(provider.batch_size_s),
        "snapshots": snapshots,
    }


def _cached_huggingface_revision(repository: Path) -> str | None:
    main_ref = repository / "refs" / "main"
    if main_ref.is_file():
        revision = main_ref.read_text(encoding="utf-8").strip()
        if revision:
            return revision
    snapshots = sorted((repository / "snapshots").glob("*"))
    if snapshots:
        return snapshots[-1].name
    tree_metadata = sorted((repository / "trees").glob("*.json"))
    if tree_metadata:
        return tree_metadata[-1].stem
    return None
