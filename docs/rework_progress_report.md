# Rework Review — Progress Report

Companion to the review/plan at `C:\Users\hleduc\.claude\plans\i-have-rework-this-glowing-walrus.md`. This file tracks what's actually been changed in the repo, what's still open, and how to verify each change once you're in an environment where `bash`/`python`/`npm` actually run.

**Nothing in this report has been executed or tested.** The session that made these changes had a non-functional shell (even `echo hello` hung indefinitely — traced to a missing `/usr/local/etc/profile.global`), so every fix below was verified by reading, not by running the app. Treat this as "should be correct" pending your first real run.

---

## 1. What's done

### 1.1 Concurrency — the headline fix

**Files:** `server/jobs.py`, `pipeline/video_worker.py`, `pipeline/image_worker.py`, `server/app.py`

- Removed `_RUN_LOCK`, the process-wide lock that serialized **every** job to one-at-a-time regardless of the thread pool sizes. It was justified by a comment claiming both workers wrote to a "fixed shared temp path" — that was already false (every intermediate is `uuid4()`-suffixed).
- Before removing the lock, fixed the one *real* race it happened to also be masking: both workers did `os.environ["FAL_KEY"] = fal_key` from a worker thread — global mutable state, unsafe with concurrent jobs using different keys. Replaced with a per-call `fal_client.SyncClient(key=fal_key)`.
- `_ENCODER_CACHE` (the HEVC encoder probe) is now guarded by a lock and pre-warmed once at FastAPI startup (`lifespan` in `server/app.py`), so concurrent jobs don't all race to spawn the same 4-way ffmpeg smoke-test.
- Pool sizes are now CPU-aware (`_default_pool_sizes()` in `jobs.py`), mirroring the clamp already used in `ui/runner.py`, instead of hardcoded `4`/`2`.

**Why it matters:** previously an image job would queue behind a 20-minute video encode even though nothing forced that. Jobs should now run genuinely in parallel up to the pool limits.

### 1.2 SSE progress stream — real bug fix + de-duplication

**Files:** new `server/sse.py`; `server/routers/image.py`, `server/routers/video.py`

- The two routers had byte-identical SSE generators that sent a payload key `new_messages`, but the frontend (`Progress.jsx`) reads `job.messages`. **The live progress log was silently broken** — it never populated during a running job. Fixed by sending the full (now-capped) message list each tick.
- Extracted one shared generator (`server/sse.py: job_progress_stream`) used by both routers instead of the duplicated code.
- Added client-disconnect detection (`request.is_disconnected()`) and a periodic keep-alive comment frame, so idle tunnels/proxies don't time out the connection.

### 1.3 Correctness fixes

- **`server/app.py`**: added `load_dotenv()` — the FastAPI app never loaded `.env`, so `FAL_KEY` in `.env` was invisible unless exported in the shell or set via the sidebar.
- **`server/jobs.py`**: capped `messages` per job at `MAX_LOG_LINES = 200` (previously unbounded); added a periodic cleanup task (`_cleanup_loop` in `server/app.py`, every 15 min) that calls `job_manager.cleanup_old()` and evicts stale staged uploads.
- **`server/routers/{image,video}.py`**: `STAGED_UPLOADS` now stores `(path, timestamp)` instead of just `path`, with a `cleanup_stale_uploads()` (6h TTL) that deletes the temp file too. Previously these entries — and the temp files behind them — were never evicted despite the 400 error text saying "expired".
- **`batch_upscale.py`**: fixed a broken tuple-unpack (`_, upscaled_local = process_video(...)`) that always raised (silently swallowed by a broad `except`) because `process_video` actually returns `((outpaint_url, path), metrics)`.
- **`pipeline/video_worker.py`** — `poll_job_status`: now has a 30-minute timeout and raises on a `Failed`/`Error` terminal status instead of spinning forever (previously an unbounded `while True`, which — pre-lock-removal — could wedge the whole server via `_RUN_LOCK`, and still leaks a thread forever post-removal without this fix).
- **`pipeline/video_worker.py`** — STUDIO engine: replaced the `["sh", "-c", "'vspipe' ... | ffmpeg ..."]` shell-string pipeline with two `subprocess.Popen`s connected directly (no shell, no string interpolation of paths). This:
  - Makes STUDIO runnable on Windows without Git Bash on PATH (the shell command needed `sh`).
  - Removes a quote-injection risk (a filename containing `'` could break out of the interpolated shell string).
  - **Now honors your `sharpening` slider** instead of a hardcoded `cas=0.5`.
  - Streams ffmpeg stderr to a temp log file instead of buffering a multi-hour encode's stderr in RAM (`capture_output=True`).
