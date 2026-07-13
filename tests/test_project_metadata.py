from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_dev_dependencies_cover_current_and_legacy_starlette_test_clients() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert '"httpx>=0.27,<1"' in pyproject
    assert '"httpx2>=2,<3"' in pyproject
