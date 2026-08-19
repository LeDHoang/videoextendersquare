# Multi-stage build: Node compiles the React app, Python serves it.

FROM node:22-slim AS web-build
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM python:3.12-slim

WORKDIR /app

# ffmpeg provides both ffmpeg and ffprobe, which the pipeline shells out to.
# Note: this image has no VapourSynth/znedi3, so the "Studio" upscale engine is
# unavailable inside the container. The app detects this and disables it with an
# explanation; the "Fast" and "FAL AI" engines work normally.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
# Stage the built React app where server/app.py expects it (server/static).
COPY --from=web-build /src/dist /app/server/static

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]