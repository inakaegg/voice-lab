import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy_zoovoice_cloud_run.sh"


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
  git:*branch\ --show-current*) printf 'feat/zoovoice-phase1-followup\n'; exit 0 ;;
  git:*rev-parse\ HEAD*) printf '0123456789abcdef0123456789abcdef01234567\n'; exit 0 ;;
  git:*status\ --porcelain*) exit 0 ;;
  docker:info*) exit 0 ;;
  docker:run*) printf 'zoovoice-container-id\n'; exit 0 ;;
  docker:*) exit 0 ;;
  curl:*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--output" ]; then
        shift
        printf '{"audio":{"format":"wav","base64":"UklGRg=="},"meta":{}}' > "$1"
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
    for name in ("docker", "gcloud", "curl", "git"):
        (directory / name).symlink_to(fake.name)
    return log_path


def test_cloud_run_deploy_dry_run_is_private_bounded_and_has_no_side_effects(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "example-project",
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
    assert "--cpu 1" in output
    assert "--memory 512Mi" in output
    assert "--allow-unauthenticated" not in output.replace(
        "--no-allow-unauthenticated", ""
    )
    assert "roles/run.invoker" in output
    assert "roles/iam.serviceAccountTokenCreator" in output
    assert "allUsers" in output
    assert "must be absent" in output
    assert "production credential" not in output.lower()
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


def test_cloud_run_apply_uses_digest_private_iam_and_bounded_resources(
    tmp_path: Path,
) -> None:
    command_log = install_recording_fakes(tmp_path)
    result = run_deploy(
        {
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "ZOOVOICE_FAKE_COMMAND_LOG": str(command_log),
            "ZOOVOICE_GCP_PROJECT": "example-project",
            "ZOOVOICE_DEPLOY_APPLY": "1",
            "ZOOVOICE_LOCAL_SMOKE_PORT": "18081",
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
    assert "--cpu 1" in commands
    assert "--memory 512Mi" in commands
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
