#!/usr/bin/env python3
"""動物連想APIの応答を固定で返すHTTPサーバー。CIのlocal smoke専用。

CIは課金対象の外部API呼び出しを行わない。一方でdeploy前にimageの動作は確かめたい。
そこで `ZOOVOICE_LLM_ENDPOINT` をこのサーバーへ向け、連想の1往復だけを固定応答へ置き換える。
ASR・形態素解析・音声合成・起動時のmanifest照合は本番と同じ経路を通る。

これはGoのテスト内で使う `stubDoer` とは別物である。あちらはプロセス内でHTTP clientを
差し替えるが、こちらはcontainerの外に立てる実サーバーで、imageには手を入れない。
検証する成果物と配布する成果物を同一に保つための構成である。

応答の形は services/zoovoice/association_test.go のfixtureに合わせる。
テスト専用の新しい形式は作らない。
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def build_payload(species: str, reason: str) -> bytes:
    inner = json.dumps({"animals": [{"species": species, "reason": reason}]}, ensure_ascii=False)
    return json.dumps({"output_text": inner}, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    payload = b""

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandlerの規約)
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.payload)))
        self.end_headers()
        self.wfile.write(self.payload)

    def do_GET(self) -> None:  # noqa: N802
        """疎通確認用。containerを起動する前にstubが待ち受けているかを確かめる。"""
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_arguments: object) -> None:
        """既定のstderrログは出さない。CIのログを埋めないため。"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    # containerからはgateway経由で届くため、127.0.0.1では受けられない。
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=19000)
    parser.add_argument("--species", default="dog", help="音源セットに存在する動物のid")
    parser.add_argument("--reason", default="CIの固定応答")
    arguments = parser.parse_args()

    Handler.payload = build_payload(arguments.species, arguments.reason)
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
