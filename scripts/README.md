# scripts/ — operational & development tooling
#
# R7 Earth Zoom headless-browser gate (2026-10-03): the reusable harness +
# stub tile server live in ../reports/ (gitignored one-off zone, kept with
# the captures they produced):
#   reports/earth-r7-harness.html  — loads the REAL bundle under SwiftShader
#     WebGL2 (?mode=globe|street & ?cam=orbit & ?earthstyle=raw); result JSON
#     in #r7result + document.title
#   reports/earth-r7-stub-server.py — stub tiles/activity on :8471
#     (.venv/bin/python reports/earth-r7-stub-server.py 8471)
#   headless Chrome: --headless=new --use-angle=swiftshader
#     --enable-unsafe-swiftshader --virtual-time-budget=25000
#     --screenshot=../logs/earth-r7-<mode>.png "<url>?mode=street&cam=orbit"
# Holo Atlas design harness (2026-10-04, same gitignored reports/ zone):
#   reports/earth-design-server.py 8472 — real OSM tiles + globe texture + sample zones
#   reports/earth-design-harness.html   — ?s=globe|hover|region|city|street|preview&cam=head|orbit
#   reports/earth-shot.sh <scenario> <cam> <tag> → logs/design-<tag>-<scenario>-<cam>.png
# Captures: ../logs/earth-r7-globe.png, earth-r7-street(-orbit,-raw).png.
# Headset (Quest HTTPS) gate remains blocked — no device on adb.
#
# Layout:
#   *.cjs              — Chrome DevTools Protocol probes (Quest Browser debugging,
#                        reels player live verification, WebXR emulation)
#                        plus metavr device rigs (debug-quest-square-capture.cjs:
#                        logcat + screenshot + diag + ovrgpuprofiler capture for
#                        the VR black-squares investigation — see docs/vr-black-
#                        squares-investigation.md §7.1)
#   *.py               — batch pipeline utilities (upscale/spatialize batches,
#                        fal playground, GPU keepalive). Each bootstraps
#                        sys.path to the repo root, so run from anywhere:
#                          .venv/bin/python scripts/batch_upscale.py
#                          .venv/bin/python scripts/batch_backfill_media_info.py
#                            (fills reel duration/size for posts whose media is on disk;
#                             the server also does this at startup and every 15 min)
#                          .venv/bin/python scripts/batch_stereo_mono.py [--dry-run]
#                            (builds missing left-eye 2D renditions + grid assets for
#                             stereo SBS/top-bottom posts; see docs/stereo-3d-reels.md)
#   verify_*.cjs       — live-endpoint verification probes (see docs/threejs-
#                        vr-implementation-plan.md §7.2)
#                          verify_staging.cjs — production-mode checks, backup/restore
#                            drill (--drill seed|check) and publish timing
#                            (--time-publish <file>); see docs/local-staging.md:
#                              node scripts/verify_staging.cjs
#   ../deploy/         — production deploy files (NOT dev tooling; see
#                        docs/deploy-runbook.md):
#                          entrypoint.sh  — container entrypoint (alembic upgrade head,
#                                           then one uvicorn worker)
#                          ffmpeg-nice.sh — installed as /usr/local/bin/ffmpeg in the image
#                          backup.sh      — host cron: pg_dump + avatars to private R2
#                                           (docs/backup-restore-runbook.md)
#                          env.example    — production .env template for compose.yaml
#                          compose.staging.yaml, Caddyfile.staging, env.staging.example
#                                         — free local staging overlay (SeaweedFS, Caddy,
#                                           Mailpit); docs/local-staging.md
#   dev/               — one-off paid-API / hardware experiment scripts, NOT
#                        collected by pytest (deliberately not named test_*):
#                          dev/ltx_lora_debug_job.py    — real fal.ai LoRA job (~$0.01)
#                          dev/vpy_znedi3_experiment.py — local VapourSynth/znedi3 test
#                          dev/experiment_fetch_city_photos.py — free Wikimedia Commons
#                            city photos → reports/city_photos/ (+ credits.json)
#                          dev/experiment_apply_city_photos.py — hardlink those photos over
#                            black <2 KB placeholder images in output/ (--relink-posts gives
#                            each slideshow post distinct photos; --dry-run previews)
#                          dev/experiment_seed_image_slideshow_posts.py — turn loose images
#                            in output/ into DB image posts, 1–4 same-city images each
#                            (run after `make migrate`; --dry-run previews)
#                          dev/experiment_stereo_threshold.py — local, $0: scores 2:1 / 1:2
#                            split-screen negatives built from output/testpipeline/ and the
#                            real SBS clips in output/testpipeline-3d/ with the stereo
#                            detector → reports/stereo-threshold/ (--keep keeps the clips)
#                          dev/experiment_stereo_tb.py — local, $0: builds top-bottom 3D fixtures
#                            (H.264, HEVC, WebM with stereo_mode, PNG still, plus negatives) from the
#                            SBS clips in output/testpipeline-3d/, eye-marked red (left) / blue (right),
#                            and scores them → reports/stereo-tb/ (--rebuild re-encodes)
#
# Regression tests live in ../tests/ (run with `make test`).

## ECHO design tokens outside the Vite app

`web/src/styles/tokens.css` is the source of truth. Two other surfaces carry a copy because they cannot import it:

- `ui/assets/reels.html`: an `html { --sx-* }` block at the top of the FIRST bare `<style>`. `server/routers/reels.py` extracts only that first block and `_scope_css` drops bare `html`/`body` rules, so the embedded player inherits the SPA's own tokens while the standalone page uses the copy.
- `ui/assets/vr_ui_canvas.js`: frozen `VRUICanvas.TOKENS` (`hex`, `font`, `space`, `radius`).

`web/tests/echo-token-parity.test.js` (run by `make test`) fails when either copy drifts from `tokens.css`. Change a token in `tokens.css` first, then update both copies.
