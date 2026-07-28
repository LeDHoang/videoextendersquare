# Square Extender 4K

Converts images and videos to a 1:1 square 4K master (3840×3840) by generatively
outpainting the short edge via [fal.ai](https://fal.ai), then upscaling locally
with FFmpeg.

```
UPLOAD  →  CONFIGURE  →  RESULT
```

## Requirements

- **Python 3.12** — must be an **x64** build. ARM64 Windows has no prebuilt
  wheels for Streamlit's `pyarrow`/`httptools` dependencies, and building them
  from source needs a C/C++ toolchain. An x64 interpreter runs fine under
  Windows' emulation and gets the full wheel ecosystem.
- **FFmpeg** (with `ffprobe`) — used for metadata, upscaling, and encoding.

```bash
python -m venv venv
venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
venv/Scripts/python.exe -m streamlit run app.py
```

Open http://localhost:8501.

### FFmpeg discovery

The app locates FFmpeg at startup and prepends it to `PATH` in-process, so it
works even when your shell can't see it (e.g. right after `winget install
Gyan.FFmpeg`, before the shell restarts). It searches, in order:

1. `SX_FFMPEG_DIR` or `FFMPEG_DIR` from the environment / `.env`
2. `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin`
3. `C:\ffmpeg\bin`, `C:\Program Files\ffmpeg\bin`
4. `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`

If none match, set `FFMPEG_DIR` in `.env`. The sidebar **SYSTEM** panel reports
what was found.

### Configuration

Copy `.env.example` to `.env` and set `FAL_KEY`. The key is only needed for
outpainting — **UPSCALE ONLY** mode runs entirely locally. `.env` is gitignored;
never commit it.

## Modes

| | Needs `FAL_KEY` | What it does |
|---|---|---|
| **OUTPAINT + UPSCALE** | yes | Generatively fills the padding, then upscales to 4K |
| **UPSCALE ONLY** | no | Skips the cloud entirely; local upscale only |

### Upscale engines (video)

- **FAST** — FFmpeg Lanczos4 + CAS sharpening. Always available.
- **STUDIO** — VapourSynth `znedi3` neural luma reconstruction. Requires
  VapourSynth, `vspipe` on `PATH`, and the `znedi3` plugin. The UI disables this
  and explains what's missing when it can't run.

The video master is **HEVC**, which most browsers cannot decode, so the player
shows a generated H.264 proxy and the master is offered as a download.

## Compare

The Compare page A/B's a FAST vs STUDIO render of the same source with a drag
slider. It scans `output/pairs/` for `<stem>_fast.mp4` + `<stem>_studio.mp4`
pairs — generate them with `batch_upscale.py`. Media is served by a loopback
HTTP server started automatically on an ephemeral port (no manual
`python -m http.server` needed).

## Architecture

```
app.py                  entrypoint: page config, PATH heal, theme, navigation
.streamlit/config.toml   native theme tokens + web font faces
ui/
├─ tokens.py             design tokens mirrored for Python
├─ theme.py              CSS injection
├─ assets/app.css        all custom CSS
├─ assets/compare.html   compare-slider template
├─ components.py         editorial primitives (hero, rules, stat rows, blocks)
├─ state.py              namespaced session_state + step flow
├─ health.py             PATH self-heal + environment probes
├─ media.py              upload staging, metadata, result persistence, proxies
├─ runner.py             st.status execution wrapper
├─ mediaserver.py        loopback media server
├─ sidebar.py            API key + SYSTEM panel
└─ views/                image_view, video_view, compare_view
pipeline/                unchanged processing core (fal.ai + FFmpeg)
```

`pipeline/` is treated as a fixed API; the UI layer never changes its function
signatures.

## Maintenance notes

- **After upgrading Streamlit**, check the `FRAGILE` block at the bottom of
  `ui/assets/app.css`. Those rules target internal `data-testid` attributes,
  which are not a public API and have changed across minor releases. They are
  scoped and written so that failure is cosmetic only.
- **Web fonts must be declared as `[[theme.fontFaces]]`** in
  `.streamlit/config.toml`. Streamlit strips `<link>` tags from `st.markdown`
  and relocates injected `<style>` blocks, so neither a `<link>` nor an
  `@import` will ever fetch a font.
- **Concurrent renders are serialized** by a process-wide lock. The pipeline
  workers write to a fixed shared temp path and unlink it at run start, so two
  simultaneous renders would corrupt each other. Results are moved to a
  per-session directory the moment a worker returns.
