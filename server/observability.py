"""Request IDs, the access log and the log format.

RequestIDMiddleware is pure ASGI (not BaseHTTPMiddleware), so SSE and other
streaming responses pass through unbuffered. It is the outermost middleware:
every log record written while a request is handled carries its ID, and the
response echoes it in X-Request-ID.

The access log (logger ``sx.access``) has one line per request: method, path
without the query string, status and ``duration_ms``. It never logs the
client IP. The line is written when the response starts, so a long SSE
stream is logged at once and ``duration_ms`` is the time to the first byte.
Each line also feeds the request window in server/metrics.py.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone

from server import metrics
from server.settings import is_production

REQUEST_ID_HEADER = "x-request-id"
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_ACCESS_SKIP_PATHS = frozenset({"/api/healthz"})

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("sx_request_id", default=None)
access_logger = logging.getLogger("sx.access")


def current_request_id() -> str | None:
    """The ID of the request being handled, or None outside a request."""
    return _request_id.get()


def _incoming_request_id(scope) -> str:
    for name, value in scope.get("headers") or ():
        if name == b"x-request-id":
            candidate = value.decode("latin-1").strip()
            if _VALID_REQUEST_ID.match(candidate):
                return candidate
            break
    return uuid.uuid4().hex


class RequestIDMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = _incoming_request_id(scope)
        scope.setdefault("state", {})["request_id"] = request_id
        token = _request_id.set(request_id)
        started = time.perf_counter()
        path = scope.get("path", "")
        response_started = False

        def log_access(status: int) -> None:
            if path in _ACCESS_SKIP_PATHS:
                return
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            method = scope.get("method", "")
            access_logger.info(
                "%s %s %s %.1fms",
                method,
                path,
                status,
                duration_ms,
                extra={"method": method, "path": path, "status": status, "duration_ms": duration_ms},
            )
            # Route template (bounded cardinality), never the raw path.
            metrics.record_request(getattr(scope.get("route"), "path", None) or "other", status, duration_ms)

        async def send_with_id(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                headers = [
                    (name, value) for name, value in message.get("headers", ())
                    if name.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                message = {**message, "headers": headers}
                log_access(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except BaseException:
            if not response_started:
                log_access(500)
            raise
        finally:
            _request_id.reset(token)


class RequestIDFilter(logging.Filter):
    """Stamps ``request_id`` (None outside a request) on every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = _request_id.get()
        return True


_STANDARD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime", "request_id"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, logger, msg, request_id, extras."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": getattr(record, "request_id", None),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


class _TextFormatter(logging.Formatter):
    """The classic line, with ``[request_id]`` after the logger name inside a request."""

    def format(self, record: logging.LogRecord) -> str:
        request_id = getattr(record, "request_id", None)
        copy = logging.makeLogRecord(vars(record))
        copy.request_part = f" [{request_id}]" if request_id else ""
        return super().format(copy)


def log_format() -> str:
    value = os.environ.get("SX_LOG_FORMAT", "").strip().lower()
    if value in {"json", "text"}:
        return value
    return "json" if is_production() else "text"


def configure_logging(stream=None) -> logging.Handler:
    """Install the app's root handler (idempotent); returns it.

    SX_LOG_FORMAT selects ``json`` or ``text`` (default: json in production).
    uvicorn's own loggers are routed through the same handler, so a JSON
    deployment has no plain-text lines. ``uvicorn.access`` is silenced
    instead: it logs the client IP, and uvicorn turns it back on whenever the
    logger has a handler (``hasHandlers()``), even with ``--no-access-log``.
    The sx.access line replaces it.
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_sx_handler", False):
            root.removeHandler(handler)
    handler = logging.StreamHandler(stream or sys.stderr)
    handler._sx_handler = True  # type: ignore[attr-defined]
    handler.addFilter(RequestIDFilter())
    if log_format() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(_TextFormatter("%(asctime)s %(levelname)s %(name)s%(request_part)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(os.environ.get("SX_LOG_LEVEL", "INFO").upper())
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    return handler
