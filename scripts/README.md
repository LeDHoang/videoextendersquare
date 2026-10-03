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
#   verify_*.cjs       — live-endpoint verification probes (see docs/threejs-
#                        vr-implementation-plan.md §7.2)
#   dev/               — one-off paid-API / hardware experiment scripts, NOT
#                        collected by pytest (deliberately not named test_*):
#                          dev/ltx_lora_debug_job.py    — real fal.ai LoRA job (~$0.01)
#                          dev/vpy_znedi3_experiment.py — local VapourSynth/znedi3 test
#
# Regression tests live in ../tests/ (run with `make test`).
