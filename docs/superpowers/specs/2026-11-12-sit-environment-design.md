# SIT environment on the production VPS — design

Date: 2026-11-12. Status: draft, awaiting approval.

## Intent

Today a push to `dev` runs the CI checks and nothing else. The first time a change
meets the real edge is when `main` deploys to production. The real edge means:

- the Cloudflare Tunnel
- R2 on a custom domain
- the Cache and Transform Rules
- Quest Browser on trusted HTTPS

SIT (system integration test) is a second, hosted copy of the production stack at
`https://sit.echomultiverse.com`. Every push to `dev` deploys there automatically
and a probe checks it. You test by hand, including on the Quest, and only then
move `main` to that commit. That deploys production as it does today.

The local staging stack (`docs/local-staging.md`) stays. It rehearses production
mode for free on a laptop. Its section "What it cannot prove" lists what SIT adds:
the real Cloudflare edge, real R2, the named Tunnel, and Quest over trusted HTTPS
without `adb reverse`.

## Goals

- A push to `dev` runs the CI checks, deploys SIT and runs the probe. No manual step.
- SIT matches production in its image, its `SX_ENV=production` boot checks, its
  `compose.yaml` services and its Cloudflare setup. Only these differ: hostnames,
  buckets, secrets, data, resource limits, and the Docker daemon it runs on.
- Production keeps priority on the shared VPS:
  - When SIT is idle, production can use all the idle CPU.
  - When both are busy, production wins.
  - SIT memory has a hard cap.
  - SIT image builds count against the same limits.
- Code from `dev` cannot read or change anything that belongs to production.
  `dev` is **not** trusted like `main`.
- `main` deploys exactly the commit that passed on SIT. This is a process rule; CI
  does not enforce it.

## Non-goals

- A second VPS. It was set aside for cost. Revisit it if prod memory gets tight
  (see step 3 of the one-time setup).
- Per-branch or per-PR preview environments. SIT tracks `dev` only.
- Building the image once in CI and promoting it. Production still builds on the
  VPS from the same commit.
- Copying production data into SIT. Production dumps hold real users' data, and
  they are unreadable without the production encryption keys.
- Backups of SIT.
- A CI gate that blocks a prod deploy unless SIT passed for that SHA. The user
  chose to keep this as a convention.
- Testing the paid fal extend path on SIT. `FAL_KEY` stays blank.

## Anti-goals (failure even if SIT works)

- Any SIT action changes what production runs, reads or writes. That includes
  containers, images, volumes, `.env`, buckets, Tunnel routes, Sentry alerts and
  cookies.
- A SIT build, encode or memory spike slows production badly or OOM-kills it.
- SIT sends real email, charges real money or spends fal credit.
- Search engines index SIT, or anyone can sign in with a password that is in the
  repo.

## Constraints (from the code and the box)

- VPS: OVHcloud VPS-2, 4 vCPU / 8 GB / 75 GB, Debian 13 (cgroup v2, systemd).
  Prod already caps `app` at 6g and `app-read` at 2g. Postgres has no cap.
- **The prod deploy user is in the `docker` group, which is root-equivalent.**
  Any code that user runs, or any compose file it applies, has full access to
  prod's containers, volumes and `.env`. `dev` code must therefore never run as
  that user or against that Docker daemon.
- `compose.yaml` hardcodes `image: echo-app:latest`. `deploy/deploy.sh`
  hardcodes the `refs/heads/main` check, `git fetch origin main` and the readiness
  URL `http://127.0.0.1:8000/api/readyz`. `ECHO_DIR` is already a parameter.
- `deploy.sh` runs `docker compose build` on the box. A build runs inside the
  Docker daemon, not inside any container, so compose `cpus`, `mem_limit` and
  `cpu_shares` do not apply to it.
- `.github/workflows/ci.yml`: the workflow-level `cancel-in-progress` is true for
  every ref except `main`. A newer push to `dev` would cancel a SIT deploy while
  it restarts.
