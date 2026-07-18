from __future__ import annotations

import sys
from pathlib import Path
from zipfile import ZipFile


REQUIRED_WEB_ASSETS = {
    "mo_speech/web/react/app-styles.html",
    "mo_speech/web/react/favicon.ico",
    "mo_speech/web/react/portal.html",
    "mo_speech/web/react/speakloop.html",
    "mo_speech/web/react/skitvoice.html",
    "mo_speech/web/react/assets/app.css",
    "mo_speech/web/react/assets/portal.css",
    "mo_speech/web/react/assets/components.js",
    "mo_speech/web/react/assets/licenses.md",
    "mo_speech/web/react/assets/portal.js",
    "mo_speech/web/react/assets/speakloop.js",
    "mo_speech/web/react/assets/skitvoice.js",
}


def main() -> int:
    wheel_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "tmp/wheel")
    wheels = sorted(wheel_dir.glob("voice_lab-*.whl"))
    if len(wheels) != 1:
        raise SystemExit(f"expected exactly one Voice Lab wheel in {wheel_dir}, found {len(wheels)}")

    with ZipFile(wheels[0]) as wheel:
        bundled = set(wheel.namelist())
    missing = sorted(REQUIRED_WEB_ASSETS - bundled)
    if missing:
        raise SystemExit(f"wheel is missing required web assets: {', '.join(missing)}")

    print(f"wheel web assets verified: {wheels[0].name} ({len(REQUIRED_WEB_ASSETS)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
