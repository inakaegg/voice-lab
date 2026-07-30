from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from mo_speech.api import create_app
from mo_speech.zoovoice_proxy import (
    ZoovoiceBackendResponse,
    ZoovoiceBackendUnavailable,
)


class FakeZoovoiceClient:
    def __init__(self) -> None:
        self.animals_response = ZoovoiceBackendResponse(
            status=200,
            body=json.dumps(
                {
                    "animals": [
                        {"id": "cat", "label_ja": "猫", "variants": 2},
                    ]
                }
            ).encode(),
            content_type="application/json; charset=utf-8",
        )
        self.compose_response = ZoovoiceBackendResponse(
            status=200,
            body=json.dumps(
                {
                    "audio": {"format": "wav", "base64": "UklGRg=="},
                    "meta": {
                        "insertions": [],
                        "input_duration_seconds": 1.5,
                        "output_duration_seconds": 1.5,
                    },
                }
            ).encode(),
            content_type="application/json; charset=utf-8",
        )
        self.compose_body = b""
        self.compose_content_type = ""

    def get_animals(self) -> ZoovoiceBackendResponse:
        return self.animals_response

    def compose(self, body: bytes, content_type: str) -> ZoovoiceBackendResponse:
        self.compose_body = body
        self.compose_content_type = content_type
        return self.compose_response


def test_zoovoice_animals_proxy_forwards_backend_json() -> None:
    backend = FakeZoovoiceClient()
    client = TestClient(create_app(zoovoice_client=backend))

    response = client.get("/api/zoovoice/animals")

    assert response.status_code == 200
    assert response.json() == {
        "animals": [{"id": "cat", "label_ja": "猫", "variants": 2}]
    }


@pytest.mark.parametrize("path", ["/zoovoice", "/zoovoice/"])
def test_zoovoice_route_serves_react_page(path: str) -> None:
    client = TestClient(create_app(zoovoice_client=FakeZoovoiceClient()))

    response = client.get(path)

    assert response.status_code == 200
    assert "zoovoice" in response.text
    assert "/react/assets/zoovoice.js" in response.text


def test_zoovoice_compose_proxy_preserves_multipart_body_and_content_type() -> None:
    backend = FakeZoovoiceClient()
    client = TestClient(create_app(zoovoice_client=backend))
    settings = {
        "arrangement": {"opening": "cat", "gaps": None, "ending": None},
        "intensity": 40,
    }

    response = client.post(
        "/api/zoovoice/compose",
        data={"settings": json.dumps(settings)},
        files={"audio": ("recording.webm", b"recorded audio", "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["audio"]["format"] == "wav"
    assert backend.compose_content_type.startswith("multipart/form-data; boundary=")
    assert b'recording.webm' in backend.compose_body
    assert b'recorded audio' in backend.compose_body
    assert b'"intensity": 40' in backend.compose_body


class UnavailableZoovoiceClient:
    def get_animals(self) -> ZoovoiceBackendResponse:
        raise ZoovoiceBackendUnavailable("connection refused")

    def compose(self, body: bytes, content_type: str) -> ZoovoiceBackendResponse:
        raise ZoovoiceBackendUnavailable("connection refused")


@pytest.mark.parametrize(
    ("method", "path", "request_kwargs"),
    [
        ("get", "/api/zoovoice/animals", {}),
        (
            "post",
            "/api/zoovoice/compose",
            {
                "data": {
                    "settings": json.dumps(
                        {
                            "arrangement": {
                                "opening": "cat",
                                "gaps": None,
                                "ending": None,
                            },
                            "intensity": 40,
                        }
                    )
                },
                "files": {
                    "audio": (
                        "recording.webm",
                        b"recorded audio",
                        "audio/webm",
                    )
                },
            },
        ),
    ],
)
def test_zoovoice_proxy_returns_json_502_when_backend_is_unreachable(
    method: str,
    path: str,
    request_kwargs: dict[str, object],
) -> None:
    client = TestClient(create_app(zoovoice_client=UnavailableZoovoiceClient()))

    response = getattr(client, method)(path, **request_kwargs)

    assert response.status_code == 502
    assert response.json() == {
        "error": {
            "code": "zoovoice_backend_unavailable",
            "message": "音声合成サービスに接続できませんでした。",
        }
    }