- The Sentry environment tag comes from `SX_ENV` (`server/app.py`
  `_init_sentry`). It must be `production` for the boot checks
  (`server/settings.py`).
- Sign-up sends a verification mail. The account exists only after its token is
  used. `scripts/verify_staging.cjs` reads the token from Mailpit, and logs in
  first on later runs.
- The probe's default password `staging-only-password-1` is in the repo.
- Session, CSRF, anon and device cookies are host-only (no `Domain=`), so prod
  cookies are never sent to `sit.`. No change needed.
- Cloudflare's free Universal SSL covers one subdomain level only. So the SIT media
  host is `sit-media.echomultiverse.com`, not `media.sit.echomultiverse.com`.
- The production Tunnel already routes to `http://proxy:8000` (Caddy, then `app`
  and `app-read`). The status line in `docs/deploy-runbook.md` still says
  `app:8000` and is stale.

## Design (decided)

### Isolation: a separate unix user with rootless Docker

- Add a unix user `echosit`. It has a password-less login with SSH keys only. It
  is **not** in the `docker` group and has no sudo.
- `echosit` runs its own **rootless Docker daemon**:
  - set it up with `dockerd-rootless-setuptool.sh install`
  - run it as a `systemd --user` service
  - run `loginctl enable-linger echosit` so the daemon runs without a login session
  - socket: `unix:///run/user/<uid>/docker.sock`
- SIT images, containers, volumes and build cache live under
  `~echosit/.local/share/docker`. The root daemon never sees them.
- The checkout is `~echosit/echo-sit`, on branch `dev`, owned by `echosit`. Its
  `.env` is `chmod 600`.
- What `dev` code can then reach: only what `echosit` can. Before going live,
  verify `echosit` cannot read:
  - `/opt/echo/.env` (owned by the prod deploy user, mode 600)
  - the prod deploy user's `$HOME`, which holds the pre-deploy dumps and the
    rclone config (Debian 13 defaults to mode 0700)
  - `/var/run/docker.sock`
  - `/var/lib/docker`
- **Network:** add an nftables `output` rule with `meta skuid echosit`. It
  rejects connections to `127.0.0.1` ports 8000 and 8080 (prod app and proxy)
  and to the root daemon's bridge subnets (`172.16.0.0/12`; confirm with
  `docker network inspect`). Rootless container traffic leaves through
  slirp4netns or pasta, which runs as `echosit`, so this one rule covers both
  `deploy.sh` and SIT containers. Without it, SIT could call prod with a forged
  `CF-Connecting-IP` (prod runs `--forwarded-allow-ips='*'` and
  `SX_TRUST_PROXY_HEADERS=1`) and reach prod Postgres's login prompt.
- **GitHub:** a `dev` commit can edit `ci.yml` to declare
  `environment: production` and read the prod SSH key. Today `production` has
  no deployment-branch policy. Restrict `production` to `main` and `sit` to
  `dev`. All four `VPS_*` secrets are already environment-scoped; there are no
  repo-level secrets.
- Published ports: rootlesskit binds them on the host's loopback, so they must not
  clash with prod. SIT sets `SX_APP_PORT=8001` and `SX_PROXY_PORT=8081`; prod
  keeps 8000 and 8080. Mailpit's UI is on `127.0.0.1:8025`.
- With two daemons, the image names and compose project names no longer collide.
  `compose.yaml` keeps `echo-app:latest` unchanged.

### Priority and limits: one systemd slice for everything SIT does

`echosit`'s daemon, its containers and its BuildKit builds all run under
`user-<uid>.slice`. Limits set on that slice therefore cover image builds too.

- Delegate the `cpu`, `cpuset` and `io` controllers to user sessions, so rootless
  Docker can apply compose's `cpus` and `mem_limit`. Use a drop-in at
  `/etc/systemd/system/user@.service.d/delegate.conf` with
  `Delegate=cpu cpuset io memory pids`.