- **`pipeline/video_worker.py`** — `libx265` HEVC candidate: removed the contradictory `-b:v/-maxrate/-bufsize` alongside `-crf 24` (CRF was silently winning; the caps were dead weight in the command).

### 1.4 Frontend fixes

- **Fixed a visible CTA rendering bug.** `Button` piped its `children` through `Emoji`, which did `String(text)` — so the RENDER buttons (which pass 3 JSX children) rendered as `▶ RENDER ,3, VIDEO(S) 4K SQUARE` (literal commas from `Array.toString()`).
- **Removed the `twemoji` dependency entirely.** Every call site passes plain ASCII/unicode glyphs (`"Image"`, `"↓ DOWNLOAD MASTER"`, `"✓ COMPLETE"`) — none of it is emoji-presentation text, so twemoji matched nothing. It cost bundle weight and ran `dangerouslySetInnerHTML` for no benefit. `web/src/components/ui/Emoji.jsx` is now a plain passthrough (`<span>{text}</span>`), which also fixes the comma bug above by construction (arrays of React children render fine; only `String()` mangles them). Removed from `web/package.json` and the `.emoji` CSS rule from `global.css`.
- **Fixed the blob URL leak.** `ImagePage.jsx`/`VideoPage.jsx` called `URL.createObjectURL(items[0].file)` directly in the render body — leaking a blob on every re-render, never revoked. New hook `web/src/hooks/useObjectUrl.js` creates it in an effect and revokes on cleanup/file change.
- **De-duplicated `/api/health` polling.** `useHealth()` previously ran independently in `AppShell` *and* in `ImagePage`/`VideoPage` — two 8s intervals per page. New `web/src/hooks/HealthContext.jsx` provides one shared poller mounted once in `AppShell`; `ImagePage`/`VideoPage` now consume `useHealthContext()`. The old `web/src/hooks/useHealth.js` is now unreferenced (left in place — see §3).
- **Fixed the config-state desync.** `Sidebar.jsx` used to call `api.put(...)` directly for the FAL key and model endpoints, bypassing `useConfig()`'s state — so the sidebar and the rest of the app could disagree about what was saved. It now uses `setFalKey`/`setModels` from `useConfig()` (lifted into `AppShell`), which is the same state everything else reads.
- **Added an error boundary.** There was none anywhere; one bad SSE frame (e.g. a missing `status` field) would unmount the whole app. New `web/src/components/ErrorBoundary.jsx` wraps `<Outlet/>` in `AppShell`, resetting when the route changes. Also hardened `Progress.jsx`'s `status.toUpperCase()` against a missing/undefined status.
- **Fixed a false-positive SSE error.** `useSSE.js` used to set a permanent "SSE connection lost" error on *any* `onerror`, even though `EventSource` auto-reconnects on its own. Now it waits ~6s for a reconnect before surfacing an error, and clears any error as soon as a frame arrives or the connection reopens.
- **Removed dead code**: unused `Nav`/`setFalKey`/`setModels` imports in `AppShell.jsx` (now actually used), unused `Rule` import in `Sidebar.jsx`, unused `Emoji` import in `UploadZone.jsx`, unused `Field` import in `ImagePage.jsx`. Also fixed the empty `<Field label="">` for the FAL key input (now labeled).

---

## 2. What's still open

Nothing below has been touched. Ordered roughly by value, per the original plan:

