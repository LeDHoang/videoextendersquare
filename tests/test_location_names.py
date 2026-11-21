"""Location explore must find posts whatever the place name holds.

Accents (stored NFC or NFD), commas, spaces, apostrophes, slashes and ``&``
all go through one key. ``tests/fixtures/location_keys.json`` is shared with
the web locationKey() test, so the link the web builds is the key asserted here.
"""

from __future__ import annotations

import json
from pathlib import Path
import unicodedata
from urllib.parse import quote

from fastapi.testclient import TestClient
import pytest

from server.routers import reels
from server.social import database, safety
from server.social.geo import location_coords, location_key
from server.social.services import invalidate_reel_records
from test_private_posts import app, make_post, register, scan_item  # noqa: F401  (app is a fixture)

CASES = json.loads((Path(__file__).parent / "fixtures" / "location_keys.json").read_text(encoding="utf-8"))["cases"]
IDS = [case["label"] for case in CASES]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_location_key_matches_shared_fixture(case):
    assert location_key(case["city"], case["country"]) == case["slug"]


def test_nfd_city_still_finds_its_coordinates():
    nfd = unicodedata.normalize("NFD", "São Paulo")
    assert location_coords(nfd, "Brazil") == location_coords("São Paulo", "Brazil") is not None


@pytest.fixture
def place_client(app, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(database, "SessionLocal", app.state.testing_session)
    monkeypatch.setattr(safety, "SessionLocal", app.state.testing_session)
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    scan: list[dict] = []
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: list(scan))
    with TestClient(app) as client:
        owner = register(client, "alice", "alice@example.com")

        def add_post(location: dict):
            post = make_post(app, owner["id"], "place", media_type="image", location=location)
            scan.append(scan_item(post, 1000))
            invalidate_reel_records()
            return post

        yield client, add_post


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_location_feed_lists_post_for_every_key_form(place_client, case):
    client, add_post = place_client
    post = add_post({"city": case["city"], "country": case["country"]})

    catalog = client.get("/api/reels/locations").json()["locations"]
    assert [row["slug"] for row in catalog] == [case["slug"]]

    link_key = case.get("client_slug") or case["slug"]
    for key in {case["slug"], link_key, unicodedata.normalize("NFD", link_key)}:
        response = client.get("/api/reels/locations/" + quote(key, safe=""), params={"codec": "all"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert [video["path"] for video in body["videos"]] == [post.media_path], key
        assert body["location"]["slug"] == case["slug"]
        assert body["location"]["reel_count"] == 1