- `user-<uid>.slice`:
  - `CPUWeight=10`
  - `CPUQuota=200%`, a ceiling of 2 of 4 vCPUs
  - `MemoryHigh=2.5G`, `MemoryMax=3G`. This budget must hold the image build
    **and** the running old stack at the same time, because `deploy.sh` builds
    before it restarts. If the measurement in setup step 3 says that does not
    fit, `deploy.sh` stops the SIT stack before building when
    `DEPLOY_BRANCH` is not `main`. A SIT outage during a deploy is fine.
- Lower `user.slice` itself to `CPUWeight=20`. Weights compete between siblings:
  - `system.slice` holds the root daemon's prod containers and prod builds.
  - It competes with `user.slice` at 100 : 100 by default.
  - Without this change, a busy SIT could take about half the CPU from a busy prod.
  - Side effect: interactive SSH sessions also get less CPU under contention.
    That is acceptable.
- `oom_score_adj: 500` on every SIT service in `deploy/compose.sit.yaml`. Raising
  it is allowed without privileges. If prod's own growth triggers a host-wide OOM,
  the kernel then picks SIT first.
- `SX_FFMPEG_NICE=19`, below prod's 10.

### Code changes

1. **New `deploy/compose.sit.yaml`**, an override like `compose.staging.yaml`:
   - `oom_score_adj: 500` on each service.
   - `SX_READ_WORKERS=1`, unless that is set in the `.env`.
   - A `mailpit` service, as in `compose.staging.yaml`, with its UI on
     `127.0.0.1:8025` only. All SIT mail goes there.
   - Small per-service `mem_limit`s inside the slice: `postgres` 512m,
     `app-read` 512m, `proxy` and `cloudflared` 128m, `mailpit` 64m. Without
     them, a SIT encode in `app` could OOM-kill SIT Postgres. `app` gets
     what is left. The slice owns CPU.
2. **`deploy/deploy.sh`**:
   - Add `DEPLOY_BRANCH` (default `main`). Use it for the branch check and the
     fetch.
   - Read `SX_APP_PORT` from the checkout's `.env` (default 8000) for the
     readiness URL. The `.env` stays the single place it is set.
   - Honour an existing `DOCKER_HOST`; it already does if nothing overrides it.
   - When `DEPLOY_BRANCH` is not `main`, prune old `echo-app:<sha>` rollback tags
     and keep the newest 3. Then run `docker image prune -f` and
     `docker builder prune -f --filter until=72h`. Removing tags alone frees no
     space. Dev deploys are frequent, and the images would fill the 75 GB disk
     that prod shares.
   - Called with no new variables, it behaves exactly as today.
3. **`server/app.py` `_init_sentry`**: use `SENTRY_ENVIRONMENT` when it is set,
   and fall back to `SX_ENV`. SIT sets `SENTRY_ENVIRONMENT=sit` and uses the
   same DSN.
4. **`.github/workflows/ci.yml`**:
   - Workflow concurrency: also do not cancel in-progress runs on `dev`.
   - New `deploy-sit` job:
     - `needs: [test, postgres, docker, scans]`
     - `if:` a push to `refs/heads/dev`
     - `environment: sit`
     - job concurrency `deploy-sit` with `cancel-in-progress: false`
   - The job connects over SSH **as `echosit`**, with its own key (secret
     `VPS_SIT_SSH_KEY`). `VPS_HOST` and `VPS_KNOWN_HOSTS` are duplicated into
     the `sit` environment. The prod key is never in `sit`.
   - It runs:
     `ECHO_DIR=~/echo-sit DEPLOY_BRANCH=dev DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock bash -s -- $SHA`
     with `deploy/deploy.sh` on stdin. Then it greps for the `deployed` line,
     as the prod job does.
   - It then runs `node scripts/verify_staging.cjs --app https://sit.echomultiverse.com
     --media https://sit-media.echomultiverse.com`, with `--email`, `--peer` and
     `--password` taken from `sit` environment secrets. A probe failure fails
     the job.
   - The prod `deploy` job does not change.
