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
#
# Regression tests live in ../tests/ (run with `make test`).
