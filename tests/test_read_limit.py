"""The heavy list routes share a small number of slots (server/read_limit.py)."""
import asyncio
import sys
import threading
import time

import httpx
from fastapi import FastAPI

from server import read_limit

HEAVY_ROUTES = {
    "/api/reels",
    "/api/reels/feed",
    "/api/reels/player",
    "/api/reels/player-inline",
    "/api/reels/tags",
    "/api/reels/tags/{tag_name}",
    "/api/reels/locations",
    "/api/reels/locations/activity",
    "/api/reels/locations/{location_key}",
    "/api/search/suggestions",
}


def _depends_on_slot(route) -> bool:
    return any(dep.call is read_limit.heavy_read_slot for dep in route.dependant.dependencies)


def test_only_the_heavy_list_routes_take_a_slot():
    import server.app  # noqa: F401  (imports every router module)

    routers = [module.router for name, module in sys.modules.items() if name.startswith("server.routers.") and hasattr(module, "router")]
    limited = {route.path for router in routers for route in router.routes if hasattr(route, "dependant") and _depends_on_slot(route)}
    assert len(routers) > 10
    assert limited == HEAVY_ROUTES


def test_heavy_requests_queue_for_a_slot_and_light_ones_do_not(monkeypatch):
    monkeypatch.setenv("SX_HEAVY_READ_CONCURRENCY", "2")
    app = FastAPI()
    lock = threading.Lock()
    state = {"now": 0, "peak": 0}

    @app.get("/heavy", dependencies=[read_limit.HEAVY_READ])
    def heavy():
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        time.sleep(0.05)
        with lock:
            state["now"] -= 1
        return {"ok": True}

    @app.get("/light")
    def light():
        return {"busy": state["now"]}

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            heavy_calls = [asyncio.create_task(client.get("/heavy")) for _ in range(8)]
            await asyncio.sleep(0.02)
            seen = (await client.get("/light")).json()["busy"]
            responses = await asyncio.gather(*heavy_calls)
        return seen, responses

    seen, responses = asyncio.run(run())
    assert [response.status_code for response in responses] == [200] * 8
    assert state["peak"] == 2
    # The light request was answered while both slots were taken and six heavy requests waited.
    assert seen == 2


def test_a_failed_heavy_request_gives_its_slot_back(monkeypatch):
    monkeypatch.setenv("SX_HEAVY_READ_CONCURRENCY", "1")
    app = FastAPI()

    @app.get("/heavy", dependencies=[read_limit.HEAVY_READ])
    def heavy(fail: bool = False):
        if fail:
            raise RuntimeError("boom")
        return {"ok": True}

    async def run():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.get("/heavy", params={"fail": "true"})
            second = await asyncio.wait_for(client.get("/heavy"), timeout=2)
        return first.status_code, second.status_code

    assert asyncio.run(run()) == (500, 200)
