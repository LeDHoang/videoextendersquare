# SIT runbook — sit.echomultiverse.com

SIT is a second copy of the app, on the prod VPS, that every push to `dev` deploys to. The CI job `deploy-sit` waits for every check, deploys the `dev` commit as the unix user `echosit`, and then runs `scripts/verify_staging.cjs` against `https://sit.echomultiverse.com`. Promote to `main` only a commit whose `deploy-sit` job is green.

How SIT is kept away from prod:
- `echosit` has its own **rootless Docker daemon**. It is not in the `docker` group and has no sudo, so it cannot reach prod's daemon, images or volumes.
- A **systemd slice** caps its CPU and memory, image builds included, and gives prod about 5x the CPU under contention.
- An **nftables rule** stops `echosit` (and SIT's containers) from connecting to prod's app, proxy and Postgres.
- The **GitHub `sit` environment** holds only `echosit`'s key, and only `dev` may deploy through it.

Files:
- `deploy/compose.sit.yaml`: the compose override (OOM priority, memory split, Mailpit).
- `deploy/env.sit.example`: the SIT `.env` template.
- `deploy/sit/`: the host config this runbook installs.
- `docs/superpowers/specs/2026-11-12-sit-environment-design.md`: the design and its reasons.

## One-time setup

An admin with sudo does every step, in this order. Steps 0 and 6–7 happen outside the VPS.

### 0. GitHub

In Settings → Environments:
- `production`: Deployment branches and tags → Selected branches → `main` only. Without this, a `dev` commit could edit `ci.yml`, declare `environment: production` and read the prod SSH key.
- Create `sit`: Selected branches → `dev` only. Add these secrets:
  - `VPS_HOST`, `VPS_KNOWN_HOSTS`: copies of the `production` values.
  - `VPS_SIT_USER`: `echosit`.
  - `VPS_SIT_SSH_KEY`: the private half of a new key pair (step 1), used only by SIT.
  - `SIT_PROBE_EMAIL`, `SIT_PROBE_PEER`, `SIT_PROBE_PASSWORD`: the probe accounts (step 6).

There are no repo-level secrets; keep it that way.

Do this step before the first push to `dev` that carries the `deploy-sit` job. GitHub creates a missing environment on first use, with no branch rule and no secrets.

### 1. The user

```bash
sudo useradd --create-home --shell /bin/bash echosit    # no password: SSH keys only
grep echosit /etc/subuid /etc/subgid                    # rootless Docker needs both ranges
sudo install -d -m 700 -o echosit -g echosit ~echosit/.ssh
ssh-keygen -t ed25519 -N '' -C echosit-ci -f echosit_ci # on your machine; private half -> VPS_SIT_SSH_KEY
echo echosit | sudo tee -a /etc/cron.deny /etc/at.deny  # cron and at jobs would run outside echosit's slice
sudo -u echosit crontab -l                              # must say echosit is not allowed
sudo sshd -T | grep -i '^allowusers'                    # if this prints a list, add echosit to AllowUsers
```

Write `~echosit/.ssh/authorized_keys` (owner `echosit`, mode 600). The CI key gets `restrict`, which drops forwarding and the pty:

```
restrict ssh-ed25519 AAAA... echosit-ci
ssh-ed25519 AAAA... you@laptop
```

The second line is optional: your own key, without `restrict`, so you can log in as `echosit`. Do the `echosit` steps below over that SSH login. `sudo -u echosit` gives no systemd user session, and `systemctl --user` fails there.

### 2. Rootless Docker

Check every command against Docker's rootless docs (docs.docker.com/engine/security/rootless) for the package on the box. Section 2 of `docs/deploy-runbook.md` installed `docker-ce` from Docker's repo. Debian's `docker.io` package differs.

Simulate the install first. An upgrade of `docker-ce`, `docker-ce-cli` or `containerd.io` restarts prod's daemon:

```bash
sudo apt-get -s install docker-ce-rootless-extras uidmap dbus-user-session slirp4netns nftables | grep '^Inst'
```

If the output lists one of those three packages, pin `docker-ce-rootless-extras` to the installed `docker-ce` version (`docker-ce-rootless-extras="$(dpkg-query -W -f='${Version}' docker-ce)"`) and simulate again. Then install:

```bash
sudo apt-get install docker-ce-rootless-extras uidmap dbus-user-session slirp4netns nftables

# The two host-wide changes and echosit's own limits (deploy/sit/).
uid="$(id -u echosit)"
sudo install -D -m 644 deploy/sit/delegate.conf /etc/systemd/system/user@.service.d/delegate.conf
sudo install -D -m 644 deploy/sit/user-slice.conf /etc/systemd/system/user.slice.d/50-sit-priority.conf
sudo install -D -m 644 deploy/sit/echosit-slice.conf "/etc/systemd/system/user-$uid.slice.d/50-sit-limits.conf"
sudo systemctl daemon-reload
sudo loginctl enable-linger echosit    # echosit's user manager, and its daemon, run without a login
```

Run the `deploy/sit/` commands from a directory that holds the `dev` copies of those files. Before SIT's first promotion, `main` (and so `/opt/echo`) does not have them yet:

```bash
sudo -u <prod-user> git -C /opt/echo fetch --quiet origin dev    # moves only origin/dev, not the checkout
cd "$(mktemp -d)" && mkdir -p deploy/sit
for f in delegate.conf user-slice.conf echosit-slice.conf echosit.nft echosit-nft.service user-at-nft.conf; do
  git -C /opt/echo show "origin/dev:deploy/sit/$f" > "deploy/sit/$f"
done
```

After the first promotion, `/opt/echo` has them and this is not needed.

Then, logged in as `echosit`:

```bash
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
echo 'export DOCKER_HOST=unix:///run/user/'"$(id -u)"'/docker.sock' >> ~/.bashrc
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info
cat "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers"
```

Expected:
- `docker info`: Security Options lists `rootless`, Cgroup Version is `2`, and there is no `WARNING: No cpu ...` or `No memory limit support` line.
- `cgroup.controllers` lists `cpuset cpu io memory pids`.

As the admin, `systemctl show "user-$uid.slice" -p CPUWeight -p CPUQuotaPerSecUSec -p MemoryHigh -p MemoryMax` shows the values from `echosit-slice.conf`.

**Rollback** of the two host-wide changes:

```bash
sudo rm /etc/systemd/system/user@.service.d/delegate.conf
sudo rm /etc/systemd/system/user.slice.d/50-sit-priority.conf
sudo systemctl daemon-reload
```

Remove echosit's own limits with `sudo systemctl revert "user-$(id -u echosit).slice"`.

### 3. Measure before settling the numbers

On prod, at idle and again during a video encode:

```bash
docker stats --no-stream
free -m
df -h
docker system df
```

- Memory: if idle prod plus SIT's 3 GB (`MemoryMax`) leaves no headroom on the 8 GB box, lower `MemoryHigh` and `MemoryMax` in `echosit-slice.conf`. Or have `deploy.sh` stop the SIT stack before it builds when `DEPLOY_BRANCH` is not `main`. A SIT outage during a deploy is fine.
- Disk: the rootless daemon shares no layers with the root one. It stores a second copy of the images, the build cache and the whisper model. `deploy.sh` keeps SIT's newest 3 image tags and prunes build cache older than 72 h.

Re-run `docker stats --no-stream` and `free -m` once SIT is up (step 5).

### 4. nftables and the isolation checks

Confirm prod's bridges sit inside `172.16.0.0/12`, the range the rule blocks:

```bash
docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

The box's firewall is ufw. Do not enable `nftables.service` or add to `/etc/nftables.conf`: Debian's stock file starts with `flush ruleset`, which would wipe ufw's and Docker's rules at boot. `deploy/sit/echosit.nft` touches only its own table, and its own unit loads it:

`echosit.nft` is a template. The rule matches echosit's uid and its whole subuid range (`@ECHOSIT_UID@`, `@ECHOSIT_SUBUIDS@`): echosit can enter a user namespace, switch to a subuid and still use the host's network. `/etc/subuid` must have exactly one `echosit` line.

```bash
uid="$(id -u echosit)"
subuids="$(awk -F: '$1 == "echosit" { print $2 "-" ($2 + $3 - 1) }' /etc/subuid)"
sed -e "s/@ECHOSIT_UID@/$uid/" -e "s/@ECHOSIT_SUBUIDS@/$subuids/" deploy/sit/echosit.nft > echosit.nft
sudo nft -c -f echosit.nft                             # syntax check, changes nothing
sudo install -m 644 echosit.nft /etc/echosit.nft
sudo install -m 644 deploy/sit/echosit-nft.service /etc/systemd/system/echosit-nft.service
systemctl cat user@.service | grep After=              # must name systemd-user-sessions.service
sudo systemctl daemon-reload
sudo systemctl enable --now echosit-nft.service
sudo nft list table inet echosit_guard
# Fail closed: echosit's user manager, and its Docker daemon, need the guard.
sudo install -D -m 644 deploy/sit/user-at-nft.conf "/etc/systemd/system/user@$uid.service.d/10-echosit-nft.conf"
sudo systemctl daemon-reload
systemctl show "user@$uid.service" -p Requires         # lists echosit-nft.service
```

The unit runs `Before=systemd-user-sessions.service`, so the rule is in place before echosit's user manager starts its daemon. If `user@.service` is not ordered after `systemd-user-sessions.service`, change the unit's `Before=` to match. The `user-at-nft.conf` drop-in stops echosit's user manager whenever the guard is not loaded.

Find prod Postgres's address on its bridge, for the checks below:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $(docker compose -f /opt/echo/compose.yaml ps -q postgres)
```

Isolation checks. Each command must fail, except the last:

```bash
for f in /opt/echo/.env*; do sudo -u echosit cat "$f"; done   # Permission denied for every file
sudo -u echosit cat /opt/echo/.git/config            # Permission denied, or a remote URL with no token in it
sudo -u echosit ls ~<prod-user>                      # Permission denied (VPS_USER's home: dumps, rclone config)
sudo -u echosit docker -H unix:///var/run/docker.sock ps   # permission denied
sudo -u echosit ls /var/lib/docker                   # Permission denied
sudo -u echosit curl -sS -m 5 http://127.0.0.1:8000/api/readyz   # Connection refused
sudo -u echosit curl -sS -m 5 http://127.0.0.1:8080/              # Connection refused
sudo -u echosit bash -c 'echo > /dev/tcp/<prod-pg-ip>/5432'        # Connection refused
sudo -u echosit curl -fsS -m 5 http://127.0.0.1:8001/api/readyz  # 200, once step 5 has run
```

Logged in as `echosit`, the subuid route must be blocked too (util-linux 2.38 or later). It must print `Connection refused`:

```bash
unshare --user --map-root-user --map-auto setpriv --reuid=1 --regid=1 --clear-groups \
  bash -c 'echo > /dev/tcp/127.0.0.1/8000'
```

Once step 5 has run, check from inside a SIT container too. As `echosit` in `~/echo-sit`, this must fail:

```bash
docker compose exec app python -c "import socket; socket.create_connection(('<prod-pg-ip>', 5432), timeout=5)"
```

**Rollback:** remove the `user@$uid.service.d/10-echosit-nft.conf` drop-in and run `sudo systemctl daemon-reload` first; otherwise the next step also stops echosit's user manager. Then `sudo systemctl disable --now echosit-nft.service` deletes the table. Then remove `/etc/echosit.nft` and the unit file.

### 5. First start

Logged in as `echosit`:

Give `echosit` its own read-only deploy key for the repo. Never a personal access token, and never prod's key:

```bash
ssh-keygen -t ed25519 -N '' -C echosit-github -f ~/.ssh/github_ro
printf 'Host github.com\n  IdentityFile ~/.ssh/github_ro\n  IdentitiesOnly yes\n' >> ~/.ssh/config
cat ~/.ssh/github_ro.pub    # GitHub: Settings -> Deploy keys -> Add, "Allow write access" unticked
```

```bash
git clone git@github.com:<owner>/<repo>.git ~/echo-sit && cd ~/echo-sit
git checkout dev
git fetch origin dev                               # must work: every deploy runs it
cp deploy/env.sit.example .env && chmod 600 .env   # fill in every <...>
docker compose up -d --build
curl -fsS http://127.0.0.1:8001/api/readyz
docker compose --profile tunnel up -d              # start SIT's cloudflared
```

`.env` notes:
- `COMPOSE_FILE` in it adds `deploy/compose.sit.yaml`, so plain `docker compose` commands pick up the override.
- Generate fresh secrets with `openssl rand`, as for prod. Never reuse prod's.
- The R2 keys are SIT's own bucket token (Cloudflare checklist below).

The CI deploy reads `SX_APP_PORT=8001` from this `.env` for its readiness check.

### 6. Probe accounts

Registering needs the verification mail, which only SIT's Mailpit sees. Create the two accounts once from your machine, through a tunnel to Mailpit:

```bash
ssh -L 8025:127.0.0.1:8025 echosit@<vps>     # leave it open
node scripts/verify_staging.cjs \
  --app https://sit.echomultiverse.com --media https://sit-media.echomultiverse.com \
  --email <probe-email> --peer <probe-peer-email> --password <probe-password> \
  --mailpit http://127.0.0.1:8025
```

Both addresses must be in `SX_REGISTRATION_ALLOWLIST`. Store them, and the password, as `SIT_PROBE_EMAIL`, `SIT_PROBE_PEER` and `SIT_PROBE_PASSWORD` in the `sit` environment. From then on, CI runs only log in.

The probe accounts count as `new` for the first `SX_TRUST_NEW_HOURS`, which caps publishes at 2 an hour. SIT's `.env` raises the `SX_NEW_PUBLISH_*` and `SX_NEW_UPLOAD_HOURLY_MAX` limits (see `deploy/env.sit.example`) so a run of dev pushes still passes.

The same tunnel opens Mailpit's UI at `http://127.0.0.1:8025` for password resets.

### 7. Sentry

SIT reports to the same Sentry project with `environment=sit`. The three alert rules (watchdog and low disk, high-priority issues, Seer pull requests) have their environment set to `production` (done 2026-11-13), so SIT errors do not page you. Give any new alert rule the same environment.

## Cloudflare checklist

Mirrors `docs/deploy-runbook.md` §Cloudflare.

- [ ] Tunnel `echo-sit`. Put its connector token into `TUNNEL_TOKEN`. Add the public hostname `sit.echomultiverse.com` with service `http://proxy:8000`, as prod uses. Leave HTTP Host Header empty. SIT's `cloudflared` runs on the SIT daemon's network, so `proxy` resolves to the SIT proxy.
- [ ] R2 bucket for SIT public media, location hint `apac`:
  - custom domain `sit-media.echomultiverse.com`
  - a 30-day lifecycle rule on `jobs/`
  - no CORS policy on the bucket: the Transform Rule below sets `Access-Control-Allow-Origin`, and a bucket policy would add a second copy of the header, which browsers reject and the probe flags
  - an app token scoped to this bucket only, with its four values in the SIT `.env`
- [ ] Transform Rule on `sit-media`: set a static `Access-Control-Allow-Origin: https://sit.echomultiverse.com` and `Vary: Origin`.
- [ ] Transform Rule on `sit`: set `X-Robots-Tag: noindex, nofollow`.
- [ ] Cache Rules: add the SIT hostnames to rule 1 (the `/api/` bypass) and rule 2 (cache everything for media), with `http.host in {...}`.

## Promotion

1. Merge feature branches into `dev`, as today. CI deploys SIT and runs the probe.
2. Test by hand on `https://sit.echomultiverse.com`, including on the Quest.
3. Fast-forward `main` to the tested `dev` commit, with `git push origin <sha>:main`, or with `git merge --ff-only` and a push. Never move `main` to a SHA whose `deploy-sit` job is not green.
4. The prod deploy job runs as today, on the same SHA, rebuilt on the VPS.
5. Hotfixes take the same path: into `dev`, through SIT, then onto `main`. Nothing is pushed straight to `main`, so the fast-forward always works.

This is a convention; GitHub does not enforce it.

## Day-to-day

- Stop SIT and free its RAM: `docker compose stop` as `echosit` in `~/echo-sit`. The next `dev` deploy starts it again (`up -d`).
- Logs: `docker compose logs --tail 100 app` as `echosit` in `~/echo-sit`.
- Rollback to an earlier SIT build: `deploy.sh` keeps the newest 3 `echo-app:<sha>` tags. Retag one as `echo-app:latest`, then run `docker compose up -d`.
- Use SIT to try the "anonymous list responses" Cache Rule before it goes on prod (`docs/deploy-runbook.md`).

## Known limits

- The disk is shared and not split by user. If SIT fills it, prod is hurt too. `SX_DISK_MIN_FREE_GB=10` and the tag pruning reduce this risk, but do not remove it.
- `io.weight` takes effect only under the BFQ scheduler. The VPS disk most likely uses `none` or `mq-deadline`, so SIT disk I/O is probably not deprioritised.
- Rootless networking (slirp4netns or pasta) is slower than the root bridge. That is acceptable for SIT.
- SIT has no platform fal key: platform generation reports "temporarily unavailable". A tester's own fal key (BYOK) still works.
- `web/index.html` preconnects to `media.echomultiverse.com`. On SIT this does nothing useful and causes no harm.
