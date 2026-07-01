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


def test_runpod_image_workflow_frees_disk_space_before_build() -> None:
    workflow = Path(".github/workflows/runpod-image.yml").read_text(encoding="utf-8")

    cleanup_index = workflow.index("Free runner disk space")
    build_index = workflow.index("Build and push RunPod image")

    assert cleanup_index < build_index
    assert "/opt/hostedtoolcache" in workflow
    assert "/usr/local/cuda*" in workflow
