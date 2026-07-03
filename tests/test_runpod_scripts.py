import json
import os
import subprocess
from pathlib import Path


def test_runpod_build_push_prefers_explicit_image_env(tmp_path: Path) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "RUNPOD_IMAGE=docker.io/example/from-file:old\n",
        encoding="utf-8",
    )

    env = os.environ.copy()
    env.update(
        {
            "RUNPOD_DRY_RUN": "1",
            "RUNPOD_ENV_FILE": str(env_file),
            "RUNPOD_IMAGE": "docker.io/example/from-env:new",
        }
    )

    result = subprocess.run(
        ["bash", "scripts/runpod_build_push.sh"],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )

    assert "docker.io/example/from-env:new" in result.stdout
    assert "docker.io/example/from-file:old" not in result.stdout


def test_runpod_common_sets_vibevoice_revision_defaults() -> None:
    command = (
        "source scripts/runpod_common.sh; "
        "set_default_runpod_app_env; "
        "runpod_env_json "
        "VIBEVOICE_MODEL_REPO "
        "VIBEVOICE_MODEL_REVISION "
        "VIBEVOICE_TOKENIZER_REPO "
        "VIBEVOICE_TOKENIZER_REVISION"
    )

    result = subprocess.run(
        ["bash", "-lc", command],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload == {
        "VIBEVOICE_MODEL_REPO": "microsoft/VibeVoice-1.5B",
        "VIBEVOICE_MODEL_REVISION": "1904eae38036e9c780d28e27990c27748984eafe",
        "VIBEVOICE_TOKENIZER_REPO": "Qwen/Qwen2.5-1.5B",
        "VIBEVOICE_TOKENIZER_REVISION": "8faed761d45a263340a0528343f099c05c9a4323",
    }


def test_runpod_common_does_not_preload_voice_conversion_by_default() -> None:
    command = (
        "source scripts/runpod_common.sh; "
        "set_default_runpod_app_env; "
        "runpod_env_json "
        "MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START "
        "MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_VIBEVOICE"
    )

    result = subprocess.run(
        ["bash", "-lc", command],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload == {
        "MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START": "0",
        "MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_VIBEVOICE": "1",
    }


def test_runpod_common_sets_directed_vibevoice_pipeline_defaults() -> None:
    command = (
        "source scripts/runpod_common.sh; "
        "set_default_runpod_app_env; "
        "runpod_env_json "
        "MO_VIBEVOICE_DIRECTED_ASR_PROVIDER "
        "MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL "
        "MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE "
        "MO_VIBEVOICE_DIRECTED_VC_ENABLED "
        "MO_VIBEVOICE_DIRECTED_VC_BACKEND"
    )

    result = subprocess.run(
        ["bash", "-lc", command],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert payload == {
        "MO_VIBEVOICE_DIRECTED_ASR_PROVIDER": "openai",
        "MO_VIBEVOICE_DIRECTED_OPENAI_ASR_MODEL": "whisper-1",
        "MO_VIBEVOICE_DIRECTED_ASR_LANGUAGE": "auto",
        "MO_VIBEVOICE_DIRECTED_VC_ENABLED": "1",
        "MO_VIBEVOICE_DIRECTED_VC_BACKEND": "seed-vc",
    }


def test_runpod_image_workflow_frees_disk_space_before_build() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")

    cleanup_index = workflow.index("Free runner disk space")
    build_index = workflow.index("Build and push RunPod image")

    assert cleanup_index < build_index
    assert "/opt/hostedtoolcache" in workflow
    assert "/usr/local/cuda*" in workflow


def test_runpod_image_workflow_embeds_source_revision() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")
    dockerfile = Path("Dockerfile.runpod").read_text(encoding="utf-8")

    assert "SOURCE_REVISION=${{ github.sha }}" in workflow
    assert "IMAGE_TAG=${{ steps.image.outputs.image }}" in workflow
    assert "ARG SOURCE_REVISION=unknown" in dockerfile
    assert "ENV MO_IMAGE_REVISION=${SOURCE_REVISION}" in dockerfile


def test_runpod_smoke_script_supports_diagnostics_operation() -> None:
    script = Path("scripts/runpod_smoke_serverless.py").read_text(encoding="utf-8")

    assert '"diagnostics"' in script
    assert 'input_payload = {"operation_mode": "diagnostics"}' in script


def test_runpod_smoke_script_supports_vibevoice_generation_overrides() -> None:
    script = Path("scripts/runpod_smoke_serverless.py").read_text(encoding="utf-8")

    assert "--vibevoice-cfg-scale" in script
    assert "--vibevoice-no-sample" in script
    assert "--vibevoice-temperature" in script
    assert "--vibevoice-directed-line-mode" in script
    assert "--vibevoice-line-gap" in script
    assert 'generation_payload["cfg_scale"] = args.vibevoice_cfg_scale' in script
    assert 'generation_payload["do_sample"] = False' in script
    assert 'generation_payload["temperature"] = args.vibevoice_temperature' in script
    assert '"directed_line_mode": args.vibevoice_directed_line_mode' in script
    assert '"line_gap": args.vibevoice_line_gap' in script


def test_runpod_update_serverless_template_redacts_env_json(tmp_path: Path) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "RUNPOD_SERVERLESS_TEMPLATE_ID=template-id",
                "RUNPOD_IMAGE=docker.io/example/mo-speech:new",
                "OPENAI_API_KEY=secret-value",
            ]
        ),
        encoding="utf-8",
    )

    env = os.environ.copy()
    env.update({"RUNPOD_DRY_RUN": "1", "RUNPOD_ENV_FILE": str(env_file)})

    result = subprocess.run(
        ["bash", "scripts/runpod_update_serverless_template.sh"],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )

    assert "runpodctl template update template-id" in result.stdout
    assert "--image docker.io/example/mo-speech:new" in result.stdout
    assert "env-json-redacted" in result.stdout
    assert "secret-value" not in result.stdout


