#!/usr/bin/env python3
"""Cloudflare deployment smoke checks that do not call paid generation APIs."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 15


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes


@dataclass(frozen=True)
class Check:
    path: str
    expected_status: int
    validate: Callable[[Response], str | None] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke-test a deployed Voice Lab Cloudflare Worker.",
    )
    parser.add_argument(
        "--base-url",
        required=True,
        help="Deployment origin, for example https://voice-lab.example.workers.dev",
    )
    return parser.parse_args()


def normalize_base_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("--base-url must be an http or https origin")
    if parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment:
        raise ValueError("--base-url must not include a path, query, or fragment")
    return value.rstrip("/")


def fetch(url: str) -> Response:
    request = Request(
        url,
        headers={"User-Agent": "voice-lab-deployment-smoke/1"},
        method="GET",
    )
    opener = build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            return Response(status=response.status, body=body)
    except HTTPError as error:
        with error:
            body = error.read(MAX_RESPONSE_BYTES + 1)
        return Response(status=error.code, body=body)


def parse_json_object(response: Response) -> tuple[dict[str, Any] | None, str | None]:
    if len(response.body) > MAX_RESPONSE_BYTES:
        return None, "response exceeds 1 MiB"
    try:
        payload = json.loads(response.body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "response is not valid JSON"
    if not isinstance(payload, dict):
        return None, "response JSON is not an object"
    return payload, None


def validate_json_object(response: Response) -> str | None:
    _, error = parse_json_object(response)
    return error


def validate_public_session(response: Response) -> str | None:
    payload, error = parse_json_object(response)
    if error is not None:
        return error
    assert payload is not None
    for field in ("google_login_required", "google_login_configured"):
        if payload.get(field) is not True:
            return f"{field} is not true"
    return None


def run_checks(base_url: str) -> tuple[list[str], int]:
    checks = [
        Check("/", 200),
        Check("/speakloop", 200),
        Check("/privacy", 200),
        Check("/api/public-sample-audios", 200, validate_json_object),
        Check("/api/public-session", 200, validate_public_session),
        Check("/api/vibevoice/status", 401, validate_json_object),
    ]
    failures: list[str] = []

    for check in checks:
        try:
            response = fetch(f"{base_url}{check.path}")
        except (OSError, URLError) as error:
            failures.append(f"{check.path}: request failed ({type(error).__name__})")
            continue
        if response.status != check.expected_status:
            failures.append(
                f"{check.path}: expected HTTP {check.expected_status}, "
                f"got {response.status}",
            )
            continue
        if check.validate is not None:
            validation_error = check.validate(response)
            if validation_error is not None:
                failures.append(f"{check.path}: {validation_error}")

    return failures, len(checks)


def main() -> int:
    args = parse_args()
    try:
        base_url = normalize_base_url(args.base_url)
    except ValueError as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 2

    failures, total = run_checks(base_url)
    if failures:
        print(f"FAIL {len(failures)}/{total}")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"PASS {total}/{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