| # | Item | Files |
|---|---|---|
| 1 | **Redundant re-encodes** — FAST-path videos get re-encoded 2-3× (fal result → 4K master → H.264 proxy) even when the source is already square/4K; unconditional `scale=3840:3840` stretches non-square inputs mid-pipeline; trim re-encodes instead of stream-copying | `pipeline/video_worker.py` |
| 2 | **ffprobe codec-probe storm** on every `/api/reels` call (2 probes/video, uncached) | `server/routers/reels.py` |
| 3 | **Streaming uploads** instead of fully buffering into RAM | `server/routers/{image,video}.py`, `server/media.py` |
| 4 | **Guardrails**: upload size cap + extension allowlist, staging-dir extension-traversal fix, Reels `</script>` stored-XSS escape, moving logs out of the `/media`-exposed `output/` dir, bounding `POST /api/reels/proxy`, validating the 20 video form fields (Pydantic model), scheme/timeout/size-cap on the fal.ai URL fetches | `server/routers/{reels,image,video}.py`, `server/media.py`, `pipeline/{video,image}_worker.py` |
| 5 | **Streamlit/FastAPI duplication extraction** into a shared module (`PHASES`/`_classify`, health probes, `HEVC_CANDIDATES` — which have already drifted between `video_worker.py` and `ui/health.py` — ffms2/vspipe path discovery) and inverting the `server/app.py` → `ui.health` import direction | new `core/` (or similar), `ui/health.py`, `ui/runner.py`, `server/routers/health.py` |
| 6 | **Leak-safe cleanup on failure.** `process_video`'s intermediate cleanup only runs on the success path; an exception mid-encode leaks the trimmed/outpainted temp files. This needs the whole engine-dispatch block wrapped in `try/finally` — I stopped short of this because it's a large re-indent of a ~230-line block and I had no way to test the result | `pipeline/video_worker.py` |
| 7 | **Single source of truth for models/pricing.** `VideoPage.jsx` hardcodes model IDs and pricing that duplicate the backend's `_model_config`, so the sidebar's model-endpoint editor has no effect on what's actually submitted | `web/src/pages/VideoPage.jsx`, `server/routers/config.py` |
| 8 | **Code splitting** — all four pages are eagerly imported; convert to `React.lazy`/`Suspense` | `web/src/App.jsx` |
| 9 | **Full visual rework** (Phase 9 of the plan) — expanded design tokens (semantic colors, fonts, motion, z-index scale, corrected `--sx-ink-3` contrast), layout/hierarchy rework, a real mobile pattern, motion + reduced-motion, accessibility (focus-visible, keyboard-reachable upload zone, ARIA on the dropdown/progress bar/labels, skip link) | `web/src/styles/*.css`, most of `web/src/components/` and `web/src/pages/` |
| 10 | Un-committing `web/dist/`, `server/static/`, `web/node_modules/` from git; `.streamlit/credentials.toml` | `.gitignore` |
| 11 | Delete the now-orphaned `web/src/hooks/useHealth.js` (nothing imports it anymore — I couldn't delete it because the shell was broken; `Write`-ing an empty/stub file didn't seem worth it either, so it's just sitting there unused) | `web/src/hooks/useHealth.js` |

---

## 3. Known loose end

`web/src/hooks/useHealth.js` is dead code (superseded by `HealthContext.jsx`) but is still on disk because I couldn't run `rm`. It's harmless — nothing imports it, so it won't be bundled — but delete it during cleanup:

```
rm web/src/hooks/useHealth.js
```

---

## 4. How to verify what's done, once bash works

### 4.1 Setup

```bash
python -m venv venv2   # or reuse venv/ if you trust its state — decide before overwriting
source venv2/bin/activate        # or venv2\Scripts\activate on Windows cmd, venv2\Scripts\Activate.ps1 in PowerShell
pip install -r requirements.txt

cd web
npm install
cd ..
```

Sanity-check the install:
```bash
python -c "import fal_client; print(fal_client.SyncClient)"   # confirms fal_client version has SyncClient
ffmpeg -version
ffprobe -version
```

### 4.2 Run it

```bash
# Terminal 1
uvicorn server.app:app --reload --port 8000

# Terminal 2
cd web && npm run dev
```

Open `http://localhost:5173`.

### 4.3 Targeted checks, mapped to what changed

| Change | How to verify |
|---|---|
| Concurrency unlock | Submit 2-3 image jobs and a video job at roughly the same time (multi-file upload works for this). Watch the server logs / job timestamps — they should now overlap instead of running strictly one-after-another. Compare wall-clock against what you remember pre-change if you have a baseline. |
| SSE `messages` fix | Start a video job and watch the progress panel in the UI *while it runs* (not just at completion) — the scrolling message log under the progress bar should populate live. Previously this stayed empty until the job finished. |
| `_ENCODER_CACHE` pre-warm | On server startup, you should see the encoder-probe ffmpeg processes spawn once at boot (check Task Manager / `ps` briefly after `uvicorn` starts) rather than on the first job submission. |
| `load_dotenv()` | Put `FAL_KEY` only in `.env` (not in your shell env, not via the sidebar), start the server fresh, and confirm `/api/config` reports `fal_key_set: true` and a render actually works. |
| Cleanup loop | Submit a job, let it complete, then either wait 15 min or temporarily lower `_CLEANUP_INTERVAL_S` in `server/app.py` to something short (e.g. `5`) and `job_manager.cleanup_old`'s `max_age_seconds` default (3600) similarly, restart, and confirm the completed job's record disappears from an internal listing (there's no admin endpoint for this — you'd need to add a quick `print(job_manager._jobs)` or a debugger breakpoint, since `list_jobs()` still isn't exposed as a route). |
| `batch_upscale.py` fix | Drop a couple of test clips in `output/pairs/`, run `python batch_upscale.py`, confirm both `_fast.mp4` and `_studio.mp4` are produced without the "Error in Fast upscale" message. |
| `poll_job_status` timeout | Hard to trigger deliberately without a real stuck fal.ai job — treat as code-review-verified only unless you have a way to simulate a hung remote job. |
| STUDIO engine (no-shell + sharpening) | Requires VapourSynth + znedi3 installed. Run a video job with `engine=STUDIO` and a non-zero sharpening value; confirm it completes on Windows *without* Git Bash on PATH, and that the visible sharpening in the output changes when you change the slider (previously it was always `0.5` regardless of the UI value). |
| `libx265` rate control | Only observable if your machine's only available HEVC encoder is `libx265` (i.e. no `hevc_videotoolbox`/`hevc_nvenc`/`hevc_qsv`). Check `/api/health`'s reported encoder, or just diff the ffmpeg command logged/printed during a FAST-engine render. |
| CTA comma bug | Look at the "▶ RENDER N VIDEO(S)/IMAGE(S) 4K SQUARE" buttons on `/image` and `/video` after selecting files — should read cleanly, no `,3,`. |
| twemoji removal | `grep -r twemoji web/src` should return nothing; check `web/node_modules/twemoji` is gone after a fresh `npm install` (it will still exist until you reinstall, since `package-lock.json` may need updating too — run `npm install` again after pulling and confirm `package.json` no longer lists it). |
| Blob leak fix | Open browser DevTools → Memory, upload a video, and watch that navigating away / re-uploading doesn't accumulate `blob:` URLs indefinitely. Simpler: confirm the video preview still plays correctly after uploading, since behavior should be unchanged, just non-leaking. |
| Health polling dedup | DevTools → Network tab, filter on `/api/health`, sit on `/image` or `/video` for ~30s — should see one request roughly every 8s, not two. |
| Sidebar config desync fix | Set a FAL key via the sidebar, confirm the health dot updates immediately (calls `health.refresh()`), and that the key persists correctly on reload. Edit a model endpoint, save, reload the page, confirm it stuck. |
| Error boundary | Hard to trigger without deliberately breaking a response — treat as code-review-verified, or temporarily throw inside `Progress.jsx` to confirm the boundary catches it and the rest of the shell (sidebar/nav) stays interactive. |
| SSE false-error fix | Throttle network in DevTools briefly during a running job and confirm it doesn't immediately flash "SSE connection lost" — should tolerate a short blip. |

### 4.4 Regression pass (functionality must be unchanged)

Since the intent throughout was zero functional regressions, also re-walk the baseline flows:

1. Image upload → configure → render (FAST and FAL AI engines) → download.
2. Video upload → configure → render (FAST, FAL AI, and STUDIO if available) → download master + H.264 proxy.
3. Batch upload (multiple files) on both pages.
4. Compare page — FAST vs STUDIO pair, proxy generation.
5. Reels page — player loads, playback works, on Quest 3 if you have one available.
6. Streamlit fallback (`streamlit run app.py`) still runs independently.

---

## 5. Suggested order for the next session

1. Get it running and walk §4.4 first — confirm nothing broke before trusting any of the "fixed" claims above.
2. Work through §4.3 to actually confirm each fix behaves as intended (not just "doesn't crash").
3. Then continue down the "still open" list in §2 — items 1-3 (redundant encodes, ffprobe storm, streaming uploads) are independent and low-risk; item 4 (guardrails) next; item 9 (visual rework) is the largest and most subjective, so probably last and worth pausing for your sign-off on direction (colors, mobile pattern) before I touch two dozen files.
