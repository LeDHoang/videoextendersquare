# SIT Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push to `dev` deploys to `https://sit.echomultiverse.com`, an isolated copy of the production stack on the prod VPS, and a probe checks it there.

**Architecture:** The repo changes are small:

- `deploy.sh` gains a branch parameter, a port parameter and image pruning.
- A new compose override and env template for SIT.
- A Sentry environment override.
- A `deploy-sit` CI job.
- Host config files and a runbook.

Isolation is set up on the box itself:

- SIT runs as the unix user `echosit` on a rootless Docker daemon.
- One systemd slice limits SIT's CPU and memory.
- An nftables rule keeps SIT off prod's ports.

The Cloudflare and GitHub settings are manual, and the runbook lists them.

**Tech Stack:** bash, Docker Compose, GitHub Actions, pytest + PyYAML, systemd, nftables, Cloudflare dashboard.

**Spec:** `docs/superpowers/specs/2026-11-12-sit-environment-design.md`

## Global Constraints

- Calling `deploy/deploy.sh` with no new variables behaves exactly as it does today: it uses branch `main` and port 8000 and prunes nothing.
- The prod `deploy` job in `.github/workflows/ci.yml` does not change.
- SIT never runs as the prod deploy user and never uses the root Docker daemon. The SIT CI job uses only `sit` environment secrets.
- SIT ports: `SX_APP_PORT=8001`, `SX_PROXY_PORT=8081`, Mailpit UI `127.0.0.1:8025`.
- The SIT hosts are `sit.echomultiverse.com` and `sit-media.echomultiverse.com`. Never use `media.sit.…`.
- SIT env values:
  - `SX_ENV=production`, `SENTRY_ENVIRONMENT=sit`
  - `FAL_KEY` blank, `SX_STRIPE_ENABLED=0`
  - `SX_PUBLISH_HOURLY_MAX=60`, `SX_PUBLISH_DAILY_MAX=200`
  - `SX_READ_WORKERS=1`, `SX_FFMPEG_NICE=19`, `SX_DISK_MIN_FREE_GB=10`
- The repo never contains the probe password. The string `staging-only-password-1` must not appear in any SIT file.
- Commit messages carry no `Co-Authored-By` or "Generated with" lines.
- Inside a worktree, run pytest with `PYTHON_DOTENV_DISABLED=1`.

## Review Focus

1. **`.env` has no `SX_APP_PORT` line, or the value is quoted (`SX_APP_PORT="8001"`).** `deploy.sh` should fall back to 8000, or strip the quotes. It must never poll an empty port. The test goes in Task 2.
2. **The checkout is on `main` but `DEPLOY_BRANCH=dev`, or the reverse.** The deploy must refuse and exit non-zero before it builds. The test goes in Task 2.
3. **Fewer than 3 rollback tags exist, for example on the first SIT deploy.** Pruning must not fail, and must not remove `latest` or the tag just created. The test goes in Task 2.
4. **`SENTRY_ENVIRONMENT` is set but empty or whitespace.** It should fall back to `SX_ENV`, not send an empty environment. The test goes in Task 1.
5. **`env.sit.example`, filled with dummy secrets, fails the production boot checks.** The test should show the template passes `production_config_errors()` once its placeholders are filled. The test goes in Task 3.

---

### Task 1: Sentry environment override

**Files:**
- Modify: `server/app.py:93-114` (`_init_sentry`)
- Test: `tests/test_observability.py`

**Interfaces:**
- Produces: the env var `SENTRY_ENVIRONMENT`. When it is non-blank, it wins over `SX_ENV`.

- [ ] **Step 1: Write the failing tests.** Add to `tests/test_observability.py`. Import `server.app` under `patch("dotenv.load_dotenv")`, as `tests/test_production_boot.py` does. Patch `sentry_sdk.init` and capture its kwargs.
  - `test_sentry_environment_override_wins`: with `SENTRY_DSN=https://k@o0.ingest.sentry.io/0`, `SX_ENV=production` and `SENTRY_ENVIRONMENT=sit`, `init` gets `environment == "sit"`.
  - `test_sentry_environment_blank_falls_back_to_sx_env`: with `SENTRY_ENVIRONMENT="  "` and `SX_ENV=production`, `init` gets `environment == "production"`.