5. **`scripts/verify_staging.cjs`**: no change expected.
6. **Docs**:
   - New `docs/sit-runbook.md`, covering:
     - the one-time setup below
     - promotion
     - stop and start
     - Mailpit access
     - the isolation checks
   - In `docs/deploy-runbook.md`, add a pointer to it and fix the stale
     `app:8000` status line.

### SIT `.env` (from `deploy/env.example`, differences only)

- `SX_ENV=production`, `SENTRY_ENVIRONMENT=sit`.
- URLs:
  - `SX_PUBLIC_URL` and `SX_PUBLIC_BASE_URL`: `https://sit.echomultiverse.com`
  - `SX_MEDIA_BASE_URL`: `https://sit-media.echomultiverse.com`
- `COMPOSE_FILE=compose.yaml:deploy/compose.sit.yaml`.
- `SX_APP_PORT=8001`, `SX_PROXY_PORT=8081`.
- Fresh secrets for every `SX_*` secret and for `POSTGRES_PASSWORD`, made with
  `openssl rand`. Never copy production values.
- R2: the SIT bucket and a token scoped to that bucket only. No log bucket.
- Invite-only, like prod:
  - `SX_REGISTRATION_ALLOWLIST`: your own address(es) and the two probe addresses
  - `SX_ADMIN_USERS`: your SIT account, never a probe account
- `SX_SMTP_HOST=mailpit`, with the plain-SMTP settings from
  `deploy/env.staging.example`.
- `FAL_KEY` blank. `SX_STRIPE_ENABLED=0`. Turnstile unset.
- `SX_PUBLISH_HOURLY_MAX=60` and `SX_PUBLISH_DAILY_MAX=200`, as in
  `env.staging.example`, so a probe on every dev push is not rate-limited.
- `SX_READ_WORKERS=1`. `SX_FFMPEG_NICE=19`.
- `SX_DISK_MIN_FREE_GB=10`, above prod's 5, so SIT refuses new work before prod
  does when the disk fills.

### Cloudflare (in the dashboard, mirroring `docs/deploy-runbook.md` §Cloudflare)

- Tunnel `echo-sit`: public hostname `sit.echomultiverse.com` routes to
  `http://proxy:8000`, the same as prod. Leave the HTTP Host Header empty. The SIT
  `cloudflared` container runs on the SIT daemon's network, so `proxy` resolves to
  the SIT proxy.
- R2 bucket for SIT public media, location hint `apac`:
  - custom domain `sit-media.echomultiverse.com`
  - a 30-day lifecycle rule on `jobs/`
  - CORS that allows `https://sit.echomultiverse.com`
  - an app token scoped to this bucket only
- Transform Rule on `sit-media`: set a static
  `Access-Control-Allow-Origin: https://sit.echomultiverse.com` and
  `Vary: Origin`.
- Transform Rule on `sit`: set `X-Robots-Tag: noindex, nofollow`.
- Cache Rules: add the SIT hostnames to rule 1 (the `/api/` bypass) and rule 2
  (cache everything for media), using `http.host in {...}`.

### One-time setup on the VPS (an admin with sudo does this)

0. GitHub: set the deployment-branch policies (`production` to `main`, `sit`
   to `dev`). Create the `sit` environment and its secrets.
1. Create `echosit` and add its CI key to `authorized_keys` with `restrict`.
   Add your own key too if you want to log in as `echosit`.
2. Install rootless Docker for `echosit`:
   - Check every command against Docker's rootless docs for the package
     installed on the box: `docker-ce` with `docker-ce-rootless-extras`, or
     Debian's `docker.io`. The steps differ.
   - Install the `uidmap` and `dbus-user-session` packages.
   - Add the delegate drop-in and the slice properties above.
   - Run `loginctl enable-linger`.
   - Confirm `docker info` as `echosit` shows `rootless` and the
     `cpu memory io` cgroup controllers.
   - Rollback for the two host-wide changes: delete
     `/etc/systemd/system/user@.service.d/delegate.conf`, then run
     `systemctl revert user.slice` and `systemctl daemon-reload`.
