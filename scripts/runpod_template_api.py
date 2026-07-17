#!/usr/bin/env python3
"""Create or update a RunPod template through the REST API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any


SECRET_KEY_SUFFIXES = ("_KEY", "_TOKEN", "_SECRET", "_PASSWORD")
SECRET_KEYS = {"PASSWORD", "TOKEN"}


def _required(environ: Mapping[str, str], key: str) -> str:
    value = environ.get(key, "").strip()
    if not value:
        raise ValueError(f"required environment variable is missing: {key}")
    return value


def _is_secret_key(key: str) -> bool:
    normalized = key.upper()
    return normalized in SECRET_KEYS or normalized.endswith(SECRET_KEY_SUFFIXES)


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("<redacted>" if _is_secret_key(str(key)) else redact_secrets(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    return value


def build_template_payload(
    *,
    action: str,
    environ: Mapping[str, str],
    template_env: Mapping[str, str],
) -> dict[str, Any]:
    if action not in {"create", "update"}:
        raise ValueError(f"unsupported action: {action}")

    payload: dict[str, Any] = {
        "imageName": _required(environ, "RUNPOD_IMAGE"),
        "containerDiskInGb": int(environ.get("RUNPOD_CONTAINER_DISK_GB", "60")),
        "dockerStartCmd": ["python", "-m", "mo_speech.runpod_handler"],
        "env": dict(template_env),
        "isPublic": False,
        "volumeMountPath": environ.get("RUNPOD_VOLUME_MOUNT_PATH", "/runpod-volume"),
    }
    registry_auth_id = environ.get("RUNPOD_REGISTRY_AUTH_ID", "").strip()
    if registry_auth_id:
        payload["containerRegistryAuthId"] = registry_auth_id
    if action == "create":
        payload["name"] = _required(environ, "RUNPOD_SERVERLESS_TEMPLATE_NAME")
        payload["isServerless"] = True
    elif environ.get("RUNPOD_SERVERLESS_TEMPLATE_NAME", "").strip():
        payload["name"] = environ["RUNPOD_SERVERLESS_TEMPLATE_NAME"].strip()
    return payload


def _load_template_env(environ: Mapping[str, str]) -> dict[str, str]:
    raw = _required(environ, "RUNPOD_TEMPLATE_ENV_JSON")
    value = json.loads(raw)
    if not isinstance(value, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        raise ValueError("RUNPOD_TEMPLATE_ENV_JSON must be a JSON object of string values")
    return value


def _request(
    *,
    action: str,
    template_id: str | None,
    environ: Mapping[str, str],
) -> dict[str, Any]:
    api_key = _required(environ, "RUNPOD_API_KEY")
    base_url = environ.get(
        "RUNPOD_REST_API_BASE_URL",
        "https://rest.runpod.io/v1",
    ).rstrip("/")
    if action == "create":
        method = "POST"
        url = f"{base_url}/templates"
    else:
        if not template_id:
            raise ValueError("template ID is required for update")
        method = "PATCH"
        url = f"{base_url}/templates/{template_id}"

    payload = build_template_payload(
        action=action,
        environ=environ,
        template_env=_load_template_env(environ),
    )
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = f"RunPod template API failed with HTTP {exc.code}"
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None
        if body is not None:
            message += f": {json.dumps(redact_secrets(body), ensure_ascii=False)}"
        raise RuntimeError(message) from exc

    if not isinstance(value, dict):
        raise RuntimeError("RunPod template API returned a non-object response")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create", "update"))
    parser.add_argument("template_id", nargs="?")
    args = parser.parse_args()
    try:
        result = _request(
            action=args.action,
            template_id=args.template_id,
            environ=os.environ,
        )
    except (ValueError, RuntimeError, urllib.error.URLError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(redact_secrets(result), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