- [ ] **Step 2: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_observability.py -k sentry_environment`. Expected: the first test FAILS, because it gets `environment == "production"`.
- [ ] **Step 3: Implement.** In `_init_sentry`, set `environment` to `os.environ.get("SENTRY_ENVIRONMENT", "").strip()`. When that is empty, fall back to `os.environ.get("SX_ENV", "development")`. Add a one-line mention of `SENTRY_ENVIRONMENT` next to `SENTRY_DSN` in `deploy/env.example`, commented out.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Run `git add server/app.py tests/test_observability.py deploy/env.example`, then `git commit -m "feat(observability): SENTRY_ENVIRONMENT overrides SX_ENV for Sentry"`.

### Task 2: `deploy.sh` takes a branch and a port, and prunes SIT images

**Files:**
- Modify: `deploy/deploy.sh`
- Test: `tests/test_ci_workflow.py`

**Interfaces:**
- Produces: `deploy.sh <sha>`, which reads three env vars:
  - `ECHO_DIR` (existing)
  - `DEPLOY_BRANCH` (default `main`)
  - `DOCKER_HOST` (passed through to docker; the script never sets it)
- The readiness port comes from `SX_APP_PORT` in `$ECHO_DIR/.env`, default `8000`. Strip surrounding quotes and use the last occurrence.
- On success, stdout still ends with the line `deployed <short>`.

- [ ] **Step 1: Make the test harness reusable.**
  - Extract the stub setup in `test_deploy_script_runs_to_the_end_when_a_command_reads_stdin` into a helper `_run_deploy(tmp_path, *, head="refs/heads/main", env=None, dotenv=None, image_tags="") -> tuple[CompletedProcess, str]`. The returned string is the calls log.
  - The `curl` stub must log `curl $*`.
  - The `docker` stub must print `image_tags` (one tag per line) when called as `docker image ls …`.
  - The existing test must keep its assertions unchanged.
- [ ] **Step 2: Write the failing tests** in `tests/test_ci_workflow.py`.
  - `test_deploy_defaults_to_main_and_port_8000`: no env, no `.env`. The calls log has `http://127.0.0.1:8000/api/readyz`, `git fetch --quiet origin main` and no `docker image rm`.
  - `test_deploy_branch_and_port_come_from_env_and_dotenv`:
    - Setup: `head="refs/heads/dev"`, `env={"DEPLOY_BRANCH": "dev"}`, `dotenv='SX_APP_PORT="8001"\n'`.
    - Expect: return code 0, the log has `127.0.0.1:8001/api/readyz` and `origin dev`.
  - `test_deploy_refuses_branch_mismatch`:
    - Setup: `head="refs/heads/main"`, `env={"DEPLOY_BRANCH": "dev"}`.
    - Expect: a non-zero return code, `checkout is not on dev` in stderr, and no `docker compose build` in the log.
  - `test_sit_deploy_prunes_old_rollback_tags_keeping_three`:
    - Setup: `DEPLOY_BRANCH=dev`, and `image_tags` lists `latest`, the new short tag and 4 older 12-hex tags, newest first.
    - Expect: `docker image rm` for exactly the 2 oldest, and the log has `docker image prune -f` and `docker builder prune -f --filter until=72h`.
  - `test_sit_prune_with_few_tags_is_a_no_op`:
    - Setup: `image_tags` lists `latest` and one tag.
    - Expect: return code 0, no `docker image rm`.
  - The git stub must answer `symbolic-ref -q HEAD` with the `head` argument, and `fetch` must log its args.
