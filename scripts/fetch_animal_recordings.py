#!/usr/bin/env python3
"""動物の実録音を無償の公開ライブラリから集めてくる。

取得先は Wikimedia Commons（APIキー不要）と Openverse（APIキー不要。Freesound と
Wikimedia を横断する）の2つ。商用利用できるライセンスだけを残す。実行時にAPIを
叩くのではなく、事前にこのバッチで集めて選別し、採用したものを同梱する。

使い方:
    python3 scripts/fetch_animal_recordings.py <queries.json> <出力ディレクトリ>

queries.json の形:
    {"animals": [{"id": "fox", "label_ja": "キツネ",
                  "commons_categories": ["Vulpes vulpes"],
                  "commons_searches": ["fox scream"],
                  "openverse_queries": ["red fox call"]}]}

出力ディレクトリには動物ごとのディレクトリを作り、候補音源と candidates.json
（出所・ライセンス・作者・URL・SHA-256）を書く。採否はこの後の人の判断で決める。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

USER_AGENT = "zoovoice-audio-sourcing/1.0 (https://github.com/inakaegg; 52376271+inakaegg@users.noreply.github.com)"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OPENVERSE_API = "https://api.openverse.org/v1/audio/"
AUDIO_SUFFIXES = (".ogg", ".oga", ".wav", ".mp3", ".flac", ".opus")

# 商用利用できるものだけを通す。CC BY-NC（商用禁止）と CC BY-SA（同条件公開の義務）は落とす。
ALLOWED_LICENSE_PATTERNS = (
    re.compile(r"^cc0(\b|$)", re.IGNORECASE),
    re.compile(r"^public domain", re.IGNORECASE),
    re.compile(r"^cc[ -]by([ -][0-9.]+)?$", re.IGNORECASE),
    re.compile(r"^cc[ -]by[ -][0-9.]+$", re.IGNORECASE),
)


def license_is_allowed(name: str | None) -> bool:
    if not name:
        return False
    normalized = name.strip().replace(" ", " ")
    return any(pattern.match(normalized) for pattern in ALLOWED_LICENSE_PATTERNS)


class TextExtractor(HTMLParser):
    """Commons の作者欄などに入る HTML から文字だけを取り出す。"""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_text(value: str | None) -> str:
    if not value:
        return ""
    extractor = TextExtractor()
    extractor.feed(value)
    return " ".join("".join(extractor.parts).split())


def request_json(url: str, attempts: int = 3) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"request failed: {url}: {last_error}")


def commons_api(**parameters: str) -> dict:
    parameters.setdefault("format", "json")
    parameters.setdefault("formatversion", "2")
    return request_json(COMMONS_API + "?" + urllib.parse.urlencode(parameters))


def commons_category_titles(category: str, depth: int = 1, visited: set[str] | None = None) -> list[str]:
    visited = visited if visited is not None else set()
    if category in visited:
        return []
    visited.add(category)
    titles: list[str] = []
    continuation: dict[str, str] = {}
    while True:
        response = commons_api(
            action="query",
            list="categorymembers",
            cmtitle="Category:" + category,
            cmtype="file|subcat",
            cmlimit="500",
            **continuation,
        )
        for member in response.get("query", {}).get("categorymembers", []):
            title = member["title"]
            if title.startswith("Category:"):
                if depth > 0:
                    titles += commons_category_titles(title[len("Category:"):], depth - 1, visited)
            elif title.lower().endswith(AUDIO_SUFFIXES):
                titles.append(title)
        if "continue" not in response:
            return titles
        continuation = {key: value for key, value in response["continue"].items() if key != "continue"}


def commons_search_titles(query: str, limit: int = 30) -> list[str]:
    response = commons_api(
        action="query",
        list="search",
        srsearch=f"{query} filetype:audio",
        srnamespace="6",
        srlimit=str(limit),
    )
    return [
        hit["title"]
        for hit in response.get("query", {}).get("search", [])
        if hit["title"].lower().endswith(AUDIO_SUFFIXES)
    ]


def commons_file_details(titles: list[str]) -> list[dict]:
    details: list[dict] = []
    unique = sorted(set(titles))
    for start in range(0, len(unique), 25):
        chunk = unique[start : start + 25]
        response = commons_api(
            action="query",
            titles="|".join(chunk),
            prop="imageinfo",
            iiprop="url|size|extmetadata",
            iiextmetadatafilter="LicenseShortName|LicenseUrl|Artist|ImageDescription",
        )
        for page in response.get("query", {}).get("pages", []):
            info = (page.get("imageinfo") or [{}])[0]
            if not info.get("url"):
                continue
            metadata = info.get("extmetadata", {})
            details.append(
                {
                    "provider": "wikimedia_commons",
                    "title": page["title"],
                    "download_url": info["url"],
                    "landing_url": info.get("descriptionurl", ""),
                    "license": plain_text((metadata.get("LicenseShortName") or {}).get("value")),
                    "license_url": (metadata.get("LicenseUrl") or {}).get("value", ""),
                    "creator": plain_text((metadata.get("Artist") or {}).get("value")),
                    "description": plain_text((metadata.get("ImageDescription") or {}).get("value"))[:400],
                    "bytes": info.get("size"),
                }
            )
    return details


def openverse_results(query: str, license_filter: str, limit: int = 20) -> list[dict]:
    url = OPENVERSE_API + "?" + urllib.parse.urlencode(
        {"q": query, "license": license_filter, "page_size": str(limit)}
    )
    try:
        payload = request_json(url)
    except RuntimeError:
        return []
    results: list[dict] = []
    for item in payload.get("results", []):
        download_url = item.get("url") or ""
        if not download_url:
            continue
        results.append(
            {
                "provider": f"openverse:{item.get('source', '')}",
                "title": item.get("title") or "",
                "download_url": download_url,
                "landing_url": item.get("foreign_landing_url") or "",
                "license": (item.get("license") or "").upper() + " " + (item.get("license_version") or ""),
                "license_url": item.get("license_url") or "",
                "creator": item.get("creator") or "",
                "description": (item.get("description") or "")[:400],
                "bytes": item.get("filesize"),
            }
        )
    return results


def suffix_for(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    for suffix in AUDIO_SUFFIXES:
        if path.lower().endswith(suffix):
            return suffix
    return ".audio"


def download(url: str, destination: Path) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = response.read()
    destination.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def gather(animal: dict) -> list[dict]:
    candidates: list[dict] = []
    titles: list[str] = []
    for category in animal.get("commons_categories", []):
        titles += commons_category_titles(category)
    for query in animal.get("commons_searches", []):
        titles += commons_search_titles(query)
    candidates += commons_file_details(titles)
    for query in animal.get("openverse_queries", []):
        for license_filter in ("cc0", "by"):
            candidates += openverse_results(query, license_filter)
    seen: set[str] = set()
    unique: list[dict] = []
    for candidate in candidates:
        key = candidate["download_url"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def run(queries_path: Path, output_dir: Path) -> int:
    queries = json.loads(queries_path.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    for animal in queries["animals"]:
        animal_id = animal["id"]
        animal_dir = output_dir / animal_id
        animal_dir.mkdir(exist_ok=True)
        found = gather(animal)
        allowed = [item for item in found if license_is_allowed(item["license"])]
        kept: list[dict] = []
        for index, item in enumerate(allowed, start=1):
            name = f"candidate{index:02d}{suffix_for(item['download_url'])}"
            destination = animal_dir / name
            try:
                item["sha256"] = download(item["download_url"], destination)
            except Exception as error:  # 取得できない候補は記録だけ残して飛ばす
                item["error"] = str(error)
                print(f"  ! {animal_id} {name}: {error}", file=sys.stderr)
                continue
            item["file"] = name
            item["bytes"] = destination.stat().st_size
            kept.append(item)
        (animal_dir / "candidates.json").write_text(
            json.dumps(
                {"id": animal_id, "label_ja": animal["label_ja"],
                 "searched": {key: animal.get(key, []) for key in
                              ("commons_categories", "commons_searches", "openverse_queries")},
                 "found_total": len(found), "license_allowed": len(allowed), "candidates": kept},
                ensure_ascii=False, indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        print(f"{animal_id:12} 見つかった {len(found):3} 件 / 使えるライセンス {len(allowed):3} 件 / 取得 {len(kept):3} 件")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("queries", type=Path)
    parser.add_argument("output_dir", type=Path)
    arguments = parser.parse_args()
    return run(arguments.queries.resolve(), arguments.output_dir.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
