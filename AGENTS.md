# AGENTS.md — repo conventions for AI agents

Single source of truth for where generated files belong. Follow this on every task in this repository. (`.clinerules` mirrors the script-organization section for Cline.)

## Script & file placement (strict)

| What you created | Where it goes | Naming |
|---|---|---|
| Regression tests (pytest, run by `make test`) | `tests/` | `test_*.py` |
| Manual / paid-API / hardware experiment scripts | `scripts/dev/` | `debug_*.py` or `experiment_*.py` — **NEVER `test_*`** (pytest would collect them repo-wide; some spend real money, e.g. `scripts/dev/ltx_lora_debug_job.py`) |
| CDP / browser debug probes (Quest, reels player) | `scripts/` | `debug-*.cjs` |
| Live-endpoint verification probes | `scripts/` | `verify_*.cjs` |
| Batch pipeline utilities (upscale/spatialize/playground) | `scripts/` | `batch_*.py`, `*_playground.py` |
| One-off generated artifacts, captures, logs | `reports/` or `logs/` (both gitignored) | — |
| Documentation you write | `docs/` | kebab-case |

**Never create scripts or tests in the repository root.** The only root-level Python file is `app.py` (legacy Streamlit entrypoint, wired to `make streamlit`).

## Rules for generated scripts

1. Python scripts under `scripts/` that import `pipeline.*` or `server.*` MUST bootstrap the path right after stdlib imports:
   ```python
   import sys
   from pathlib import Path
   sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root
   ```
   (use `parents[2]` for files in `scripts/dev/`).
2. Never commit logs, captures, or generated media. `logs/`, `output/`, `input/`, `data/` are gitignored.
3. Scripts that call paid APIs (fal.ai) must print the estimated cost before running.
4. Verify scripts must be runnable from the repo root: `node scripts/<name>.cjs`, `.venv/bin/python scripts/<name>.py`.
5. After creating a debug/verify script, document its invocation in the relevant doc (`RUNNING.md`, or the VR plan §6/§7 for Quest/CDP probes) — see `scripts/README.md` for the layout map.

## Test conventions

- Backend suite: `make test` → `pytest -q tests` + `cd web && npm test`. Never widen pytest collection scope (no repo-wide `pytest` — it hits the user-owned `ComfyUI/` tree and hardware deps).
- Schema truth: `EXPECTED_SCHEMA_REVISION` in `server/social/database.py` (currently `20261020_0014`).
- Concurrency/billing tests must eventually run against PostgreSQL (launch verdict in `docs/to-beta.md`); SQLite-only green is not sufficient for billing paths.
- `tests/conftest.py` (shared fixtures only) points the global `SessionLocal` fallback at a throwaway DB, so tests never touch `data/echo.db`.
- One request, one pooled connection: helpers called from a route take the request `db` instead of opening `SessionLocal()` (guarded by `tests/test_db_pool_isolation.py`; set `SX_TEST_POSTGRES_URL` to run it on PostgreSQL).

## Key docs to consult before acting

- `docs/to-beta.md` — release blockers, infrastructure verdicts, beta feature scope
- `RUNNING.md` — env flags, Stripe setup, deployment
- `docs/todolist.md` — roadmap phases (VR Phases 0–6 are post-beta; do not implement unasked)
- `scripts/README.md` — layout map for the scripts tree

Keep this file as the single agent-conventions doc; update it when a new file category is introduced rather than scattering conventions across other docs.