- [ ] **Step 3: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_ci_workflow.py`. Expected: the new tests FAIL and the existing ones PASS.
- [ ] **Step 4: Implement** in `deploy/deploy.sh`, inside the existing `{ … }` group:
  - Branch: `branch="${DEPLOY_BRANCH:-main}"`. Use it in the `refs/heads/$branch` check, in the message `checkout is not on $branch; not deploying`, and in `git fetch --quiet origin "$branch"`.
  - Port: read `port` from `.env` with `sed -n 's/^SX_APP_PORT=//p' .env 2>/dev/null | tail -n1 | tr -d "\"'"`. Default to 8000. Use it in the readyz URL.
  - Pruning, only when `branch != main` and after the `docker tag`: list the tags with `docker image ls echo-app --format '{{.Tag}}'` (newest first). Drop `latest` and `$short`. Then `docker image rm` every tag after the first 2 that remain, so 3 SIT rollback tags stay counting `$short`. Then run `docker image prune -f` and `docker builder prune -f --filter until=72h`.
  - Header comment: document `DEPLOY_BRANCH`, `DOCKER_HOST` and the `.env` port.
  - Keep `test_deploy_script_refuses_to_run_off_main_or_without_a_fast_forward` passing. It looks for the literal `refs/heads/main`, so keep that string in the default or a comment, or update the assertion to `refs/heads/$branch`. Choose one; do not weaken `merge --ff-only`.
- [ ] **Step 5: Run the tests.** Same command. Expected: all PASS. Then run `bash -n deploy/deploy.sh`. Expected: no output.
- [ ] **Step 6: Commit.** Run `git add deploy/deploy.sh tests/test_ci_workflow.py`, then `git commit -m "feat(deploy): DEPLOY_BRANCH, .env app port, and SIT image pruning in deploy.sh"`.

### Task 3: SIT compose override and env template

**Files:**
- Create: `deploy/compose.sit.yaml`
- Create: `deploy/env.sit.example`
- Test: `tests/test_sit_config.py` (new)

**Interfaces:**
- Produces: SIT's `.env` holds `COMPOSE_FILE=compose.yaml:deploy/compose.sit.yaml`. Tasks 4 and 5 rely on that file name and on the keys below.

- [ ] **Step 1: Write the failing tests** in `tests/test_sit_config.py`. Load the YAML with `yaml.safe_load`, and parse the env file as `KEY=VALUE` lines, skipping comments.
  - `test_every_sit_service_is_oom_preferred`: for `app`, `app-read`, `proxy`, `postgres`, `cloudflared` and `mailpit`, `oom_score_adj == 500`.
  - `test_sit_memory_caps`:
    - `postgres` and `app-read` are `512m`.
    - `proxy` and `cloudflared` are `128m`.
    - `mailpit` is `64m`.
    - `app` has no `mem_limit` override.
  - `test_mailpit_ui_is_loopback_only`: every port of `mailpit` starts with `127.0.0.1:`.
  - `test_sit_env_pins_spec_values`: the env file has these exact values:

    | Key | Value |
    | --- | --- |
    | `SX_ENV` | `production` |
    | `SENTRY_ENVIRONMENT` | `sit` |
    | `COMPOSE_FILE` | `compose.yaml:deploy/compose.sit.yaml` |
    | `SX_APP_PORT` | `8001` |
    | `SX_PROXY_PORT` | `8081` |
    | `SX_PUBLIC_URL` | `https://sit.echomultiverse.com` |
    | `SX_PUBLIC_BASE_URL` | `https://sit.echomultiverse.com` |
    | `SX_MEDIA_BASE_URL` | `https://sit-media.echomultiverse.com` |
    | `FAL_KEY` | blank |
    | `SX_STRIPE_ENABLED` | `0` |
    | `SX_PUBLISH_HOURLY_MAX` | `60` |
    | `SX_PUBLISH_DAILY_MAX` | `200` |
    | `SX_READ_WORKERS` | `1` |
    | `SX_FFMPEG_NICE` | `19` |
    | `SX_DISK_MIN_FREE_GB` | `10` |
    | `SX_SMTP_HOST` | `mailpit` |
    | `SX_SMTP_PORT` | `1025` |

    It has no `R2_LOG_BUCKET` key.
  - `test_sit_files_hold_no_known_password`: `staging-only-password-1` is in neither file.
  - `test_sit_env_passes_production_boot_checks`:
    - Load the env file into `monkeypatch`.
    - Replace every `<…>` placeholder with `"x" * 64`.
    - Set `DATABASE_URL=postgresql+psycopg://u:p@postgres/echo`.
    - Expect `server.settings.production_config_errors() == []`.
