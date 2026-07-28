FROM python:3.12-slim

WORKDIR /app

# ffmpeg provides both ffmpeg and ffprobe, which the pipeline shells out to.
# Note: this image has no VapourSynth/znedi3, so the "Studio" upscale engine is
# unavailable inside the container. The app detects this and disables it with an
# explanation; the "Fast" engine works normally.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8501/_stcore/health')"

CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0"]
