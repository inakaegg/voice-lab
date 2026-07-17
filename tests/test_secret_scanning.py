import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _make_fake_gitleaks(directory: Path) -> Path:
    executable = directory / "gitleaks"
    executable.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$@\" > \"$GITLEAKS_TEST_LOG\"\n",
        encoding="utf-8",
    )
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
    return executable


def _run_hook(tmp_path: Path, name: str) -> list[str]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _make_fake_gitleaks(fake_bin)
    log_path = tmp_path / "gitleaks-args.txt"
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
    env["GITLEAKS_TEST_LOG"] = str(log_path)

    subprocess.run(
        [str(ROOT / ".githooks" / name)],
        cwd=ROOT,
        env=env,
        input="",
        text=True,
        check=True,
    )
    return log_path.read_text(encoding="utf-8").splitlines()


def test_pre_commit_scans_staged_changes_before_commit(tmp_path: Path) -> None:
    hook = ROOT / ".githooks" / "pre-commit"

    assert hook.stat().st_mode & stat.S_IXUSR
    assert _run_hook(tmp_path, "pre-commit") == [
        "git",
        "--pre-commit",
        "--redact",
        "--staged",
        "--verbose",
    ]


def test_pre_push_scans_full_local_history_before_upload(tmp_path: Path) -> None:
    hook = ROOT / ".githooks" / "pre-push"

    assert hook.stat().st_mode & stat.S_IXUSR
    assert _run_hook(tmp_path, "pre-push") == [
        "git",
        "--redact",
        "--log-opts=--all",
        ".",
    ]


@pytest.mark.parametrize("name", ["pre-commit", "pre-push"])
def test_hook_blocks_when_gitleaks_is_missing(tmp_path: Path, name: str) -> None:
    result = subprocess.run(
        [str(ROOT / ".githooks" / name)],
        cwd=ROOT,
        env={"PATH": str(tmp_path)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "gitleaksが見つからないため" in result.stderr


def test_hook_installer_uses_worktree_scoped_git_config(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    shutil.copytree(ROOT / ".githooks", repository / ".githooks")
    (repository / "scripts").mkdir()
    shutil.copy2(
        ROOT / "scripts" / "install_git_hooks.sh",
        repository / "scripts" / "install_git_hooks.sh",
    )

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _make_fake_gitleaks(fake_bin)
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"

    subprocess.run(
        [str(repository / "scripts" / "install_git_hooks.sh")],
        cwd=repository,
        env=env,
        check=True,
    )

    extension = subprocess.run(
        ["git", "config", "--local", "--get", "extensions.worktreeConfig"],
        cwd=repository,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    hooks_path = subprocess.run(
        ["git", "config", "--worktree", "--get", "core.hooksPath"],
        cwd=repository,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()

    assert extension == "true"
    assert hooks_path == ".githooks"
