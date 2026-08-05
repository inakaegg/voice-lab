import importlib.util
import json
import os
import shutil
import subprocess
import tomllib
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
            "DOCKERHUB_REPOSITORY_VISIBILITY": "private",
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


def test_runpod_build_push_dry_run_does_not_require_docker(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("bash", "dirname"):
        target = shutil.which(name)
        assert target is not None, f"required command for the test is missing: {name}"
        (bin_dir / name).symlink_to(target)

    env = {
        "PATH": str(bin_dir),
        "RUNPOD_DRY_RUN": "1",
        "RUNPOD_ENV_FILE": str(tmp_path / "missing.env"),
        "RUNPOD_IMAGE": "docker.io/example/mo-speech:dry",
        "DOCKERHUB_REPOSITORY_VISIBILITY": "private",
    }

    result = subprocess.run(
        ["bash", "scripts/runpod_build_push.sh"],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )

    assert "docker buildx build" in result.stdout


def test_runpod_build_push_checks_registry_visibility_before_push() -> None:
    script = Path("scripts/runpod_build_push.sh").read_text(encoding="utf-8")

    visibility_index = script.index("check_dockerhub_visibility.sh")
    push_index = script.index("docker buildx build")

    assert visibility_index < push_index
    assert 'RUNPOD_IMAGE_VISIBILITY:-private' in script


def test_runpod_common_sets_resident_gpu_model_lifecycle_defaults() -> None:
    command = (
        "source scripts/runpod_common.sh; "
        "set_default_runpod_app_env; "
        "runpod_env_json "
        "MO_RUNPOD_PRELOAD_VOICE_CONVERSION_ON_START "
        "MO_RUNPOD_PRELOAD_FUNASR_ON_START "
        "MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_FUNASR "
        "MO_RUNPOD_RELEASE_FUNASR_BEFORE_VOICE_CONVERSION "
        "FUNASR_MODEL FUNASR_FA_MODEL FUNASR_VAD_MODEL FUNASR_PUNC_MODEL FUNASR_HUB FUNASR_DEVICE"
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
        "MO_RUNPOD_PRELOAD_FUNASR_ON_START": "0",
        "MO_RUNPOD_RELEASE_VOICE_CONVERSION_BEFORE_FUNASR": "1",
        "MO_RUNPOD_RELEASE_FUNASR_BEFORE_VOICE_CONVERSION": "1",
        "FUNASR_MODEL": "funasr/paraformer-zh",
        "FUNASR_FA_MODEL": "funasr/fa-zh",
        "FUNASR_VAD_MODEL": "funasr/fsmn-vad",
        "FUNASR_PUNC_MODEL": "funasr/ct-punc",
        "FUNASR_HUB": "hf",
        "FUNASR_DEVICE": "cuda",
    }


def test_runpod_image_workflow_frees_disk_space_before_build() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")

    cleanup_index = workflow.index("Free runner disk space")
    build_index = workflow.index("Build and push RunPod image")

    assert cleanup_index < build_index
    assert "/opt/hostedtoolcache" in workflow
    assert "/usr/local/cuda*" in workflow


def test_runpod_image_workflow_requires_explicit_destination_visibility() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")

    verify_index = workflow.index("Verify Docker Hub repository visibility")
    login_index = workflow.index("Log in to Docker Hub")
    build_index = workflow.index("Build and push RunPod image")

    assert 'default: "docker.io/dockerhubfd/mo-speech"' not in workflow
    assert "expected_visibility" in workflow
    assert "scripts/check_dockerhub_visibility.sh" in workflow
    assert verify_index < login_index < build_index


def test_runpod_image_workflow_does_not_expand_dispatch_inputs_in_shell_source() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")

    assert '"${INPUT_IMAGE_NAME}" "${INPUT_EXPECTED_VISIBILITY}"' in workflow
    assert 'tag="${INPUT_IMAGE_TAG}"' in workflow
    assert 'echo "- Repository visibility: \\`${INPUT_EXPECTED_VISIBILITY}\\`"' in workflow
    assert 'echo "- Base image: \\`${INPUT_BASE_IMAGE}\\`"' in workflow


def test_dockerhub_visibility_guard_blocks_unapproved_public_repository() -> None:
    env = os.environ.copy()
    env.update(
        {
            "RUNPOD_DRY_RUN": "1",
            "DOCKERHUB_REPOSITORY_VISIBILITY": "public",
        }
    )

    result = subprocess.run(
        [
            "bash",
            "scripts/check_dockerhub_visibility.sh",
            "docker.io/example/mo-speech",
            "private",
        ],
        capture_output=True,
        env=env,
        text=True,
    )

    assert result.returncode != 0
    assert "public" in result.stderr


def test_dockerhub_visibility_guard_accepts_matching_visibility() -> None:
    for visibility in ("private", "public"):
        env = os.environ.copy()
        env.update(
            {
                "RUNPOD_DRY_RUN": "1",
                "DOCKERHUB_REPOSITORY_VISIBILITY": visibility,
            }
        )

        subprocess.run(
            [
                "bash",
                "scripts/check_dockerhub_visibility.sh",
                "docker.io/example/mo-speech",
                visibility,
            ],
            check=True,
            capture_output=True,
            env=env,
            text=True,
        )


def test_runpod_image_workflow_embeds_source_revision() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")
    dockerfile = Path("Dockerfile.runpod").read_text(encoding="utf-8")

    assert "SOURCE_REVISION=${{ github.sha }}" in workflow
    assert "IMAGE_TAG=${{ steps.image.outputs.image }}" in workflow
    assert "ARG SOURCE_REVISION=unknown" in dockerfile
    assert "ENV MO_IMAGE_REVISION=${SOURCE_REVISION}" in dockerfile


def test_runpod_image_pins_cuda_compatible_torch_audio_and_imports_seed_vc() -> None:
    dockerfile = Path("Dockerfile.runpod").read_text(encoding="utf-8")
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    optional_dependencies = pyproject["project"]["optional-dependencies"]

    assert "torch==2.8.0" in optional_dependencies["local"]
    assert "torchaudio==2.8.0" in optional_dependencies["funasr"]
    assert "ARG PYTORCH_WHEEL_INDEX_URL=https://download.pytorch.org/whl/cu128" in dockerfile
    assert (
        'python -m pip install --force-reinstall "torch==${PYTORCH_VERSION}" '
        '"torchaudio==${PYTORCH_VERSION}"'
    ) in dockerfile
    assert '--index-url "${PYTORCH_WHEEL_INDEX_URL}"' in dockerfile
    assert "python -m pip check" not in dockerfile
    assert "import funasr" in dockerfile
    assert "import seed_vc.api" in dockerfile


def test_runpod_dockerfile_has_no_orphaned_continuation_lines() -> None:
    dockerfile = Path("Dockerfile.runpod").read_text(encoding="utf-8")
    previous = ""
    for line in dockerfile.splitlines():
        if line.lstrip().startswith("&&"):
            assert previous.rstrip().endswith("\\"), f"orphaned continuation line: {line.strip()}"
        if line.strip():
            previous = line
        elif not line.strip():
            previous = ""


def test_runpod_image_does_not_install_url_reference_download_tools() -> None:
    dockerfile = Path("Dockerfile.runpod").read_text(encoding="utf-8")
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    optional_dependencies = pyproject["project"]["optional-dependencies"]

    assert "ARG DENO_VERSION=" not in dockerfile
    assert "deno-x86_64-unknown-linux-gnu.zip" not in dockerfile
    assert "deno --version" not in dockerfile
    assert "yt-dlp" not in dockerfile
    assert not any(
        dependency.startswith("yt-dlp")
        for dependencies in optional_dependencies.values()
        for dependency in dependencies
    )
    assert "url-reference" not in dockerfile


def test_runpod_smoke_script_supports_diagnostics_operation() -> None:
    script = Path("scripts/runpod_smoke_serverless.py").read_text(encoding="utf-8")

    assert '"diagnostics"' in script
    assert 'input_payload = {"operation_mode": "diagnostics"}' in script
    assert '"translation"' not in script
    assert "--translation-backend" not in script
    assert "--source-language" not in script
    assert "--voice-mode" not in script


def test_runpod_smoke_script_supports_chinese_practice_asr() -> None:
    script = Path("scripts/runpod_smoke_serverless.py").read_text(encoding="utf-8")

    assert '"practice_asr"' in script
    assert 'parser.add_argument("--model-audio")' in script
    assert 'parser.add_argument("--target-text"' in script
    assert '"operation_mode": "practice_asr"' in script
    assert 'input_payload["align_timestamps"] = bool(args.model_audio)' in script
    assert '"source_language": "zh-CN"' in script
    assert 'input_payload["model_audio_base64"]' in script
    assert 'input_payload["target_text"] = args.target_text' in script
    assert 'PRACTICE_ASR_CONTRACT_VERSION = 3' in script
    assert 'practice_asr_contract_version' in script
    assert '"preload_practice_asr": args.preload_practice_asr' in script
    assert 'key.endswith("audio_base64")' in script


def test_runpod_smoke_script_uses_runpod_default_policy_without_logging_raw_errors() -> None:
    script = Path("scripts/runpod_smoke_serverless.py").read_text(encoding="utf-8")

    assert 'payload: dict[str, Any] = {"input": input_payload}' in script
    assert "RUNPOD_OPERATION_POLICIES_JSON" not in script
    assert "exc.read()" not in script
    assert "RunPod request failed with HTTP" in script


def test_runpod_update_serverless_template_redacts_env_json(tmp_path: Path) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "RUNPOD_SERVERLESS_TEMPLATE_ID=template-id",
                "RUNPOD_IMAGE=docker.io/example/mo-speech:new",
                "RUNPOD_REGISTRY_AUTH_ID=registry-id",
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

    assert "PATCH https://rest.runpod.io/v1/templates/template-id" in result.stdout
    assert "image=docker.io/example/mo-speech:new" in result.stdout
    assert "containerRegistryAuthId=registry-id" in result.stdout
    assert "env-json-redacted" in result.stdout
    assert "secret-value" not in result.stdout


def test_runpod_template_api_builds_private_serverless_payload_and_redacts_secrets() -> None:
    module_path = Path("scripts/runpod_template_api.py")
    spec = importlib.util.spec_from_file_location("runpod_template_api", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    payload = module.build_template_payload(
        action="create",
        environ={
            "RUNPOD_IMAGE": "docker.io/example/mo-speech:new",
            "RUNPOD_SERVERLESS_TEMPLATE_NAME": "private-template",
            "RUNPOD_CONTAINER_DISK_GB": "60",
            "RUNPOD_VOLUME_MOUNT_PATH": "/workspace",
            "RUNPOD_REGISTRY_AUTH_ID": "registry-id",
        },
        template_env={
            "OPENAI_API_KEY": "secret-value",
            "HF_TOKEN": "token-value",
            "MO_PROVIDER_MODE": "local",
        },
    )

    assert payload == {
        "imageName": "docker.io/example/mo-speech:new",
        "name": "private-template",
        "containerDiskInGb": 60,
        "containerRegistryAuthId": "registry-id",
        "dockerStartCmd": ["python", "-m", "mo_speech.runpod_handler"],
        "env": {
            "OPENAI_API_KEY": "secret-value",
            "HF_TOKEN": "token-value",
            "MO_PROVIDER_MODE": "local",
        },
        "isPublic": False,
        "isServerless": True,
        "volumeMountPath": "/workspace",
    }
    assert module.redact_secrets(payload)["env"] == {
        "OPENAI_API_KEY": "<redacted>",
        "HF_TOKEN": "<redacted>",
        "MO_PROVIDER_MODE": "local",
    }


def test_runpod_update_serverless_template_requires_registry_auth_for_private_image(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "\n".join(
            [
                "RUNPOD_SERVERLESS_TEMPLATE_ID=template-id",
                "RUNPOD_IMAGE=docker.io/example/mo-speech:new",
            ]
        ),
        encoding="utf-8",
    )
    env = os.environ.copy()
    env.update({"RUNPOD_DRY_RUN": "1", "RUNPOD_ENV_FILE": str(env_file)})

    result = subprocess.run(
        ["bash", "scripts/runpod_update_serverless_template.sh"],
        check=False,
        capture_output=True,
        env=env,
        text=True,
    )

    assert result.returncode != 0
    assert "RUNPOD_REGISTRY_AUTH_ID" in result.stderr


def test_runpod_create_serverless_template_requires_registry_auth_for_private_image(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".runpod.env"
    env_file.write_text(
        "RUNPOD_IMAGE=docker.io/example/mo-speech:new\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env.update({"RUNPOD_DRY_RUN": "1", "RUNPOD_ENV_FILE": str(env_file)})

    result = subprocess.run(
        ["bash", "scripts/runpod_create_serverless_template.sh"],
        check=False,
        capture_output=True,
        env=env,
        text=True,
    )

    assert result.returncode != 0
    assert "RUNPOD_REGISTRY_AUTH_ID" in result.stderr


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
                "RUNPOD_REGISTRY_AUTH_ID=registry-id",
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

    assert "runpod-app-abcdef1" in output
    assert "gh workflow run runpod-image.yml --ref feature/test" in output
    assert "-f image_name=docker.io/example/mo-speech" in output
    assert "-f expected_visibility=private" in output
    assert "-f image_tag=runpod-app-abcdef1" in output
    assert "POST https://rest.runpod.io/v1/templates" in output
    assert "image=docker.io/example/mo-speech:runpod-app-abcdef1" in output
    assert "containerRegistryAuthId=registry-id" in output
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
    assert "runpod_template_api.py" in script
    assert 'template_id="$(create_or_update_template)"' in script
