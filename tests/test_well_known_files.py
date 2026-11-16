"""robots.txt and security.txt ship in web/public and the SPA handler serves them as text."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.app import mount_spa

PUBLIC = Path(__file__).resolve().parents[1] / "web" / "public"


def _client() -> TestClient:
    application = FastAPI()
    mount_spa(application, PUBLIC)
    return TestClient(application)


def test_robots_txt_is_plain_text_and_keeps_crawlers_off_the_api():
    response = _client().get("/robots.txt")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "Disallow: /api/" in response.text


def test_security_txt_is_served_from_well_known():
    response = _client().get("/.well-known/security.txt")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    fields = dict(line.split(": ", 1) for line in response.text.splitlines() if line)
    assert fields["Contact"].startswith("https://")
    assert fields["Expires"].endswith("Z")
