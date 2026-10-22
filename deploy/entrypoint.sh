#!/bin/sh
# Container entrypoint: migrate, then serve with exactly one uvicorn worker.
# One worker is required: JobManager and the staged-upload registries live in
# process memory, so a second worker would split jobs between processes.
set -eu

cd /app

# compose waits for the postgres healthcheck, but retry briefly anyway so a
# slow first boot or a restarted database does not crash-loop the app.
attempt=1
until alembic upgrade head; do
    if [ "$attempt" -ge 10 ]; then
        echo "entrypoint: alembic upgrade head failed after $attempt attempts" >&2
        exit 1
    fi
    echo "entrypoint: migration attempt $attempt failed; retrying in 3s" >&2
    attempt=$((attempt + 1))
    sleep 3
done

# --proxy-headers + --forwarded-allow-ips='*': the only peer is cloudflared on
# the compose network (host port 8000 is bound to 127.0.0.1), so trusting
# X-Forwarded-* from any peer is safe here.
# --no-access-log: server/observability.py writes one sx.access line per
# request (with its request ID, without the client IP) instead.
# --timeout-keep-alive 150: the proxy, not uvicorn, must be the side that
# closes an idle keep-alive connection. With uvicorn's default of 5 s, a
# request the proxy sends on a pooled connection just as uvicorn closes it gets
# "connection reset by peer", and neither proxy retries a POST, so the client
# sees a 502. 150 s is above cloudflared's originRequest keepAliveTimeout
# (default 90 s, production) and Caddy's reverse_proxy keepalive (default 2m,
# local staging). Raise it if either proxy's idle timeout is raised.
exec uvicorn server.app:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1 \
    --proxy-headers \
    --forwarded-allow-ips='*' \
    --no-access-log \
    --timeout-keep-alive 150 \
    --timeout-graceful-shutdown 20
