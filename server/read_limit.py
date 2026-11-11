"""A concurrency limit for the heavy list routes.

Those routes are CPU-bound Python, and the app is one process, so running many
of them at once only makes them take turns on the GIL: on the VPS /api/reels
fell from 6.1 rps at one connection to 4.7 at ten
(docs/perf-probes/2026-11-11/bottlenecks.md). A request waits for a slot on
the event loop, where it holds no thread, so light routes and uploads are
never queued behind it. Everything else keeps the full thread pool.

Two slots: in the app image at ten connections /api/reels served 4.3 rps
with no limit, 10.7 with three slots, 12.5 with two and 14.7 with one. One
slot would let a single slow query hold up every other list request.
"""

from __future__ import annotations

import asyncio
import weakref

from fastapi import Depends

from server.settings import env_int

# One semaphore per event loop: tests start several loops in one process.
_slots: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


async def heavy_read_slot():
    loop = asyncio.get_running_loop()
    slots = _slots.get(loop)
    if slots is None:
        slots = _slots[loop] = asyncio.Semaphore(env_int("SX_HEAVY_READ_CONCURRENCY", 2, minimum=1))
    async with slots:
        yield


# scope="function": the slot is given back when the handler returns, not after
# a slow client has read the response.
HEAVY_READ = Depends(heavy_read_slot, scope="function")
