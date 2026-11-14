"""SX_ENV=production boot behaviour of the app factory."""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# server.app calls load_dotenv() at import; keep the developer's .env (FAL /
# Civitai tokens) out of the test process so later tests stay hermetic.
with patch("dotenv.load_dotenv"):
    from server import app as app_module


def _paths(application) -> set[str]:
    # Mounts are top-level routes; API routes are listed via the OpenAPI
    # schema (included routers are wrapped, not flattened, in newer FastAPI).
    mounts = {getattr(route, "path", "") for route in application.routes}
    return mounts | set(application.openapi()["paths"])


def test_dev_app_mounts_media_and_compare(monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    paths = _paths(app_module.create_app())
    assert "/media" in paths
    assert any(p.startswith("/api/compare") for p in paths)


def test_production_app_drops_media_mount_and_compare(monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    application = app_module.create_app()
    paths = _paths(application)
    assert "/media" not in paths
    assert "/avatars" in paths
    assert not any(p.startswith("/api/compare") for p in paths)
    # Without lifespan (no DB needed): unmounted /media must be a real 404,
    # not the SPA shell.
    client = TestClient(application)
    assert client.get("/media/uploads/x.mp4").status_code == 404
    assert client.get("/api/compare/prepare").status_code == 404


DOCS_PATHS = {"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}


def test_production_app_serves_no_api_docs(monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    assert DOCS_PATHS.isdisjoint(_paths(app_module.create_app()))


def test_dev_app_keeps_api_docs(monkeypatch):
    monkeypatch.delenv("SX_ENV", raising=False)
    assert DOCS_PATHS <= _paths(app_module.create_app())


def test_production_boot_refuses_unsafe_config(monkeypatch):
    monkeypatch.setenv("SX_ENV", "production")
    monkeypatch.delenv("SX_SECURITY_SECRET", raising=False)
    application = app_module.create_app()
    with pytest.raises(RuntimeError, match="Production configuration is unsafe"):
        with TestClient(application):
            pass


def test_sentry_scrubs_credentials():
    event = {
        "request": {
            "cookies": {"echo_session": "secret"},
            "headers": {
                "Cookie": "echo_session=secret",
                "X-CSRF-Token": "t",
                "Cf-Connecting-Ip": "203.0.113.7",
                "Accept": "*/*",
            },
        }
    }
    scrubbed = app_module._sentry_before_send(event, None)
    assert "cookies" not in scrubbed["request"]
    assert scrubbed["request"]["headers"]["Cookie"] == "[filtered]"
    assert scrubbed["request"]["headers"]["X-CSRF-Token"] == "[filtered]"
    assert scrubbed["request"]["headers"]["Cf-Connecting-Ip"] == "[filtered]"
    assert scrubbed["request"]["headers"]["Accept"] == "*/*"


def test_sentry_drops_query_strings():
    event = {
        "request": {"url": "https://x/api/users/search", "query_string": "q=alice"},
        "spans": [{"data": {"url": "https://tenor.googleapis.com/v2/search", "http.query": "q=cat&key=k"}}],
    }
    scrubbed = app_module._sentry_before_send(event, None)
    assert "query_string" not in scrubbed["request"]
    assert scrubbed["spans"][0]["data"] == {"url": "https://tenor.googleapis.com/v2/search"}
    crumb = app_module._sentry_before_breadcrumb({"data": {"url": "u", "http.query": "key=k"}}, None)
    assert crumb["data"] == {"url": "u"}


def test_sentry_event_carries_no_credentials(monkeypatch):
    """End to end through the SDK: frame locals would otherwise ship the raw
    ASGI scope, which before_send never sees."""
    import sentry_sdk
    from fastapi import FastAPI

    monkeypatch.setenv("SENTRY_DSN", "https://key@o1.ingest.sentry.io/1")
    monkeypatch.setenv("GIT_SHA", "abc123")
    # Built at runtime: the frames' source-context lines quote this file.
    session, auth, token, ip, search = (f"{name}-{uuid.uuid4().hex}" for name in ("s", "a", "t", "ip", "q"))
    sent = []

    class Capture(sentry_sdk.transport.Transport):
        def capture_envelope(self, envelope):
            sent.extend(item.payload.json for item in envelope.items if item.type == "event")

        def flush(self, *args, **kwargs):
            pass

    app_module._init_sentry()
    try:
        client = sentry_sdk.get_client()
        client.transport = Capture(client.options)
        probe = FastAPI()

        @probe.get("/boom")
        def boom():
            raise RuntimeError("boom")

        TestClient(probe, raise_server_exceptions=False).get(
            f"/boom?q={search}",
            headers={
                "cookie": f"echo_session={session}",
                "authorization": f"Bearer {auth}",
                "x-csrf-token": token,
                "cf-connecting-ip": ip,
            },
        )
    finally:
        monkeypatch.delenv("SENTRY_DSN")
        sentry_sdk.init()
    assert len(sent) == 1
    assert sent[0]["release"] == "abc123"
    blob = json.dumps(sent[0])
    for secret in (session, auth, token, ip, search):
        assert secret not in blob


def test_sentry_skips_health_checks(monkeypatch):
    monkeypatch.delenv("SENTRY_TRACES_SAMPLE_RATE", raising=False)
    assert app_module._sentry_traces_sampler({"asgi_scope": {"path": "/api/readyz"}}) == 0
    assert app_module._sentry_traces_sampler({"asgi_scope": {"path": "/api/feed"}}) == 0.2


def test_dev_media_is_cacheable_and_keeps_range_support(monkeypatch, tmp_path):
    """Dev /media sends the same Cache-Control as R2 uploads, so the reels
    preloader's bytes are reused by the next load; Range still answers 206."""
    from server import media_store

    monkeypatch.delenv("SX_ENV", raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    (tmp_path / "output" / "clip.mp4").write_bytes(b"0123456789" * 100)
    client = TestClient(app_module.create_app())
    full = client.get("/media/clip.mp4")
    assert full.status_code == 200
    assert full.headers["cache-control"] == media_store.CACHE_CONTROL
    part = client.get("/media/clip.mp4", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206
    assert part.headers["cache-control"] == media_store.CACHE_CONTROL
    assert part.content == (b"0123456789" * 10)
