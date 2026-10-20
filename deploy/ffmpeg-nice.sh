#!/bin/sh
# Installed as /usr/local/bin/ffmpeg in the image (ahead of /usr/bin on PATH).
# Every pipeline call site runs bare `ffmpeg`, so encodes run at lower CPU
# priority than uvicorn (web/SSE) and Postgres on the shared VPS.
exec nice -n "${SX_FFMPEG_NICE:-10}" /usr/bin/ffmpeg "$@"
