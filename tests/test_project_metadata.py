from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_dev_dependencies_cover_current_and_legacy_starlette_test_clients() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert '"httpx>=0.27,<1"' in pyproject
    assert '"httpx2>=2,<3"' in pyproject


def test_funasr_dependencies_include_official_audio_runtime_requirement() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    funasr_extra = pyproject.split("funasr = [", 1)[1].split("]", 1)[0]

    assert '"funasr==1.3.14"' in funasr_extra
    assert '"torchaudio==2.8.0"' in funasr_extra
