import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy_zoovoice_cloud_run.sh"
DOCKERFILE = ROOT / "services/zoovoice/Dockerfile"
CI_WORKFLOW = ROOT / ".github/workflows/ci.yml"
WHISPER_COMMIT = "5250a86fdebac4d51085fcfcd0b315cb0c6b91c9"
MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"


def run_deploy(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=ROOT,
        env={**os.environ, **env},
        text=True,
        capture_output=True,
        check=False,
    )


def install_recording_fakes(directory: Path) -> Path:
    log_path = directory / "commands.log"
    fake = directory / "fake-command"
    fake.write_text(
        r"""#!/usr/bin/env bash
set -eu
printf '%s' "${0##*/}" >> "$ZOOVOICE_FAKE_COMMAND_LOG"
printf ' %q' "$@" >> "$ZOOVOICE_FAKE_COMMAND_LOG"
printf '\n' >> "$ZOOVOICE_FAKE_COMMAND_LOG"

case "${0##*/}:$*" in
  git:*-C*rev-parse\ HEAD*) printf '%s\n' "$ZOOVOICE_FAKE_WHISPER_COMMIT"; exit 0 ;;
  git:*branch\ --show-current*) printf 'feat/zoovoice-phase1-followup\n'; exit 0 ;;
  git:*rev-parse\ HEAD*) printf '0123456789abcdef0123456789abcdef01234567\n'; exit 0 ;;
  git:*status\ --porcelain*) printf '%s' "${ZOOVOICE_FAKE_GIT_STATUS:-}"; exit 0 ;;
  shasum:*ggml-small.bin*) printf '%s  model\n' "$ZOOVOICE_FAKE_MODEL_SHA"; exit 0 ;;
  docker:info*) exit 0 ;;
  docker:run*) printf 'zoovoice-container-id\n'; exit 0 ;;
  docker:image\ inspect*) printf '612345678\n'; exit 0 ;;
  docker:stats*) printf '384MiB\n'; exit 0 ;;
  docker:*) exit 0 ;;
  curl:*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--output" ]; then
        shift
        printf '{"audio":{"format":"wav","base64":"UklGRg=="},"meta":{"transcript":"犬が走る","selected_animal":{"id":"dog","label_ja":"犬"},"association_reason":"%s","insertions":[],"input_duration_seconds":1,"output_duration_seconds":1}}' "${ZOOVOICE_FAKE_ASSOCIATION_REASON:-犬が出てくるため}" > "$1"
      fi
      shift || true
    done
    exit 0
    ;;
  gcloud:auth\ print-access-token*) printf 'fake-access-token\n'; exit 0 ;;
  gcloud:artifacts\ repositories\ describe*) exit 1 ;;
  gcloud:artifacts\ docker\ images\ describe*) printf 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'; exit 0 ;;
  gcloud:iam\ service-accounts\ describe*) exit 1 ;;
  gcloud:config\ get-value\ account*) printf 'developer@example.com\n'; exit 0 ;;
  gcloud:run\ services\ get-iam-policy*) printf '{"bindings":[]}\n'; exit 0 ;;
  gcloud:artifacts\ repositories\ get-iam-policy*) printf '{"bindings":[]}\n'; exit 0 ;;
  gcloud:run\ services\ describe*status.url*) printf 'https://zoovoice-example.run.app\n'; exit 0 ;;
  gcloud:run\ services\ describe*latestReadyRevisionName*) printf 'zoovoice-00001-test\n'; exit 0 ;;
  gcloud:*) exit 0 ;;
esac
exit 97
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    for name in ("docker", "gcloud", "curl", "git", "shasum"):
        (directory / name).symlink_to(fake.name)
    return log_path


def valid_artifact_env(tmp_path: Path) -> dict[str, str]:
    source = tmp_path / "whisper-source"
    source.mkdir()
    (source / "LICENSE").write_text("MIT\n", encoding="utf-8")
    (source / "CMakeLists.txt").write_text("# fixture\n", encoding="utf-8")
    model = tmp_path / "ggml-small.bin"
    model.write_bytes(b"model fixture")
    smoke = tmp_path / "smoke.wav"
    smoke.write_bytes(b"RIFF fixture")
    sounds = tmp_path / "sounds"
    (sounds / "dog").mkdir(parents=True)
    (sounds / "dog" / "dog-1.wav").write_bytes(b"RIFF fixture")
    (sounds / "manifest.json").write_text(
        '{"schema_version":1,"animals":[]}', encoding="utf-8"
    )
    return {
        "ZOOVOICE_WHISPER_SOURCE_DIR": str(source),
        "ZOOVOICE_ASR_MODEL_PATH": str(model),
        "ZOOVOICE_SOUNDS_DIR": str(sounds),
        "ZOOVOICE_SMOKE_AUDIO_PATH": str(smoke),
        "ZOOVOICE_FAKE_WHISPER_COMMIT": WHISPER_COMMIT,
        "ZOOVOICE_FAKE_MODEL_SHA": MODEL_SHA256,
        "OPENAI_API_KEY": "test-openai-key",
    }


def test_cloud_run_deploy_dry_run_is_private_bounded_and_has_no_side_effects(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    artifacts = valid_artifact_env(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "example-project",
            **artifacts,
        }
    )

    assert result.returncode == 0, result.stderr
    output = result.stdout
    assert "mode: dry-run" in output
    assert "--region us-central1" in output
    assert "--no-allow-unauthenticated" in output
    assert "--min-instances 0" in output
    assert "--max-instances 2" in output
    assert "--concurrency 1" in output
    assert "--timeout 90s" in output
    assert "--cpu 2" in output
    assert "--memory 2Gi" in output
    assert "--build-context whisper_source=<temporary-context>" in output
    assert "--build-context zoovoice_runtime=<temporary-context>" in output
    assert "--build-context zoovoice_sounds=<temporary-context>" in output
    assert "--allow-unauthenticated" not in output.replace(
        "--no-allow-unauthenticated", ""
    )
    assert "roles/run.invoker" in output
    assert "roles/iam.serviceAccountTokenCreator" in output
    assert "allUsers" in output
    assert "must be absent" in output
    assert "production credential" not in output.lower()
    for value in (
        artifacts["ZOOVOICE_WHISPER_SOURCE_DIR"],
        artifacts["ZOOVOICE_ASR_MODEL_PATH"],
        artifacts["ZOOVOICE_SMOKE_AUDIO_PATH"],
    ):
        assert value not in output + result.stderr
    commands = command_log.read_text(encoding="utf-8")
    assert "docker " not in commands
    assert "gcloud " not in commands
    assert "curl " not in commands


def test_cloud_run_deploy_rejects_an_invalid_project_before_external_commands(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "bad project; rm -rf",
        }
    )

    assert result.returncode != 0
    assert "ZOOVOICE_GCP_PROJECT is invalid" in result.stderr
    assert not command_log.exists()


def test_cloud_run_deploy_requires_runtime_artifacts_before_build(tmp_path: Path) -> None:
    command_log = install_recording_fakes(tmp_path)
    artifacts = valid_artifact_env(tmp_path)

    for omitted in (
        "ZOOVOICE_WHISPER_SOURCE_DIR",
        "ZOOVOICE_ASR_MODEL_PATH",
        "ZOOVOICE_SOUNDS_DIR",
        "ZOOVOICE_SMOKE_AUDIO_PATH",
        "OPENAI_API_KEY",
    ):
        # 実行環境に残る値が漏れないよう、削除ではなく空値で上書きする。
        env = {**artifacts, "ZOOVOICE_GCP_PROJECT": "example-project", omitted: ""}
        result = run_deploy(
            {
                "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
                "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
                **env,
            }
        )
        assert result.returncode != 0, omitted
        assert f"{omitted} is required" in result.stderr


def test_cloud_run_deploy_rejects_a_model_sha_mismatch(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    artifacts = valid_artifact_env(tmp_path)
    base = {
        "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
        "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
        "ZOOVOICE_GCP_PROJECT": "example-project",
        **artifacts,
    }

    wrong_model = run_deploy({**base, "ZOOVOICE_FAKE_MODEL_SHA": "0" * 64})
    assert wrong_model.returncode != 0
    assert "ASR model SHA-256 mismatch" in wrong_model.stderr
    assert "0" * 64 not in wrong_model.stdout + wrong_model.stderr


def test_cloud_run_deploy_rejects_a_dirty_whisper_source_before_build(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_FAKE_GIT_STATUS": " M src/whisper.cpp\n",
            "ZOOVOICE_GCP_PROJECT": "example-project",
            **valid_artifact_env(tmp_path),
        }
    )

    assert result.returncode != 0
    assert "whisper.cpp source must be clean" in result.stderr
    commands = command_log.read_text(encoding="utf-8")
    assert "docker " not in commands


def test_cloud_run_apply_uses_digest_private_iam_and_bounded_resources(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    artifacts = valid_artifact_env(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "example-project",
            "ZOOVOICE_DEPLOY_APPLY": "1",
            "ZOOVOICE_LOCAL_SMOKE_PORT": "18081",
            **artifacts,
        }
    )

    assert result.returncode == 0, result.stderr
    commands = command_log.read_text(encoding="utf-8")
    assert "docker info" in commands
    assert "gcloud auth print-access-token" in commands
    assert "gcloud services enable" in commands
    assert "run.googleapis.com" in commands
    assert "artifactregistry.googleapis.com" in commands
    assert "iamcredentials.googleapis.com" in commands
    assert "gcloud artifacts repositories create voice-lab" in commands
    assert "docker buildx build --platform linux/amd64" in commands
    assert "--push" in commands
    assert "gcloud run deploy zoovoice" in commands
    assert "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" in commands
    assert "--no-allow-unauthenticated" in commands
    assert "--min-instances 0" in commands
    assert "--max-instances 2" in commands
    assert "--concurrency 1" in commands
    assert "--timeout 90s" in commands
    assert "--cpu 2" in commands
    assert "--memory 2Gi" in commands
    assert "--build-context whisper_source=" in commands
    assert "--build-context zoovoice_runtime=" in commands
    assert "--build-context zoovoice_sounds=" in commands
    assert "gcloud run services add-iam-policy-binding zoovoice" in commands
    assert "roles/run.invoker" in commands
    assert "gcloud iam service-accounts add-iam-policy-binding" in commands
    assert "roles/iam.serviceAccountTokenCreator" in commands
    assert "--allow-unauthenticated" not in commands.replace(
        "--no-allow-unauthenticated", ""
    )

    combined_output = result.stdout + result.stderr
    assert "fake-access-token" not in combined_output
    assert "developer@example.com" not in combined_output
    assert "zoovoice-local-smoke-invoker@example-project" not in combined_output


def test_local_verify_builds_and_smokes_without_gcloud(tmp_path: Path) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "example-project",
            "ZOOVOICE_LOCAL_VERIFY": "1",
            **valid_artifact_env(tmp_path),
        }
    )

    assert result.returncode == 0, result.stderr
    commands = command_log.read_text(encoding="utf-8")
    assert "docker buildx build --platform linux/amd64" in commands
    assert "docker run" in commands
    assert "curl" in commands
    assert "gcloud " not in commands
    assert "local verification complete" in result.stdout


def test_local_verify_rejects_a_response_without_an_association_reason(tmp_path: Path) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_FAKE_ASSOCIATION_REASON": "   ",
            "ZOOVOICE_GCP_PROJECT": "example-project",
            "ZOOVOICE_LOCAL_VERIFY": "1",
            **valid_artifact_env(tmp_path),
        }
    )

    assert result.returncode != 0
    assert "local verification complete" not in result.stdout


def test_whisper_builder_supplies_version_without_copying_git_history() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert "ARG WHISPER_SOURCE_COMMIT" in dockerfile
    assert "-DBUILD_SHARED_LIBS=OFF" in dockerfile
    assert "-DGGML_BUILD_NUMBER=" in dockerfile
    assert "-DGGML_BUILD_COMMIT=$WHISPER_SOURCE_COMMIT" in dockerfile


def test_ci_builds_the_repository_owned_service_stage_without_runtime_contexts() -> None:
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    assert "Build the Zoovoice service stage" in workflow
    assert "docker build --target service-builder" in workflow


def test_ci_runs_the_chromium_only_zoovoice_portal_suite_once() -> None:
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    portal_step = workflow.split("- name: Zoovoice portal tests", 1)[1]
    portal_step = portal_step.split("- name:", 1)[0]
    assert "if: matrix.browser == 'chromium'" in portal_step
    assert "run: npm run test:e2e:portal-zoovoice" in portal_step


def test_runtime_artifacts_are_readable_by_the_nonroot_user() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "install -d --mode=0755 /app/licenses /app/models /app/sounds"
        in dockerfile
    )
    assert (
        "COPY --from=zoovoice_runtime --chmod=0444 ggml-small.bin "
        "/app/models/ggml-small.bin"
    ) in dockerfile
    assert "COPY --from=zoovoice_sounds . /app/sounds" in dockerfile
    assert "chmod -R a=rX /app/sounds" in dockerfile
    assert "ZOOVOICE_SOUNDS_DIR=/app/sounds" in dockerfile
    # 鳴き声素材はリポジトリに置かないので、image へ repository から入れない。
    assert "COPY services/zoovoice/assets" not in dockerfile
    assert "ZOOVOICE_CONCEPTNET_INDEX_PATH" not in dockerfile
    assert "/app/models/ggml-small.bin | sha256sum --check --strict" in dockerfile
