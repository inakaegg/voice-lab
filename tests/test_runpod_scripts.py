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
