"""Request IDs, the sx.access log line and JSON log format."""

from __future__ import annotations

import io
import json
import logging
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
import pytest

from server import observability

# server.app calls load_dotenv() at import; keep the developer's .env out of
# the test process (see test_production_boot.py).
with patch("dotenv.load_dotenv"):
    from server import app as app_module


@pytest.fixture
def json_logs(monkeypatch):
    monkeypatch.setenv("SX_LOG_FORMAT", "json")
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    stream = io.StringIO()
    observability.configure_logging(stream=stream)

    def lines() -> list[dict]:
        return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]

    yield lines
    for handler in list(root.handlers):
        if handler not in saved_handlers:
            root.removeHandler(handler)
    for handler in saved_handlers:
        if handler not in root.handlers:
            root.addHandler(handler)
    root.setLevel(saved_level)


@pytest.fixture
def app():
    application = FastAPI()
    application.add_middleware(observability.RequestIDMiddleware)
    route_logger = logging.getLogger("tests.observability")

    @application.get("/api/ping")
    def ping():
        # Sync route: runs in the threadpool, which must still see the ID.
        route_logger.info("pinged")
        return {"request_id": observability.current_request_id()}

    @application.get("/api/healthz")
    def healthz():
        return {"ok": True}

    @application.get("/api/stream")
    def stream():
        def events():
            for index in range(3):
                yield f"data: {index}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @application.get("/api/boom")
    def boom():
        raise RuntimeError("boom")

    return application


def test_valid_incoming_id_is_kept_and_echoed(app):
    client = TestClient(app)
    response = client.get("/api/ping", headers={"X-Request-ID": "edge-abc.123_XYZ"})
    assert response.headers["X-Request-ID"] == "edge-abc.123_XYZ"
    assert response.json() == {"request_id": "edge-abc.123_XYZ"}


@pytest.mark.parametrize("incoming", ["short", "has space in it", "x" * 65, "bad/slash-id", "émoji-id-123"])
def test_invalid_incoming_id_is_replaced(app, incoming):
    client = TestClient(app)
    response = client.get("/api/ping", headers={"X-Request-ID": incoming.encode("utf-8")})
    echoed = response.headers["X-Request-ID"]
    assert echoed != incoming
    assert len(echoed) == 32 and all(ch in "0123456789abcdef" for ch in echoed)
    assert response.json() == {"request_id": echoed}


def test_each_request_gets_its_own_id(app):
    client = TestClient(app)
    first = client.get("/api/ping").headers["X-Request-ID"]
    second = client.get("/api/ping").headers["X-Request-ID"]
    assert first != second
    assert observability.current_request_id() is None


def test_json_lines_carry_request_id(app, json_logs):
    client = TestClient(app)
    response = client.get("/api/ping?secret=token", headers={"X-Request-ID": "trace-0001"})
    assert response.status_code == 200
    records = json_logs()
    route_line = next(r for r in records if r["logger"] == "tests.observability")
    assert route_line["msg"] == "pinged"
    assert route_line["request_id"] == "trace-0001"
    access = [r for r in records if r["logger"] == "sx.access"]
    assert len(access) == 1
    line = access[0]
    assert line["request_id"] == "trace-0001"
    assert (line["method"], line["path"], line["status"]) == ("GET", "/api/ping", 200)
    assert isinstance(line["duration_ms"], float)
    # No query string and no client address.
    assert "secret" not in json.dumps(line)
    assert "testclient" not in json.dumps(line)
    assert {"ts", "level"} <= set(line)


def test_healthz_is_not_access_logged(app, json_logs):
    client = TestClient(app)
    response = client.get("/api/healthz")
    assert response.headers["X-Request-ID"]
    assert not [r for r in json_logs() if r["logger"] == "sx.access"]


def test_streaming_response_is_not_buffered_and_logged_once(app, json_logs):
    client = TestClient(app)
    with client.stream("GET", "/api/stream") as response:
        assert response.headers["X-Request-ID"]
        chunks = list(response.iter_text())
    assert "".join(chunks) == "data: 0\n\ndata: 1\n\ndata: 2\n\n"
    access = [r for r in json_logs() if r["logger"] == "sx.access"]
    assert [(r["path"], r["status"]) for r in access] == [("/api/stream", 200)]


def test_unhandled_error_is_logged_as_500(app, json_logs):
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/api/boom")
    assert response.status_code == 500
    access = [r for r in json_logs() if r["logger"] == "sx.access"]
    assert [(r["path"], r["status"]) for r in access] == [("/api/boom", 500)]


def test_records_outside_a_request_have_null_request_id(json_logs):
    logging.getLogger("tests.observability").warning("boot")
    assert json_logs()[-1]["request_id"] is None


def test_log_format_defaults(monkeypatch):
    monkeypatch.delenv("SX_LOG_FORMAT", raising=False)
    monkeypatch.delenv("SX_ENV", raising=False)
    assert observability.log_format() == "text"
    monkeypatch.setenv("SX_ENV", "production")
    assert observability.log_format() == "json"
    monkeypatch.setenv("SX_LOG_FORMAT", "text")
    assert observability.log_format() == "text"


def test_text_format_shows_request_id(monkeypatch):
    monkeypatch.setenv("SX_LOG_FORMAT", "text")
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    stream = io.StringIO()
    handler = observability.configure_logging(stream=stream)
    try:
        token = observability._request_id.set("trace-0002")
        try:
            logging.getLogger("tests.observability").warning("inside")
        finally:
            observability._request_id.reset(token)
        logging.getLogger("tests.observability").warning("outside")
    finally:
        root.removeHandler(handler)
        for saved in saved_handlers:
            if saved not in root.handlers:
                root.addHandler(saved)
    inside, outside = stream.getvalue().splitlines()
    assert "tests.observability [trace-0002]: inside" in inside
    assert "tests.observability: outside" in outside


def test_app_echoes_request_id_and_sentry_tags_it():
    client = TestClient(app_module.create_app())
    response = client.get("/api/healthz", headers={"X-Request-ID": "trace-0003"})
    assert response.headers["X-Request-ID"] == "trace-0003"

    token = observability._request_id.set("trace-0004")
    try:
        event = app_module._sentry_before_send({"tags": {"area": "jobs"}}, None)
    finally:
        observability._request_id.reset(token)
    assert event["tags"] == {"area": "jobs", "request_id": "trace-0004"}
    assert "tags" not in app_module._sentry_before_send({}, None)
