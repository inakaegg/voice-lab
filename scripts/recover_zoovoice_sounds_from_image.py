#!/usr/bin/env python3
"""稼働中のcontainer imageから動物音源セットを復旧する。

GCSの正本を失った場合の二次復旧元として使う。imageは音源セットを ``/app/sounds`` へ
焼き込んでいるため、該当layerのblob 1本だけを取れば復元できる。image全体をpullする
必要はない（圧縮で約648 MiBに対し、音源のlayerは約6 MiB）。

復元後は manifest.json の全ファイルのSHA-256を照合する。1件でも合わなければ失敗する。
"""

import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request

PROJECT = "mo-speech-501706"
REGION = "us-central1"
REPOSITORY = "voice-lab"
SERVICE = "zoovoice"
SOUNDS_PREFIX = "app/sounds/"
REGISTRY_HOST = f"{REGION}-docker.pkg.dev"
MANIFEST_ACCEPT = (
    "application/vnd.oci.image.manifest.v1+json,"
    "application/vnd.docker.distribution.manifest.v2+json"
)


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(command)} に失敗しました: {result.stderr.strip()}")
    return result.stdout.strip()


def registry_get(path: str, token: str, accept: str | None = None) -> bytes:
    url = f"https://{REGISTRY_HOST}/v2/{PROJECT}/{REPOSITORY}/{SERVICE}/{path}"
    request = urllib.request.Request(url)
    request.add_header("Authorization", f"Bearer {token}")
    if accept:
        request.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(request) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"registryへの要求が失敗しました（{url}）: {error.code}") from error


def deployed_digest() -> str:
    image = run([
        "gcloud", "run", "services", "describe", SERVICE,
        "--project", PROJECT, "--region", REGION,
        "--format=value(spec.template.spec.containers[0].image)",
    ])
    if "@" not in image:
        raise SystemExit(f"稼働中のimageがdigest指定ではありません: {image}")
    return image.split("@", 1)[1]


def sounds_layer_candidates(config: dict, manifest: dict) -> list[str]:
    """音源を含む可能性があるlayerのdigestを、確からしい順に返す。

    ``created_by`` の部分一致だけでは足りない。``RUN`` 命令の記録文字列にも
    ``/app/sounds`` が現れることがあり、無関係な大きいlayerを掴む。
    そこで ``COPY`` 命令を先に並べ、実際に展開して中身で確かめる。
    """
    history = [entry for entry in config.get("history", []) if not entry.get("empty_layer")]
    layers = manifest["layers"]
    if len(history) != len(layers):
        raise SystemExit("image configのhistoryとlayer数が一致しません。")

    preferred: list[str] = []
    fallback: list[str] = []
    for entry, layer in zip(history, layers):
        created_by = entry.get("created_by", "")
        if "/app/sounds" not in created_by:
            continue
        if created_by.lstrip().startswith("COPY"):
            preferred.append(layer["digest"])
        else:
            fallback.append(layer["digest"])
    candidates = preferred + fallback
    if not candidates:
        raise SystemExit("/app/sounds を作るlayerが見つかりません。")
    return candidates


def extract_sounds(payload: bytes, destination: pathlib.Path) -> int:
    """layerのtarから ``app/sounds/`` 配下だけを取り出す。取り出した件数を返す。"""
    extracted = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith(SOUNDS_PREFIX):
                continue
            relative = pathlib.Path(member.name[len(SOUNDS_PREFIX):])
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit(f"想定外のpathがarchiveに含まれます: {member.name}")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"{member.name} を展開できません。")
            target.write_bytes(source.read())
            extracted += 1
    return extracted


def verify_against_manifest(root: pathlib.Path) -> tuple[int, int]:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise SystemExit("manifest.json の schema_version が 1 ではありません。")
    animals = manifest["animals"]
    checked = 0
    for animal in animals:
        for record in animal["files"]:
            path = root / record["file"]
            if not path.is_file():
                raise SystemExit(f"復元物に {record['file']} がありません。")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != record["sha256"]:
                raise SystemExit(f"{record['file']} のSHA-256が manifest と一致しません。")
            checked += 1
    return len(animals), checked


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "destination", type=pathlib.Path,
        help="復元先ディレクトリ。既存の場合は中身が残るため、空の場所を指定する",
    )
    parser.add_argument(
        "--digest", default=None,
        help="復旧元imageのdigest（sha256:...）。省略時は稼働中のCloud Runのimageを使う",
    )
    arguments = parser.parse_args()

    token = run(["gcloud", "auth", "print-access-token"])
    digest = arguments.digest or deployed_digest()
    print(f"復旧元image: {digest}")

    manifest = json.loads(registry_get(f"manifests/{digest}", token, MANIFEST_ACCEPT))
    config = json.loads(registry_get(f"blobs/{manifest['config']['digest']}", token))
    destination = arguments.destination
    destination.mkdir(parents=True, exist_ok=True)

    extracted = 0
    for candidate in sounds_layer_candidates(config, manifest):
        payload = registry_get(f"blobs/{candidate}", token)
        actual = "sha256:" + hashlib.sha256(payload).hexdigest()
        if actual != candidate:
            raise SystemExit(f"layer blobのSHA-256が一致しません: {actual}")
        extracted = extract_sounds(payload, destination)
        if extracted:
            print(f"音源layer: {candidate}")
            print(f"取得: {len(payload)} bytes（SHA-256はlayer digestと一致）")
            break
        print(f"layer {candidate} に /app/sounds のファイルは無し。次の候補を試します")
    if extracted == 0:
        raise SystemExit("どの候補layerにも /app/sounds のファイルがありませんでした。")

    animals, checked = verify_against_manifest(destination)
    print(f"復元: {extracted} ファイル")
    print(f"照合: 動物 {animals} 種 / 音声 {checked} 本すべてが manifest.json と一致")
    print(f"復元先: {destination}")


if __name__ == "__main__":
    main()
