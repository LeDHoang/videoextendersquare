# scripts/ — operational & development tooling
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
