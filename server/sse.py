"""Shared SSE progress-stream generator for the image/video job routers.

Both routers previously carried a byte-identical copy of this generator
(server/routers/image.py and video.py) which had also drifted from what the
frontend expects: it sent a `new_messages` delta key while
`web/src/components/ui/Progress.jsx` reads `job.messages`, so the live
message log never actually populated. This version sends the full message
list each tick — messages are capped at `MAX_LOG_LINES` (see server/jobs.py)
so that stays small — which matches the frontend's `useSSE` contract of
`{status, phase, progress, elapsed, messages, result, error}`.
"""

import asyncio
from typing import AsyncIterator

from fastapi import Request

from server.jobs import JobRecord

_POLL_INTERVAL_S = 0.5
_PING_EVERY_N_TICKS = 20  # ~10s at the default poll interval


async def job_progress_stream(request: Request, rec: JobRecord) -> AsyncIterator[dict]:
    """Yield SSE frames for *rec* until it reaches a terminal state.

    Stops early if the client disconnects, and sends a periodic comment-only
    ping so intermediary proxies/tunnels don't time out an idle connection.
    """
    ticks = 0
    while True:
        if await request.is_disconnected():
            break

        with rec._lock:
            status = rec.status.value
            data = {
                "status": status,
                "phase": rec.phase,
                "progress": rec.progress,
                "elapsed": rec.elapsed,
                "messages": list(rec.messages),
                "result": rec.result,
                "error": rec.error,
            }

        yield {"data": data}

        if status in ("complete", "failed"):
            break

        ticks += 1
        if ticks % _PING_EVERY_N_TICKS == 0:
            yield {"comment": "keep-alive"}

        await asyncio.sleep(_POLL_INTERVAL_S)
