from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class ZoovoiceBackendResponse:
    status: int
    body: bytes
    content_type: str


class ZoovoiceBackendUnavailable(RuntimeError):
    pass


class ZoovoiceBackendClient:
    def __init__(self, base_url: str, *, timeout_seconds: float = 35.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> ZoovoiceBackendClient:
        return cls(
            os.getenv("ZOOVOICE_BACKEND_URL", "http://127.0.0.1:8090"),
        )

    def get_animals(self) -> ZoovoiceBackendResponse:
        return self._request(
            Request(
                f"{self.base_url}/animals",
                headers={"Accept": "application/json"},
                method="GET",
            )
        )

    def compose(self, body: bytes, content_type: str) -> ZoovoiceBackendResponse:
        return self._request(
            Request(
                f"{self.base_url}/compose",
                data=body,
                headers={
                    "Accept": "application/json",
                    "Content-Type": content_type,
                },
                method="POST",
            )
        )

    def _request(self, request: Request) -> ZoovoiceBackendResponse:
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return ZoovoiceBackendResponse(
                    status=response.status,
                    body=response.read(),
                    content_type=response.headers.get(
                        "Content-Type",
                        "application/json; charset=utf-8",
                    ),
                )
        except HTTPError as error:
            return ZoovoiceBackendResponse(
                status=error.code,
                body=error.read(),
                content_type=error.headers.get(
                    "Content-Type",
                    "application/json; charset=utf-8",
                ),
            )
        except (TimeoutError, URLError, OSError) as error:
            raise ZoovoiceBackendUnavailable(str(error)) from error
