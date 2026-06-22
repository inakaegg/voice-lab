from pathlib import Path
import sys

REPO_SRC = Path(__file__).resolve().parents[1] / "src"
if REPO_SRC.exists():
    sys.path.insert(0, str(REPO_SRC))

from mo_speech.qwen_tts_synthesize import main


if __name__ == "__main__":
    main()
