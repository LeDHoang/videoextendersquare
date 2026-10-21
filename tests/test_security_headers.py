"""Security headers, the CSP nonce on served HTML, and /api/csp-report."""

from __future__ import annotations

import json
import logging
import re
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

with patch("dotenv.load_dotenv"):
    from server import app as app_module
from server import security_headers
from server.routers import reels
from server.social.auth import get_optional_auth
from server.social.database import get_db

STATIC_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), xr-spatial-tracking=(self)",
}

INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="modulepreload" crossorigin href="/assets/vendor-abc.js">
    <title>ECHO</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </body>
</html>
"""


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SX_ENV", raising=False)
    monkeypatch.delenv("SX_CSP_MODE", raising=False)
    monkeypatch.delenv("SX_MEDIA_BASE_URL", raising=False)
    monkeypatch.delenv("SX_TENOR_ALLOWED_HOSTS", raising=False)
    monkeypatch.setattr(security_headers, "_rate_hits", {})
    # Keep a developer's real server/static build out of the way; mount a fixture build.
    real_mount_spa = app_module.mount_spa
    monkeypatch.setattr(app_module, "mount_spa", lambda *_: None)
    application = app_module.create_app()

    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (static / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    real_mount_spa(application, static)

    monkeypatch.setattr(reels, "_recommendation_feed_data", lambda **_: {"items": []})
    application.dependency_overrides[get_db] = lambda: None
    application.dependency_overrides[get_optional_auth] = lambda: None
    return application


@pytest.fixture
def client(app):
    return TestClient(app)


def _csp(response) -> str:
    return response.headers.get("content-security-policy") or response.headers["content-security-policy-report-only"]


def _header_nonce(response) -> str:
    match = re.search(r"'nonce-([^']+)'", _csp(response))
    assert match, _csp(response)
    return match.group(1)


def _assert_scripts_nonced(html: str, nonce: str) -> int:
    tags = re.findall(r"<script\b[^>]*>", html, re.IGNORECASE)
    assert tags
    for tag in tags:
        assert f'nonce="{nonce}"' in tag, tag
    return len(tags)


@pytest.mark.parametrize("path", ["/api/healthz", "/", "/some/spa/route", "/api/reels/player"])
def test_static_headers_on_every_response(client, path):
    response = client.get(path)
    assert response.status_code == 200
    for name, value in STATIC_HEADERS.items():
        assert response.headers[name] == value
    assert "strict-transport-security" not in response.headers


def test_404_and_preflight_still_get_headers(client):
    assert client.get("/api/nope").headers["x-frame-options"] == "DENY"
    preflight = client.options(
        "/api/healthz",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert preflight.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(
    "mode, header, absent",
    [
        ("report", "content-security-policy-report-only", "content-security-policy"),
        ("enforce", "content-security-policy", "content-security-policy-report-only"),
    ],
)
def test_modes_pick_header_name(client, monkeypatch, mode, header, absent):
    monkeypatch.setenv("SX_CSP_MODE", mode)
    response = client.get("/api/healthz")
    assert header in response.headers
    assert absent not in response.headers
    policy = response.headers[header]
    assert "report-uri /api/csp-report" in policy
    assert response.headers["reporting-endpoints"] == 'csp="/api/csp-report"'


def test_off_mode_sends_no_csp(client, monkeypatch):
    monkeypatch.setenv("SX_CSP_MODE", "off")
    response = client.get("/")
    assert "content-security-policy" not in response.headers
    assert "content-security-policy-report-only" not in response.headers
    # Templates still carry a nonce so switching modes needs no redeploy.
    assert 'nonce="' in response.text


def test_default_mode_depends_on_environment(monkeypatch):
    monkeypatch.delenv("SX_CSP_MODE", raising=False)
    monkeypatch.delenv("SX_ENV", raising=False)
    assert security_headers.csp_mode() == "off"
    monkeypatch.setenv("SX_ENV", "production")
    assert security_headers.csp_mode() == "report"
    monkeypatch.setenv("SX_CSP_MODE", "bogus")
    assert security_headers.csp_mode() == "report"
    monkeypatch.setenv("SX_CSP_MODE", "enforce")
    assert security_headers.csp_mode() == "enforce"


def test_policy_contents(client, monkeypatch):
    monkeypatch.setenv("SX_CSP_MODE", "report")
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com/bucket/")
    policy = _csp(client.get("/api/healthz"))
    directives = {part.split()[0]: part.split()[1:] for part in policy.split("; ")}
    assert "'strict-dynamic'" in directives["script-src"]
    assert "'unsafe-inline'" not in directives["script-src"]
    assert "https://fonts.googleapis.com" in directives["style-src"]
    assert "https://fonts.gstatic.com" in directives["font-src"]
    for name in ("img-src", "media-src", "connect-src"):
        assert "https://media.example.com" in directives[name]
    assert "https://media.tenor.com" in directives["img-src"]
    assert "https://nominatim.openstreetmap.org" in directives["connect-src"]
    assert directives["frame-ancestors"] == ["'none'"]
    assert directives["object-src"] == ["'none'"]
    assert directives["base-uri"] == ["'none'"]


@pytest.mark.parametrize("path", ["/", "/reels", "/index.html"])
def test_spa_nonce_matches_and_rotates(client, monkeypatch, path):
    monkeypatch.setenv("SX_CSP_MODE", "enforce")
    first = client.get(path)
    second = client.get(path)
    assert first.headers["cache-control"] == "no-cache"
    nonce = _header_nonce(first)
    assert _assert_scripts_nonced(first.text, nonce) == 1
    assert f'<link nonce="{nonce}" rel="modulepreload"' in first.text
    assert f'<meta property="csp-nonce" nonce="{nonce}">' in first.text
    assert _header_nonce(second) != nonce
    _assert_scripts_nonced(second.text, _header_nonce(second))


def test_spa_assets_are_served_untouched(client):
    response = client.get("/assets/index-abc.js")
    assert response.text == "console.log(1)"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_reels_player_scripts_are_nonced(client, monkeypatch):
    monkeypatch.setenv("SX_CSP_MODE", "report")
    first = client.get("/api/reels/player")
    nonce = _header_nonce(first)
    # Eight template tags: seven vendored bundles plus the player init.
    assert _assert_scripts_nonced(first.text, nonce) >= 8
    second = client.get("/api/reels/player")
    assert _header_nonce(second) != nonce
    _assert_scripts_nonced(second.text, _header_nonce(second))


def test_compare_player_may_be_framed_same_origin(client, monkeypatch):
    monkeypatch.setenv("SX_CSP_MODE", "report")
    response = client.get("/api/compare/player", params={"pair": "missing"})
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in _csp(response)


def test_nonce_html_skips_already_nonced_tags():
    html = '<head></head><script nonce="keep">x</script><SCRIPT src="a.js"></SCRIPT>'
    out = security_headers.nonce_html(html, "n1")
    assert '<script nonce="keep">' in out
    assert '<script nonce="n1" src="a.js">' in out
    assert out.count('nonce="n1"') == 2  # the uppercase tag + the meta tag
    assert security_headers.nonce_html(html, None) == html


# ── /api/csp-report ─────────────────────────────────────────────────────────

LEGACY_REPORT = {
    "csp-report": {
        "document-uri": "https://echo.example/reels?post=abc&token=secret",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://evil.example/x.js?" + "q" * 400,
    }
}

REPORTING_API_REPORT = [
    {
        "type": "csp-violation",
        "url": "https://echo.example/packs/1",
        "body": {
            "documentURL": "https://echo.example/packs/1?x=1",
            "effectiveDirective": "img-src",
            "blockedURL": "https://cdn.other.example/a.png",
        },
    },
    {"type": "deprecation", "body": {}},
]


def test_csp_report_legacy_format(client, caplog):
    caplog.set_level(logging.WARNING, logger="server.csp")
    response = client.post(
        "/api/csp-report",
        content=json.dumps(LEGACY_REPORT),
        headers={"Content-Type": "application/csp-report"},
    )
    assert response.status_code == 204
    lines = [r.getMessage() for r in caplog.records if r.name == "server.csp"]
    assert len(lines) == 1
    line = lines[0]
    assert "directive=script-src-elem" in line
    assert "blocked=https://evil.example/x.js" in line
    assert "document=/reels " in line + " "
    assert "secret" not in line and "post=" not in line


def test_csp_report_reporting_api_format(client, caplog):
    caplog.set_level(logging.WARNING, logger="server.csp")
    response = client.post(
        "/api/csp-report",
        content=json.dumps(REPORTING_API_REPORT),
        headers={"Content-Type": "application/reports+json"},
    )
    assert response.status_code == 204
    lines = [r.getMessage() for r in caplog.records if r.name == "server.csp"]
    assert lines == ["csp violation directive=img-src blocked=https://cdn.other.example/a.png document=/packs/1"]


def test_csp_report_truncates_blocked_uri(client, caplog):
    caplog.set_level(logging.WARNING, logger="server.csp")
    report = {"csp-report": {"effective-directive": "img-src", "blocked-uri": "https://x.example/" + "a" * 500}}
    client.post("/api/csp-report", content=json.dumps(report), headers={"Content-Type": "application/csp-report"})
    line = next(r.getMessage() for r in caplog.records if r.name == "server.csp")
    blocked = re.search(r"blocked=(\S+)", line).group(1)
    assert len(blocked) == 200


def test_csp_report_rejects_oversized_body(client):
    body = json.dumps({"csp-report": {"blocked-uri": "x" * 9000}})
    response = client.post("/api/csp-report", content=body, headers={"Content-Type": "application/csp-report"})
    assert response.status_code == 413


def test_csp_report_rejects_other_content_types(client):
    response = client.post("/api/csp-report", content="{}", headers={"Content-Type": "text/plain"})
    assert response.status_code == 415


def test_csp_report_rate_limited_per_ip(client):
    body = json.dumps(LEGACY_REPORT)
    headers = {"Content-Type": "application/csp-report"}
    codes = [client.post("/api/csp-report", content=body, headers=headers).status_code for _ in range(security_headers.CSP_REPORT_RATE + 1)]
    assert codes[:-1] == [204] * security_headers.CSP_REPORT_RATE
    assert codes[-1] == 429
