"""Operational metrics (server/metrics.py), GET /api/ops/metrics and the alert watchdog."""

from __future__ import annotations

import logging
from datetime import timedelta

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import metrics
from server.jobs import JobManager, QueueFull
from server.observability import RequestIDMiddleware
from server.routers import health, social
from server.social import auth, database
from server.social.database import Base, get_db
from server.social.models import Report, User, utcnow

PASSWORD = "correct-horse-battery-ops"


@pytest.fixture(autouse=True)
def fresh_metrics():
    metrics.reset_for_tests()
    yield
    metrics.reset_for_tests()


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    engine = create_engine("sqlite:///" + str(tmp_path / "ops.db"), connect_args={"check_same_thread": False})
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    # Login re-derives the role from these lists.
    monkeypatch.setenv("SX_ADMIN_USERS", "the_admin")
    monkeypatch.setenv("SX_MODERATOR_USERS", "the_mod")
    monkeypatch.setattr(database, "SessionLocal", session)
    application = FastAPI()
    application.include_router(health.router)
    application.include_router(social.router)

    @application.get("/api/items/{item_id}")
    def item(item_id: str):
        return {"id": item_id}

    @application.get("/api/broken")
    def broken():
        raise RuntimeError("boom")

    application.add_middleware(RequestIDMiddleware)

    def override_get_db():
        db = session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = session
    yield application
    Base.metadata.drop_all(engine)
    engine.dispose()


def add_user(app, name: str, role: str = "user") -> str:
    with app.state.testing_session() as db:
        user = User(
            email=f"{name}@example.com",
            email_norm=f"{name}@example.com",
            username=name,
            username_norm=name,
            password_hash=auth.hash_password(PASSWORD),
            display_name=name,
            role=role,
            status="active",
        )
        db.add(user)
        db.commit()
        return user.id


