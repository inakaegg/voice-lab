import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/smoke_cloudflare_deployment.py"


def response(
    status: int,
    body: str = "",
    content_type: str = "text/plain; charset=utf-8",
) -> tuple[int, str, str]:
    return status, content_type, body


def json_response(status: int, payload: Any) -> tuple[int, str, str]:
    return response(status, json.dumps(payload), "application/json")


def run_smoke(
    responses: dict[str, tuple[int, str, str]],
) -> subprocess.CompletedProcess[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            status, content_type, body = responses.get(
                self.path,
                response(404, "not found"),
            )
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--base-url",
                base_url,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def healthy_responses() -> dict[str, tuple[int, str, str]]:
    return {
        "/": response(200, "<html>top</html>", "text/html"),
        "/speakloop": response(200, "<html>speakloop</html>", "text/html"),
        "/privacy": response(200, "<html>privacy</html>", "text/html"),
        "/api/public-sample-audios": json_response(200, {"features": {}}),
        "/api/public-session": json_response(
            200,
            {
                "google_login_required": True,
                "google_login_configured": True,
                "authenticated": False,
            },
        ),
        "/api/vibevoice/status": json_response(401, {"error": "authentication required"}),
        "/robots.txt": response(
            200,
            "User-agent: *\nDisallow: /admin\n\nSitemap: http://example.com/sitemap.xml\n",
        ),
        "/sitemap.xml": response(
            200,
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            "  <url><loc>http://example.com/</loc></url>\n"
            "</urlset>\n",
            "application/xml; charset=utf-8",
        ),
    }


def test_smoke_accepts_a_healthy_deployment() -> None:
    result = run_smoke(healthy_responses())

    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS 8/8" in result.stdout


def test_smoke_accepts_a_non_canonical_deployment_that_blocks_crawlers() -> None:
    responses = healthy_responses()
    responses["/robots.txt"] = response(200, "User-agent: *\nDisallow: /\n")
    responses["/sitemap.xml"] = response(404, "not found")

    result = run_smoke(responses)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS 8/8" in result.stdout


def test_smoke_rejects_a_robots_sitemap_mismatch() -> None:
    responses = healthy_responses()
    responses["/sitemap.xml"] = response(404, "not found")

    result = run_smoke(responses)
    output = result.stdout + result.stderr

    assert result.returncode == 1
    assert "/sitemap.xml" in output


def test_smoke_reports_all_failed_checks_without_response_bodies() -> None:
    secret_marker = "do-not-print-this-response"
    responses = healthy_responses()
    responses["/speakloop"] = response(503, secret_marker)
    responses["/api/public-session"] = json_response(
        200,
        {
            "google_login_required": True,
            "google_login_configured": False,
            "debug": secret_marker,
        },
    )
    responses["/api/vibevoice/status"] = json_response(
        503,
        {"error": secret_marker},
    )

    result = run_smoke(responses)
    output = result.stdout + result.stderr

    assert result.returncode == 1
    assert "FAIL 3/8" in output
    assert "/speakloop" in output
    assert "/api/public-session" in output
    assert "/api/vibevoice/status" in output
    assert secret_marker not in output
