# Multi-stage build: Node compiles the React app, Python serves it.
# Production topology (one VPS, compose.yaml, Cloudflare Tunnel): docs/deploy-runbook.md

# Base images are pinned by digest so a rebuild cannot silently pick up a new
# OS or runtime. Dependabot's docker ecosystem proposes the bumps.
FROM node:22-slim@sha256:a6385bc33f0f9d6a08482c87f52baee537a9184e2b47dea1ed97caac62f8960c AS web-build
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
RUN npm run build

FROM python:3.12-slim@sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ffmpeg provides both ffmpeg and ffprobe, which the pipeline shells out to.
# Note: this image has no VapourSynth/znedi3, so the "Studio" upscale engine is
# unavailable inside the container. The app detects this and disables it with an
# explanation; the "Fast" and "FAL AI" engines work normally.
# procps provides `ps` for checking ffmpeg niceness in production.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Every call site runs bare `ffmpeg` via PATH; /usr/local/bin wins over
# /usr/bin, so all encodes run under nice (SX_FFMPEG_NICE, default 10) and
# web/SSE/Postgres keep CPU priority on the shared box.
COPY deploy/ffmpeg-nice.sh /usr/local/bin/ffmpeg
RUN chmod 0755 /usr/local/bin/ffmpeg

COPY requirements.txt .
RUN pip install -r requirements.txt && rm requirements.txt

# Non-root runtime user. /app/data and /app/output are pre-created and owned
# by it so fresh named volumes mounted there inherit the ownership.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home app \
    && mkdir -p /app/data /app/output \
    && chown app:app /app/data /app/output

# Allowlist: only the runtime trees. Tests, docs, scripts, video/, local
# state and secrets never enter the image.
COPY server/ server/
COPY core/ core/
COPY pipeline/ pipeline/
COPY migrations/ migrations/
COPY alembic.ini .
# The server reads only ui/assets (server/routers/reels.py, compare.py); the
# old Streamlit modules next to it stay out of the image.
COPY ui/assets/ ui/assets/
# Read at runtime by server/routers/reels.py: player icon SVGs and the Earth
# texture directory (web/public/assets).
COPY web/src/components/icons/svg/ web/src/components/icons/svg/
COPY web/public/assets/ web/public/assets/
# Stage the built React app where server/app.py expects it (server/static).
COPY --from=web-build /src/dist server/static
COPY deploy/entrypoint.sh /usr/local/bin/sx-entrypoint
RUN chmod 0755 /usr/local/bin/sx-entrypoint

# Sentry release tag; pass --build-arg GIT_SHA=$(git rev-parse HEAD).
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/healthz', timeout=4)"

ENTRYPOINT ["/usr/local/bin/sx-entrypoint"]