def sign_in(app, name: str) -> TestClient:
    client = TestClient(app)
    response = client.post("/api/auth/login", json={"identifier": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return client


def test_ops_metrics_are_admin_only(app):
    add_user(app, "plain_user")
    add_user(app, "the_mod", role="moderator")
    add_user(app, "the_admin", role="admin")
    assert TestClient(app).get("/api/ops/metrics").status_code == 401
    assert sign_in(app, "plain_user").get("/api/ops/metrics").status_code == 403
    assert sign_in(app, "the_mod").get("/api/ops/metrics").status_code == 403

    response = sign_in(app, "the_admin").get("/api/ops/metrics")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) >= {"requests", "events", "jobs", "db_pool", "sse", "disk"}
    assert body["jobs"]["capacity"] >= 1
    assert body["sse"]["open_streams"] == 0


def test_requests_are_grouped_by_route_template_with_5xx_counted(app):
    client = TestClient(app, raise_server_exceptions=False)
    for item_id in ("a", "b", "c"):
        assert client.get(f"/api/items/{item_id}").status_code == 200
    assert client.get("/api/broken").status_code == 500
    assert client.get("/api/healthz").status_code == 200  # not access-logged, not counted

    window = metrics.request_window()
    assert window["count"] == 4
    assert window["errors_5xx"] == 1
    assert window["error_rate"] == 0.25
    assert window["status"] == {"2xx": 3, "5xx": 1}
    routes = {row["route"]: row for row in window["routes"]}
    # Raw ids never become keys.
    assert set(routes) == {"/api/items/{item_id}", "/api/broken"}
    assert routes["/api/items/{item_id}"]["count"] == 3
    assert routes["/api/items/{item_id}"]["method"] == "GET"
    items = routes["/api/items/{item_id}"]
    assert items["p50_ms"] <= items["p95_ms"] <= items["max_ms"]
    assert routes["/api/broken"]["errors_5xx"] == 1
    assert window["p95_ms"] is not None


def test_job_queue_depth_and_full_queue_events(monkeypatch):
    monkeypatch.setenv("SX_MAX_JOBS_PER_USER", "1")
    monkeypatch.setenv("SX_MAX_PENDING_JOBS", "2")
    manager = JobManager(max_image_workers=1, max_video_workers=1)
    manager.reserve_job("image", "alice")
    with pytest.raises(QueueFull):
        manager.reserve_job("image", "alice")
    manager.reserve_job("image", "bob")
    with pytest.raises(QueueFull):
        manager.reserve_job("image", "carol")
    assert manager.queue_depth() == {"queued": 2, "running": 0, "active": 2, "capacity": 2}
    assert metrics.event_window() == {"queue_full_user": 1, "queue_full": 1}
    manager.shutdown(drain_s=0)


def test_failed_job_is_counted():
    manager = JobManager(max_image_workers=1, max_video_workers=1)
    job_id = manager.create_job("image")

    def fail(status_callback):
        raise RuntimeError("encoder exploded")

    manager.submit(job_id, fail, {})
    manager.get_job(job_id).future.result(timeout=10)
    assert metrics.event_window().get("job_failed") == 1
    manager.shutdown(drain_s=0)


def _snapshot(**overrides) -> dict:
    snap = {
        "requests": {"count": 100, "errors_5xx": 0, "error_rate": 0.0, "p95_ms": 120.0},
        "events": {},
        "jobs": {"queued": 0, "running": 0, "active": 0, "capacity": 6},
        "db_pool": {"size": 5, "checkedout": 1, "capacity": 15},
    }
    snap.update(overrides)
    return snap


def test_thresholds(monkeypatch):
    assert metrics.evaluate_alerts(_snapshot()) == {}
    alerts = metrics.evaluate_alerts(_snapshot(
        requests={"count": 100, "errors_5xx": 6, "error_rate": 0.06, "p95_ms": 2500.0},
        events={"job_failed": 2, "derived_failed": 1},
        jobs={"queued": 4, "running": 2, "active": 6, "capacity": 6},
        db_pool={"size": 5, "checkedout": 15, "capacity": 15},
    ))
    assert set(alerts) == {"5xx_rate", "p95", "queue_full", "db_pool", "processing_failures"}
    # Too little traffic for rates and percentiles to mean anything.
    quiet = _snapshot(requests={"count": 5, "errors_5xx": 5, "error_rate": 1.0, "p95_ms": 9000.0})
    assert metrics.evaluate_alerts(quiet) == {}
    monkeypatch.setenv("SX_ALERT_P95_MS", "100")
    assert set(metrics.evaluate_alerts(_snapshot())) == {"p95"}


def test_each_alert_is_logged_once_per_cooldown(monkeypatch, caplog):
    snap = _snapshot(requests={"count": 50, "errors_5xx": 10, "error_rate": 0.2, "p95_ms": 100.0})
    monkeypatch.setattr(metrics, "snapshot", lambda: snap)
    monkeypatch.setattr(metrics, "_registration_and_report_spikes", lambda: {})
    caplog.set_level(logging.ERROR, logger="sx.alerts")

    assert metrics.check_alerts() == ["5xx_rate"]
    assert metrics.check_alerts() == []
    records = [r for r in caplog.records if r.name == "sx.alerts"]
    assert len(records) == 1
    assert records[0].levelno == logging.ERROR
    assert records[0].alert == "5xx_rate"

    monkeypatch.setenv("SX_ALERT_COOLDOWN_S", "0")
    assert metrics.check_alerts() == ["5xx_rate"]


def test_report_spike_raises_an_alert(app, monkeypatch, caplog):
    monkeypatch.setenv("SX_MOD_SPIKE_MIN", "5")
    monkeypatch.setattr(metrics, "snapshot", _snapshot)
    reporter = add_user(app, "reporter")
    with app.state.testing_session() as db:
        for index in range(6):
            db.add(Report(reporter_id=reporter, target_type="user", target_id=f"x{index}", reason="spam",
                          created_at=utcnow() - timedelta(minutes=10)))
        db.commit()
    caplog.set_level(logging.ERROR, logger="sx.alerts")
    assert metrics.check_alerts() == ["reports_spike"]
    assert "6 in the last hour" in caplog.records[-1].getMessage()


def test_open_queue_backlog_raises_an_alert(app, monkeypatch, caplog):
    monkeypatch.setenv("SX_ALERT_OPEN_REPORTS", "2")
    monkeypatch.setattr(metrics, "snapshot", _snapshot)
    reporter = add_user(app, "reporter")
    with app.state.testing_session() as db:
        for index in range(2):
            db.add(Report(reporter_id=reporter, target_type="user", target_id=f"x{index}", reason="spam",
                          created_at=utcnow() - timedelta(days=3)))
        db.commit()
    caplog.set_level(logging.ERROR, logger="sx.alerts")
    assert metrics.check_alerts() == ["open_reports_backlog"]
    assert "2 open reports waiting for staff (limit 2)" in caplog.records[-1].getMessage()


def test_snapshot_serves_the_alert_limits(monkeypatch):
    monkeypatch.setenv("SX_ALERT_P95_MS", "1500")
    limits = metrics.alert_limits()
    assert limits["p95_ms"] == 1500
    assert limits["min_requests"] == metrics.MIN_REQUESTS_FOR_ALERT
    assert (limits["open_reports"], limits["open_support_requests"]) == (20, 10)