3. Measure before settling the numbers:
   - Run `docker stats --no-stream` and `free -m` on prod, at idle and during
     a video encode. If idle prod plus 3 GB leaves no headroom, lower
     `MemoryMax`, or stop the SIT stack before each build (see the slice
     section).
   - Run `df -h` and `docker system df`. The rootless daemon shares no layers
     with the root one, so it stores a second copy of the images, the build
     cache and the whisper model.
4. Add the nftables rule. Run the isolation checks under "Isolation". As
   `echosit`, `curl 127.0.0.1:8000` must fail and `curl 127.0.0.1:8001` must
   work.
5. Clone into `~echosit/echo-sit` and check out `dev`. Write the `.env`. Run
   `docker compose up -d --build`, then `docker compose --profile tunnel up -d`.
6. Create the two probe accounts once with the probe. Use
   `--mailpit http://127.0.0.1:8025` from the VPS or through
   `ssh -L 8025:127.0.0.1:8025`. Store their password in the `sit` environment
   secrets. After this, CI runs only log in.
7. Sentry: add an `environment:production` filter to the prod alert rules, so
   SIT errors do not page you.

### Promotion flow (convention, written into the runbook)

1. Merge feature branches into `dev`, as today. CI deploys SIT and runs the probe.
2. Test by hand on `https://sit.echomultiverse.com`, including on the Quest.
3. Fast-forward `main` to the tested `dev` commit, with
   `git push origin <sha>:main` or `git merge --ff-only` and a push. Never move
   `main` to a SHA whose `deploy-sit` job is not green.
4. The prod deploy job runs as today, on the same SHA, rebuilt on the VPS.
5. Hotfixes follow the same path: into `dev`, through SIT, then onto `main`.
   Nothing is pushed straight to `main`, so ff-only promotion always works.

### Day-to-day

- To stop SIT and free its RAM, run `docker compose stop` as `echosit` in
  `~/echo-sit`. The next dev deploy starts it again (`up -d`).
- Use SIT to try the "anonymous list responses" Cache Rule before it goes on prod.
  That rule is not applied yet; see `docs/deploy-runbook.md`.

## Left to the builder

- The exact slice numbers, after the measurement in step 3 of the one-time setup.
- How `deploy.sh` reads `SX_APP_PORT` from `.env`. A `grep` is enough.
- How CI resolves `DOCKER_HOST` on the box: expand `$(id -u)` remotely, or set it
  in `~echosit/.bashrc`.
- Tests:
  - coverage in `tests/` for `SENTRY_ENVIRONMENT`
  - a shell check that `deploy.sh` with no new variables still targets `main`
    and port 8000

## Calls made without asking

- SIT image builds stay on the VPS. The `echosit` slice limits cover them, so
  there is no throttled buildx builder and no building in CI.
- `user.slice` is set to `CPUWeight=20`. Interactive SSH sessions get less CPU
  under contention.
- Hotfixes go through `dev` and SIT too. Nothing is pushed straight to `main`.
- SIT and prod deploys use separate concurrency groups and may overlap. The
  slice limits keep that safe.

## Known limits

- Disk is shared and not split by user. If SIT fills it, prod is hurt too.
  `SX_DISK_MIN_FREE_GB=10` and the tag pruning reduce this risk, but do not remove
  it.
- `io.weight` takes effect only under the BFQ scheduler. The VPS disk most likely
  uses `none` or `mq-deadline`, so SIT disk I/O is probably not deprioritised.
- Rootless networking (slirp4netns or pasta) is slower than the root bridge.
  That is acceptable for SIT.
- `web/index.html` preconnects to `media.echomultiverse.com`. On SIT this does
  nothing useful and causes no harm.