- [ ] **Step 2: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_sit_config.py`. Expected: FAIL, because the files are missing.
- [ ] **Step 3: Create `deploy/compose.sit.yaml`.**
  - Header comment, in the style of `deploy/compose.staging.yaml`: what the file is, that it runs under rootless Docker as `echosit`, that the slice owns CPU, and a pointer to `docs/sit-runbook.md`.
  - Per-service `oom_score_adj` and `mem_limit` as tested.
  - A `mailpit` service: `axllent/mailpit:latest`, port `127.0.0.1:8025:8025`, `restart: unless-stopped`.
- [ ] **Step 4: Create `deploy/env.sit.example`.**
  - Start from a copy of `deploy/env.example`.
  - Header, in the style of `env.staging.example`:
    - copy it to `~/echo-sit/.env` and run `chmod 600`
    - generate fresh secrets with `openssl rand`
    - never reuse prod values
  - Set the pinned values above.
  - Drop the `R2_LOG_*` keys.
  - Copy the SMTP block from `env.staging.example` (lines 121-127).
  - Comment the allowlist: your addresses plus the two probe addresses. `SX_ADMIN_USERS` is never a probe account.
- [ ] **Step 5: Run the tests.** Same command. Expected: PASS. Then run `make test`. Expected: the whole suite PASSes.
- [ ] **Step 6: Commit.** Run `git add deploy/compose.sit.yaml deploy/env.sit.example tests/test_sit_config.py`, then `git commit -m "feat(deploy): SIT compose override and env template"`.

### Task 4: CI `deploy-sit` job

**Files:**
- Modify: `.github/workflows/ci.yml` (workflow `concurrency`, plus a new job after `deploy`)
- Test: `tests/test_ci_workflow.py`

**Interfaces:**
- Consumes:
  - `deploy.sh`'s `DEPLOY_BRANCH` and `DOCKER_HOST`, from Task 2
  - the `deployed ` line, from Task 2
  - the `scripts/verify_staging.cjs` flags `--app`, `--media`, `--email`, `--peer`, `--password`
- Produces: the GitHub environment `sit` with these secrets:
  - `VPS_HOST`, `VPS_KNOWN_HOSTS`
  - `VPS_SIT_USER` (=`echosit`), `VPS_SIT_SSH_KEY`
  - `SIT_PROBE_EMAIL`, `SIT_PROBE_PEER`, `SIT_PROBE_PASSWORD`

  Task 5 documents them.

- [ ] **Step 1: Write the failing tests and update one.**
  - Update `test_a_newer_push_to_main_cannot_cancel_a_running_deploy`: the expected value becomes `${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/dev' }}`.
  - `test_sit_deploy_waits_for_checks_and_runs_only_for_dev_pushes`: `needs` == `CHECK_JOBS`, and `if` == `github.event_name == 'push' && github.ref == 'refs/heads/dev'`.
  - `test_sit_deploy_uses_its_own_environment_and_never_the_prod_key`:
    - `environment == "sit"` and `concurrency == {"group": "deploy-sit", "cancel-in-progress": False}`.
    - The job's text contains none of `VPS_SSH_KEY`, `VPS_USER` or `environment: production`.
  - `test_sit_deploy_streams_deploy_sh_as_echosit_on_dev_and_probes`: the joined `run` text contains:
    - `DEPLOY_BRANCH=dev`
    - `docker.sock`
    - `StrictHostKeyChecking=yes`
    - `deploy/deploy.sh`
    - `grep -q '^deployed ' deploy.log`
    - `scripts/verify_staging.cjs`
    - `https://sit.echomultiverse.com`
    - `https://sit-media.echomultiverse.com`
    - `SIT_PROBE_PASSWORD`
  - `test_prod_deploy_job_is_unchanged`: the existing `deploy` assertions still hold. No change is needed; the current tests already pin it.
- [ ] **Step 2: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_ci_workflow.py`. Expected: the new and updated tests FAIL.
- [ ] **Step 3: Implement the workflow changes.**
  - Workflow `concurrency.cancel-in-progress`: the expression above, with its comment updated to "except on main and dev".
  - New job `deploy-sit`:
    - name "deploy to SIT", `runs-on: ubuntu-24.04`, `timeout-minutes: 20`.
    - Comment: why it uses its own key and user.
    - SSH step: modelled on `deploy`, using `VPS_SIT_USER` and `VPS_SIT_SSH_KEY`. The remote command is `ECHO_DIR=$HOME/echo-sit DEPLOY_BRANCH=dev DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock bash -s -- $GITHUB_SHA`. Single-quote the `$(id -u)` and `$HOME` parts so they expand on the VPS, not on the runner.
    - Then `actions/setup-node@v7` (node 22).
    - Then a probe step that runs `node scripts/verify_staging.cjs --app https://sit.echomultiverse.com --media https://sit-media.echomultiverse.com --email "$SIT_PROBE_EMAIL" --peer "$SIT_PROBE_PEER" --password "$SIT_PROBE_PASSWORD"`, with the three values passed through `env:` from secrets.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS. If `actionlint` is installed, also run `actionlint .github/workflows/ci.yml`; expected: no output.
- [ ] **Step 5: Commit.** Run `git add .github/workflows/ci.yml tests/test_ci_workflow.py`, then `git commit -m "ci: deploy dev to SIT as echosit and run the probe"`.

### Task 5: Host config files and runbooks

**Files:**
- Create: `deploy/sit/delegate.conf`. Install target: `/etc/systemd/system/user@.service.d/delegate.conf`.
- Create: `deploy/sit/user-slice.conf`. Install target: `/etc/systemd/system/user.slice.d/50-sit-priority.conf`.
- Create: `deploy/sit/echosit-slice.conf`. Install target: `/etc/systemd/system/user-<uid>.slice.d/50-sit-limits.conf`.
- Create: `deploy/sit/echosit.nft`. Installed via `/etc/nftables.conf` `include`.
- Create: `docs/sit-runbook.md`
- Modify: `docs/deploy-runbook.md`:
  - line 27 status: `app:8000` becomes `proxy:8000`
  - line 40: delete "Production still points at `http://app:8000` until the switch in that section is made."
  - add a one-line pointer to `docs/sit-runbook.md` near the top
- Test: `tests/test_sit_config.py`

**Interfaces:**
- Consumes:
  - the secret names from Task 4
  - the `deploy/env.sit.example` file name and ports from Task 3
- Produces: nothing used by code.

- [ ] **Step 1: Write the failing tests** in `tests/test_sit_config.py`. Each one reads its file as text.
  - `test_delegate_conf_delegates_cpu_io_memory`: it contains `[Service]` and `Delegate=cpu cpuset io memory pids`.
  - `test_slice_limits_match_spec`:
    - `echosit-slice.conf` contains `CPUWeight=10`, `CPUQuota=200%`, `MemoryHigh=2.5G` and `MemoryMax=3G`.
    - `user-slice.conf` contains `CPUWeight=20`.
  - `test_nft_rule_blocks_echosit_from_prod`:
    - It contains `meta skuid "echosit"` (or `skuid echosit`), `127.0.0.1`, `8000`, `8080` and `172.16.0.0/12`.
    - It does not contain `8001` or `8081`, which SIT's own readiness poll uses.
  - `test_sit_runbook_covers_setup_isolation_and_promotion`:
    - `docs/sit-runbook.md` contains `loginctl enable-linger echosit`, `systemctl revert user.slice`, `curl` checks for both 8000 (must fail) and 8001 (must work), `git push origin <sha>:main`, `ssh -L 8025:127.0.0.1:8025` and `environment:production`.
    - It also names every secret from Task 4.
- [ ] **Step 2: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_sit_config.py`. Expected: the new tests FAIL.
- [ ] **Step 3: Write the four config files.** Each one gets a header comment with its install path and a pointer to the runbook. In `echosit.nft`, use a table named `inet echosit_guard` with an `output` chain hook (priority 0, policy accept). It holds one `reject` rule for `skuid echosit` to `127.0.0.1` tcp dport `{8000, 8080}`, and one for `ip daddr 172.16.0.0/12`.
- [ ] **Step 4: Write `docs/sit-runbook.md`.** Follow the order of the spec's "One-time setup" steps 0–7, then promotion, day-to-day and known limits. Fill in commands; do not paraphrase the spec:
  - **Step 0, GitHub settings:**
    - `production` → `main` only, `sit` → `dev` only
    - the `sit` secrets list
  - **Step 1, the user:**
    - `useradd`
    - `authorized_keys` with `restrict`
  - **Step 2, rootless Docker:**
    - a note to check every command against Docker's rootless docs for `docker-ce` or `docker.io`
    - `apt install uidmap dbus-user-session`
    - install the config files and run `systemctl daemon-reload`
    - `loginctl enable-linger echosit`
    - `dockerd-rootless-setuptool.sh install`
    - `docker info` checks
    - the rollback commands
  - **Step 3, measurement:**
    - `docker stats --no-stream`, `free -m`, `df -h`, `docker system df`
    - what to lower if headroom is short
  - **Step 4, nftables and isolation:**
    - `nft -c -f` then `nft -f`
    - the isolation checks: `sudo -u echosit cat /opt/echo/.env` fails; `ls` of the prod deploy user's home fails; `docker.sock` and `/var/lib/docker` are not accessible; curl to 8000 fails, curl to 8001 works
  - **Step 5, first start:**
    - clone and `.env`
    - `docker compose up -d --build`
    - `docker compose --profile tunnel up -d`
  - **Step 6, probe accounts:** created once through Mailpit.
  - **Step 7, Sentry:** the prod alert filter.
  - **Cloudflare checklist:** copied from the spec's Cloudflare section.
- [ ] **Step 5: Run the tests.** Run `.venv/bin/python -m pytest -q tests/test_sit_config.py`, then `make test`. Expected: all PASS.
- [ ] **Step 6: Commit.** Run `git add deploy/sit docs/sit-runbook.md docs/deploy-runbook.md tests/test_sit_config.py`, then `git commit -m "docs(deploy): SIT host config and runbook"`.

### Task 6: Go live (manual; the user, with sudo on the VPS and dashboard access)

There is no code in this task. The repo work in Tasks 1–5 is merged to `dev` only once this task is ready. The first push after that triggers `deploy-sit`. An agent cannot do these steps: prod SSH and dashboard changes need the user.

- [ ] **Step 1:** Do the GitHub, Cloudflare and VPS steps 0–7 of `docs/sit-runbook.md`. Use `deploy/env.sit.example` as the start of the `.env`.
- [ ] **Step 2:** Verify the isolation checks from runbook step 4. Expected: every "must fail" check fails and the 8001 check works.
- [ ] **Step 3:** Push the Tasks 1–5 commits to `dev`. Expected: in the CI run, `deploy-sit` is green, and its log shows `deployed <sha>` and the probe passing.
- [ ] **Step 4:** Open `https://sit.echomultiverse.com` on the Quest and do a manual pass. The response headers include `X-Robots-Tag: noindex, nofollow`.
- [ ] **Step 5:** Promote with `git push origin <sha>:main`. Expected: the prod `deploy` job is green on the same SHA, and prod `/api/readyz` answers.
