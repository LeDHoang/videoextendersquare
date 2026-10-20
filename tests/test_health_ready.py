"""Liveness/readiness split and the hardened /api/health probe endpoint."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from server.routers import health
from server.social.database import EXPECTED_SCHEMA_REVISION, Base, get_db


def _make_app(tmp_path, *, revision: str | None):
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "health.db"),
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
        if revision:
            conn.execute(text("INSERT INTO alembic_version (version_num) VALUES (:r)"), {"r": revision})
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    application = FastAPI()
    application.include_router(health.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    return application, engine


@pytest.fixture
def stub_probes(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    calls = {"build": 0, "system": 0}

    def build_probes():
        calls["build"] += 1
        return {}

    def system_memory():
        calls["system"] += 1
        return {"label": "RAM"}

    monkeypatch.setattr(health._probes, "build_probes", build_probes)
    monkeypatch.setattr(health._probes, "system_memory", system_memory)
    monkeypatch.setattr(health._tooling, "ensure_ffmpeg_on_path", lambda: None)
    monkeypatch.setattr(health, "_cached_probes", None)
    monkeypatch.setattr(health, "_cached_system", None)
    monkeypatch.setenv("SX_DISK_MIN_FREE_GB", "0")
    return calls


def test_healthz_is_always_ok(tmp_path, stub_probes):
    application, engine = _make_app(tmp_path, revision=None)
    assert TestClient(application).get("/api/healthz").json() == {"ok": True}
    engine.dispose()


def test_readyz_ok_at_expected_revision(tmp_path, stub_probes):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    response = TestClient(application).get("/api/readyz")
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    engine.dispose()


def test_readyz_503_on_stale_schema(tmp_path, stub_probes):
    application, engine = _make_app(tmp_path, revision="20200101_0001")
    response = TestClient(application).get("/api/readyz")
    assert response.status_code == 503
    assert response.json()["checks"]["schema"]["ok"] is False
    engine.dispose()


def test_readyz_503_when_database_unreachable(tmp_path, stub_probes):
    application = FastAPI()
    application.include_router(health.router)

    class BrokenSession:
        def execute(self, *_a, **_k):
            raise RuntimeError("db down")

        def rollback(self):
            pass

    application.dependency_overrides[get_db] = lambda: BrokenSession()
    response = TestClient(application).get("/api/readyz")
    assert response.status_code == 503
    assert response.json()["checks"]["database"]["ok"] is False


def test_readyz_503_on_low_disk(tmp_path, stub_probes, monkeypatch):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    monkeypatch.setenv("SX_DISK_MIN_FREE_GB", "100000000")
    response = TestClient(application).get("/api/readyz")
    assert response.status_code == 503
    assert response.json()["checks"]["disk"]["ok"] is False
    engine.dispose()


def test_refresh_is_ignored_for_non_admins(tmp_path, stub_probes):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    client = TestClient(application)
    client.get("/api/health")
    client.get("/api/health", params={"refresh": "true"})
    client.get("/api/health", params={"refresh": "true"})
    assert stub_probes["build"] == 1
    engine.dispose()


def test_refresh_reprobes_for_admins(tmp_path, stub_probes, monkeypatch):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    monkeypatch.setattr(health, "_is_admin", lambda request, db: True)
    client = TestClient(application)
    client.get("/api/health")
    client.get("/api/health", params={"refresh": "true"})
    assert stub_probes["build"] == 2
    engine.dispose()


def test_system_snapshot_is_cached(tmp_path, stub_probes):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    client = TestClient(application)
    for _ in range(3):
        client.get("/api/health")
    assert stub_probes["system"] == 1
    engine.dispose()


def test_fal_key_suffix_hidden_in_production(tmp_path, stub_probes, monkeypatch):
    application, engine = _make_app(tmp_path, revision=EXPECTED_SCHEMA_REVISION)
    monkeypatch.setenv("FAL_KEY", "abcd-secret-1234")
    client = TestClient(application)
    assert "1234" in client.get("/api/health").json()["fal_key"]["detail"]
    monkeypatch.setenv("SX_ENV", "production")
    assert client.get("/api/health").json()["fal_key"]["detail"] == "set"
    engine.dispose()
