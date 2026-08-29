#!/usr/bin/env python3
"""動物音源セットを決定的なtar.gzへ固める。

同じ入力からは常に同じSHA-256になる。GCS上のobject名へ内容hashを含めるため、
再現できないアーカイブでは資材の同一性を確認できない。

決定性のために固定するもの:

- entryの順序（名前順）
- mtime、mode、uid・gid、uname・gname
- gzipのmtimeと、headerへ書き込まれるfilename

最後のfilenameは見落としやすい。``gzip.GzipFile`` は出力先fileobjの ``name`` を
headerへ書くため、指定しないと出力ファイル名を変えるだけでhashが変わる。
"""

import argparse
import gzip
import hashlib
import io
import pathlib
import tarfile


def build(source: pathlib.Path, destination: pathlib.Path) -> None:
    entries = sorted(path for path in source.rglob("*") if path.is_file())
    if not entries:
        raise SystemExit(f"{source} に取り込むファイルがありません。")
    if not (source / "manifest.json").is_file():
        raise SystemExit(f"{source} に manifest.json がありません。")

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for path in entries:
            info = tarfile.TarInfo(name=str(path.relative_to(source)))
            info.size = path.stat().st_size
            info.mtime = 0
            info.mode = 0o644
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.type = tarfile.REGTYPE
            with path.open("rb") as handle:
                archive.addfile(info, handle)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as out:
        with gzip.GzipFile(filename="", fileobj=out, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(raw.getvalue())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="manifest.json付きの音源ディレクトリ")
    parser.add_argument("destination", type=pathlib.Path, help="出力するtar.gz")
    arguments = parser.parse_args()

    build(arguments.source, arguments.destination)
    digest = hashlib.sha256(arguments.destination.read_bytes()).hexdigest()
    print(f"{digest}  {arguments.destination}")


if __name__ == "__main__":
    main()
