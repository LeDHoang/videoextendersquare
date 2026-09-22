"""Phase Z0 (docs/earth-zoom-map-plan.md): map tile proxy regression tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routers import map_tiles


FAKE_TILE_PNG = (
    b"\x89PNG\r\n\x1a\n"  # PNG magic
    + bytes(range(256)) * 8  # deterministic 2 KB body
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MAP_TILES_CACHE_DIR", str(tmp_path / "tiles"))
    monkeypatch.setenv("SX_MAP_TILES_ENABLED", "1")
    app = FastAPI()
    app.include_router(map_tiles.router)
    with map_tiles._rate_lock:  # isolate per-IP fetch budget between tests
        map_tiles._rate_hits.clear()
    with TestClient(app) as test_client:
        test_client.fetch_calls = []
        yield test_client


def _stub_upstream(test_client, data: bytes = FAKE_TILE_PNG, content_type: str = "image/png"):
    def fake_fetch(url: str):
        test_client.fetch_calls.append(url)
        return data, content_type

    return fake_fetch


def test_tile_fetch_caches_and_serves_attribution(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    first = client.get("/api/reels/map-tiles/3/4/2.png")
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/png"
    assert "immutable" in first.headers["cache-control"]
    assert first.headers["x-map-attribution"] == map_tiles.OSM_ATTRIBUTION_HEADER
    assert first.content == FAKE_TILE_PNG
    assert client.fetch_calls == ["https://tile.openstreetmap.org/3/4/2.png"]

    # Second request: disk cache hit — upstream never called again.
    second = client.get("/api/reels/map-tiles/3/4/2.png")
    assert second.status_code == 200
    assert second.content == FAKE_TILE_PNG
    assert len(client.fetch_calls) == 1

    # Cache file layout is {z}/{x}/{y}.png under the configured dir.
    cached = map_tiles._tile_cache_path(3, 4, 2)
    assert cached.is_file()
    assert str(map_tiles._cache_dir()).endswith("tiles")


def test_custom_upstream_template_used(client, monkeypatch):
    monkeypatch.setenv("SX_MAP_TILES_URL", "https://tiles.example.com/{z}-{x}-{y}.webp?key=abc")
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    response = client.get("/api/reels/map-tiles/1/1/0.png")
    assert response.status_code == 200
    assert client.fetch_calls == ["https://tiles.example.com/1-1-0.webp?key=abc"]


@pytest.mark.parametrize(
    "path",
    [
        "/api/reels/map-tiles/18/0/0.png",      # zoom above MAX_ZOOM
        "/api/reels/map-tiles/-1/0/0.png",      # negative zoom
        "/api/reels/map-tiles/2/4/0.png",       # x == 2^z (out of range)
        "/api/reels/map-tiles/0/0/1.png",       # y out of range at z0
        "/api/reels/map-tiles/abc/0/0.png",     # non-integer (FastAPI 422)
    ],
)
def test_invalid_tile_coords_rejected(client, monkeypatch, path):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    response = client.get(path)
    assert response.status_code in (400, 422)
    assert client.fetch_calls == []


def test_boundary_tiles_accepted(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    assert client.get("/api/reels/map-tiles/0/0/0.png").status_code == 200
    assert client.get("/api/reels/map-tiles/17/131071/131071.png").status_code == 200


def test_disabled_flag_returns_404(client, monkeypatch):
    monkeypatch.setenv("SX_MAP_TILES_ENABLED", "0")
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    response = client.get("/api/reels/map-tiles/3/4/2.png")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MAP_TILES_DISABLED"
    assert client.fetch_calls == []


def test_upstream_failure_is_502_never_500(client, monkeypatch):
    def broken_fetch(url: str):
        client.fetch_calls.append(url)
        raise map_tiles.UpstreamTileError("upstream unreachable: boom")

    monkeypatch.setattr(map_tiles, "_fetch_upstream", broken_fetch)
    response = client.get("/api/reels/map-tiles/5/16/10.png")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "MAP_TILE_UPSTREAM_FAILED"
    assert response.headers["retry-after"] == "5"
    # Failed fetch must not poison the cache.
    assert not map_tiles._tile_cache_path(5, 16, 10).exists()


def test_upstream_non_image_rejected(client, monkeypatch):
    monkeypatch.setattr(
        map_tiles, "_fetch_upstream", _stub_upstream(client, data=b"<html>rate limited</html>", content_type="text/html")
    )
    response = client.get("/api/reels/map-tiles/4/8/8.png")
    assert response.status_code == 502
    assert not map_tiles._tile_cache_path(4, 8, 8).exists()


def test_fetch_rate_limit_counts_misses_only(client, monkeypatch):
    monkeypatch.setattr(map_tiles, "_fetch_upstream", _stub_upstream(client))
    monkeypatch.setattr(map_tiles, "RATE_LIMIT_COUNT", 5)
    # Prime one tile into the cache.
    assert client.get("/api/reels/map-tiles/0/0/0.png").status_code == 200
    # Cache hits are free regardless of budget.
    for _ in range(10):
        assert client.get("/api/reels/map-tiles/0/0/0.png").status_code == 200
    # Burn the remaining budget with unique tiles (upstream misses).
    for i in range(4):
        assert client.get(f"/api/reels/map-tiles/1/{i % 2}/{i // 2}.png").status_code == 200
    blocked = client.get("/api/reels/map-tiles/2/3/3.png")
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "MAP_TILE_RATE_LIMITED"
    # Cached tiles still serve while rate-limited.
    assert client.get("/api/reels/map-tiles/0/0/0.png").status_code == 200


def test_attribution_route(client, monkeypatch):
    response = client.get("/api/reels/map-tiles/attribution")
    assert response.status_code == 200
    payload = response.json()
    assert payload["attribution"] == map_tiles.OSM_ATTRIBUTION
    assert payload["enabled"] is True
    assert payload["max_zoom"] == map_tiles.MAX_ZOOM
    monkeypatch.setenv("SX_MAP_TILES_ENABLED", "0")
    assert client.get("/api/reels/map-tiles/attribution").json()["enabled"] is False