def test_runpod_update_serverless_template_redacts_runpodctl_output(tmp_path: Path) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "RUNPOD_SERVERLESS_TEMPLATE_ID=template-id",
                "RUNPOD_IMAGE=docker.io/example/mo-speech:new",
                "OPENAI_API_KEY=secret-value",
                "HF_TOKEN=token-value",
            ]
        ),
        encoding="utf-8",
    )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_runpodctl = bin_dir / "runpodctl"
    fake_runpodctl.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' '{\"env\":{\"OPENAI_API_KEY\":\"secret-value\",\"HF_TOKEN\":\"token-value\"}}'\n",
        encoding="utf-8",
    )
    fake_runpodctl.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}:{env['PATH']}",
            "RUNPOD_ENV_FILE": str(env_file),
        }
    )

    result = subprocess.run(
        ["bash", "scripts/runpod_update_serverless_template.sh"],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )

    assert '"OPENAI_API_KEY": "<redacted>"' in result.stdout
    assert '"HF_TOKEN": "<redacted>"' in result.stdout
    assert "secret-value" not in result.stdout
    assert "token-value" not in result.stdout


def test_runpod_deploy_serverless_image_dry_run_orchestrates_unique_tag(tmp_path: Path) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "RUNPOD_IMAGE=docker.io/example/mo-speech:old",
                "RUNPOD_SERVERLESS_TEMPLATE_NAME=mo-speech-serverless-old",
                "RUNPOD_SERVERLESS_TEMPLATE_ID=old-template",
                "RUNPOD_ENDPOINT_ID=endpoint-id",
                "RUNPOD_API_KEY=secret-key",
                "OPENAI_API_KEY=secret-openai",
            ]
        ),
        encoding="utf-8",
    )

    env = os.environ.copy()
    env.update(
        {
            "RUNPOD_DRY_RUN": "1",
            "RUNPOD_ENV_FILE": str(env_file),
            "RUNPOD_DEPLOY_REF": "feature/test",
            "RUNPOD_DEPLOY_SOURCE_SHA": "abcdef1234567890",
        }
    )

    result = subprocess.run(
        ["bash", "scripts/runpod_deploy_serverless_image.sh"],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )
    output = result.stdout + result.stderr

    assert "runpod-vibevoice-abcdef1" in output
    assert "gh workflow run runpod-image.yml --ref feature/test" in output
    assert "-f image_name=docker.io/example/mo-speech" in output
    assert "-f image_tag=runpod-vibevoice-abcdef1" in output
    assert "runpodctl template create" in output
    assert "--image docker.io/example/mo-speech:runpod-vibevoice-abcdef1" in output
    assert "/v1/endpoints/endpoint-id/update" in output
    assert "python scripts/runpod_smoke_serverless.py --operation-mode diagnostics" in output
    assert "secret-key" not in output
    assert "secret-openai" not in output
    assert "RUNPOD_IMAGE=docker.io/example/mo-speech:old" in env_file.read_text(encoding="utf-8")


def test_runpod_deploy_serverless_image_reuses_existing_template_name() -> None:
    script = Path("scripts/runpod_deploy_serverless_image.sh").read_text(encoding="utf-8")

    assert "find_existing_template_id" in script
    assert "runpodctl template list --type user" in script
    assert "template already exists; reusing" in script
    assert "runpodctl template update" in script
    assert 'template_id="$(create_or_update_template)"' in script
