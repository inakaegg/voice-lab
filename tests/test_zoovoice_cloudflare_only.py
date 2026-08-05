from mo_speech.api import create_app


def test_fastapi_keeps_speakloop_but_does_not_serve_zoovoice() -> None:
    paths = {route.path for route in create_app().routes}

    assert "/speakloop" in paths
    assert "/speakloop/" in paths
    assert not any(path == "/zoovoice" or path == "/zoovoice/" for path in paths)
    assert not any(path.startswith("/api/zoovoice") for path in paths)
