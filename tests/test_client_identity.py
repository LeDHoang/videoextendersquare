"""Client IP resolution for rate limits behind Cloudflare."""

from __future__ import annotations

from starlette.requests import Request

from server.social import auth


def _request(headers: dict[str, str], client=("10.0.0.9", 1234)) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": client,
        }
    )


def test_proxy_headers_ignored_unless_trusted(monkeypatch):
    monkeypatch.setattr(auth, "TRUST_PROXY_HEADERS", False)
    request = _request({"CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2"})
    assert auth.request_identity(request) == "10.0.0.9"


def test_cf_connecting_ip_wins_when_trusted(monkeypatch):
    monkeypatch.setattr(auth, "TRUST_PROXY_HEADERS", True)
    request = _request({"CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "6.6.6.6, 1.1.1.1"})
    assert auth.request_identity(request) == "1.1.1.1"


def test_forwarded_for_uses_rightmost_hop(monkeypatch):
    # The leftmost entry is whatever the client sent; only the last hop was
    # appended by our proxy.
    monkeypatch.setattr(auth, "TRUST_PROXY_HEADERS", True)
    request = _request({"X-Forwarded-For": "6.6.6.6, 3.3.3.3"})
    assert auth.request_identity(request) == "3.3.3.3"


def test_falls_back_to_socket_peer(monkeypatch):
    monkeypatch.setattr(auth, "TRUST_PROXY_HEADERS", True)
    assert auth.request_identity(_request({})) == "10.0.0.9"
    assert auth.request_identity(_request({}, client=None)) == "unknown"
