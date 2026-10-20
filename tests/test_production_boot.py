"""SX_ENV=production boot behaviour of the app factory."""

from __future__ import annotations

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
            "headers": {"Cookie": "echo_session=secret", "X-CSRF-Token": "t", "Accept": "*/*"},
        }
    }
    scrubbed = app_module._sentry_before_send(event, None)
    assert "cookies" not in scrubbed["request"]
    assert scrubbed["request"]["headers"]["Cookie"] == "[filtered]"
    assert scrubbed["request"]["headers"]["X-CSRF-Token"] == "[filtered]"
    assert scrubbed["request"]["headers"]["Accept"] == "*/*"
