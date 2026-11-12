# Deploy runbook — invite-only beta

One OVHcloud VPS (VPS-2 in Hillsboro, Oregon: 4 vCPU / 8 GB / 75 GB) runs `compose.yaml`: the app (`app`), its read-only processes (`app-read`), the proxy that splits requests between them (`proxy`), `postgres:16` and `cloudflared`. Nothing listens on a public port. Traffic arrives through a Cloudflare Tunnel, and public media is served from a Cloudflare R2 bucket on `media.<domain>`.

Related docs:
- `deploy/env.example`: the production `.env` template.
- `docs/backup-restore-runbook.md`: nightly backups and the restore drill.
- `docs/manual-beta-checks.md`: the manual checks to run before inviting users.
- `docs/to-beta.md`: release blockers and infrastructure verdicts.
- `docs/sit-runbook.md`: SIT (`sit.echomultiverse.com`), where every `dev` push deploys before promotion to `main`.

## 1. One-time dashboard checklist

Complete each item once per environment. Tick it in your own copy of this list.

**Production progress (2026-11-07).** The domain `echomultiverse.com` is registered at Cloudflare and live through the Tunnel. The Cloudflare steps below are all done.
- Done:
  - Cloudflare account, with a payment method on file (R2 requires one).
  - R2 public bucket `publicmedia` and the private backup bucket, both with location hint `apac`. `r2.dev` is not enabled.
  - Two Account API tokens, each with Object Read & Write scoped to one bucket. The app token's four `R2_*` values are in `.env`. A list/put/get/delete test with the app's client (`server/media_store.py`) passed.
  - Tunnel created and its token in `TUNNEL_TOKEN`. The token decodes, and its account matches `R2_ACCOUNT_ID`. The dashboard shows "Waiting for your Tunnel to connect" until cloudflared runs on the VPS.
  - fal account, with a spend limit and prepaid credit. `FAL_KEY` is in `.env`.
  - Sentry project `ledhoang/videoextendersquare-server`, with its DSN in `SENTRY_DSN`. The "Server watchdog: ALERT / Low disk space" alert rule emails on a new issue, and a test event delivered the email. A smoke test confirmed that traces, logs and metrics arrive, and that outbound query strings are stripped.
  - VPS (2026-10-29): OVHcloud VPS-2 in Hillsboro, Debian 13, provisioned and hardened (section "OVHcloud VPS" below). Docker is installed and the repo is cloned to `/opt/echo`.
  - Server `.env` (2026-10-29): built from `deploy/env.example`. The secrets were generated on the VPS with `openssl rand`, and a copy is kept off the box. The `<domain>` URL values and SMTP are still placeholders.
  - App and Postgres (2026-10-29): `docker compose up -d --build` runs both, healthy. The app listens on `127.0.0.1:8000` only. `/api/readyz` reports the database ok at schema `20261022_0017` and the output directory writable. cloudflared is not started yet.
- Done with the domain (2026-11-07):
  - the Tunnel public hostname `echomultiverse.com` → `http://proxy:8000`, with cloudflared running;
  - the `media.echomultiverse.com` custom domain, the `jobs/` lifecycle rule and CORS;
  - the Transform Rule, the Cache Rules, SSL/TLS Full and Always Use HTTPS;
  - the 30-day lifecycle rule on the backup bucket;
  - `SX_PUBLIC_URL`, `SX_PUBLIC_BASE_URL` and `SX_MEDIA_BASE_URL` in the VPS `.env`, app restarted.
  - Checked with curl: HTTP→HTTPS 301; `/api/*` always `cf-cache-status: DYNAMIC` (until the anonymous list rule below is applied); media returns 206 with ACAO, `Vary: Origin` and `Content-Range`, and `MISS` then `HIT`.
- Origin traffic is restricted to the Tunnel (checked 2026-11-07): ufw allows only 22/tcp, the app listens on loopback only, and a forged `CF-Connecting-IP` is rejected by Cloudflare.
- HSTS is on (2026-11-07): `max-age=2592000`, 1 month, the lowest the dashboard offers; no includeSubDomains, no preload.
- Still open: SMTP. The restore drill and the nightly backup to the private bucket are done (2026-11-01).

### Cloudflare

- [x] **Tunnel.** Go to Zero Trust → Networks → Tunnels and create a tunnel. Copy its connector token into `TUNNEL_TOKEN` in `.env`.
  - Add a public hostname: `<domain>` → service `http://proxy:8000`. `proxy` is the compose service name (section "Read service" below).
  - Leave **HTTP Host Header** empty, which is the default. cloudflared then keeps the browser's `Host`. `validate_origin` in `server/social/auth.py` compares `Origin` with `Host`, so every mutating request returns 403 `ORIGIN_DENIED` if you override `Host`.
- [x] **R2 public bucket.** Create it with location hint **`apac`** (Asia-Pacific).
  - Connect the custom domain `media.<domain>`. Do not enable the `r2.dev` URL.
  - Set `R2_PUBLIC_BUCKET` and `SX_MEDIA_BASE_URL=https://media.<domain>`.
  - Add a lifecycle rule that deletes objects with the prefix `jobs/` after **30 days**. Completed job results live there (`docs/storage-design.md` §Job results).
- [x] **R2 private backup bucket.** Create it with location hint `apac`, and leave it with no public access and no custom domain.
  - Add a lifecycle rule that deletes objects after **30 days**.
- [x] **R2 API tokens.** Create two tokens:
  - The app token: Object Read & Write, scoped to the **public bucket only**. It goes into `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
  - The backup token: Object Read & Write, scoped to the **backup bucket only**. It goes into the host's rclone config only, never into `.env`.
- [x] **Public bucket CORS policy:**
  ```json
  [
    {
      "AllowedOrigins": ["https://<domain>"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
      "MaxAgeSeconds": 86400
    }
  ]
  ```
- [x] **Response Header Transform Rule on `media.<domain>`.** Go to Rules → Transform Rules → Modify Response Header.
  - When the hostname equals `media.<domain>`, *set static* `Access-Control-Allow-Origin: https://<domain>`.
  - Also set `Vary: Origin`.
  - Why the rule is needed:
    - React `<video>` and `<img>` tags send no `crossorigin`, so the first request for an object carries no `Origin`.
    - R2 then answers without ACAO, and the edge caches that copy.
    - WebXR loads the same URL with `crossOrigin = "anonymous"` and gets the cached copy without ACAO. The texture is tainted and the reel renders black.
    - A static header makes every cached copy CORS-safe, whichever request filled the cache.
- [x] **Cache Rules** (Caching → Cache Rules), in this order:
  1. When the hostname is `<domain>`, the URI path starts with `/api/` and does **not** start with `/api/reels/map-tiles/`: **Bypass cache**. Without this rule, authenticated JSON and SSE could be cached at the edge.
  2. When the hostname is `media.<domain>`: **Eligible for cache** ("Cache Everything"), with edge TTL respecting origin or 1 day.
  - Map tiles (`/api/reels/map-tiles/*`) stay cacheable. They are public, and the app sends cache headers for them.
- [ ] **Cache Rule for anonymous list responses (not applied yet).** It lets the edge answer anonymous visitors from the nearest colo instead of Oregon, about 200 ms per request from Asia (`docs/perf-probes/2026-11-11/bottlenecks.md`, fix 5).
  - What the app sends (`server/edge_cache.py`), for `GET` and `HEAD` of exactly `/api/reels`, `/api/reels/tags`, `/api/reels/locations` and `/api/config`:
    - no `echo_session` cookie, status 200, no `refresh` parameter: `Cache-Control: public, max-age=0, s-maxage=30`;
    - anything else (a session cookie, valid or not; an error; `refresh=true`): `Cache-Control: private, no-store`;
    - `Vary: Cookie` on both.
  - Why only these four: an anonymous response of each has no viewer fields and depends only on the URL. Auth is the `echo_session` cookie only, and none of them sets a cookie. `/api/reels/feed`, `/api/reels/tags/<tag>`, `/api/reels/locations/<key>`, `/api/reels/locations/activity` and `/api/config/models` are not included.
  - The cookie check in the expression is the only guard at the edge. As far as we know, Cloudflare ignores `Vary: Cookie` when it builds the cache key, so a rule without the cookie check would serve one cached copy to everybody. The app still marks signed-in responses `private, no-store` in case the rule is wrong.
  - Steps:
    1. Edit rule 1 so it leaves these requests out. Append to its expression:
       ```
       and not (http.request.uri.path in {"/api/reels" "/api/reels/tags" "/api/reels/locations" "/api/config"} and not http.cookie contains "echo_session=")
       ```
    2. Add a rule after rule 1, named "Anonymous list responses":
       - Expression:
         ```
         (http.host eq "<domain>" and http.request.method in {"GET" "HEAD"} and http.request.uri.path in {"/api/reels" "/api/reels/tags" "/api/reels/locations" "/api/config"} and not http.cookie contains "echo_session=")
         ```
       - Cache eligibility: **Eligible for cache**.
       - Edge TTL: **Use cache-control header if present, bypass cache if not**. The app's `s-maxage=30` sets the TTL. Errors and signed-in responses carry `no-store`, so they are never stored.
       - Browser TTL: **Respect origin TTL**. A zone-wide Browser Cache TTL must not raise `max-age=0`, or a browser would show the anonymous list after sign-in.
       - Cache key: leave the default. The query string is part of the key, and the key must not ignore it.
    - Use exact paths (`in {...}`), never "starts with". A prefix would also catch `/api/reels/feed` and `/api/config/models`.
    - Edits to rule 1 make the order safe either way. Cloudflare applies every matching Cache Rule in order, and a later rule overrides an earlier one's setting.
  - Verify after applying:
    ```bash
    curl -s -o /dev/null -D - 'https://<domain>/api/reels/tags' | grep -iE 'cf-cache-status|cache-control'
    curl -s -o /dev/null -D - 'https://<domain>/api/reels/tags' | grep -iE 'cf-cache-status|cache-control'
    curl -s -o /dev/null -D - -H 'Cookie: echo_session=x' 'https://<domain>/api/reels/tags' | grep -iE 'cf-cache-status|cache-control'
    curl -s -o /dev/null -D - 'https://<domain>/api/reels/feed' | grep -iE 'cf-cache-status'
    ```
    Expect `MISS` then `HIT` with `public, max-age=0, s-maxage=30` unchanged. With the cookie, expect `DYNAMIC` (or `BYPASS`) and `private, no-store`. `/api/reels/feed` stays `DYNAMIC`.
  - Signed in, the site must still show your likes, saves and follows after a reload. Sign out, then check that the feed shows none of them.
  - What goes stale for anonymous visitors, per colo, for up to 30 s: a new post, a removed or hidden post, counts (likes, views), tag and location suggestions, and the kill-switch state in `/api/config`. Publishing clears the app's own caches, and the app filters hidden posts on every request, so for those the edge TTL is the whole delay. Counts can lag 10 s more, from the app's reel-record cache. The kill switch is enforced on the server, so a stale `/api/config` only shows a job button as on for up to 30 s. Signed-in viewers see no added staleness.
  - To roll back, disable the new rule. Rule 1 then sends the four paths to the default behaviour, which does not cache JSON.
- [ ] **Map tiles: keep OpenStreetMap for the beta.** The tile proxy (`server/routers/map_tiles.py`) defaults to the keyless OSM standard tiles. It meets the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) at invite-only scale:
  - it sends an identifying `User-Agent`;
  - it fetches each tile upstream at most once and caches it on disk;
  - a per-IP guard stops clients from enumerating tiles through the proxy;
  - the edge caches tiles too (the Cache Rule above).
  - Attribution is a license requirement. Every tile response carries `X-Map-Attribution`, and the VR map shows "© OPENSTREETMAP" (from `/api/reels/map-tiles/attribution`) whenever tiles are visible. Keep it visible if the map UI changes.
  - If OSM blocks or rate-limits the server, the Earth view still works: the globe uses the bundled texture, and city zoom falls back to "MAP OFFLINE — CITY VIEW".
  - **Before the public launch**, switch to a provider with a commercial plan by setting `SX_MAP_TILES_URL` (and `SX_MAP_LABELS_URL` for split label layers, for example keyed CARTO or Esri), and update the attribution and the privacy page.
- [x] **SSL/TLS:**
  - Set the mode to Full.
  - Turn on **Always Use HTTPS**.
  - **HSTS: done (2026-11-07).** Turned on after HTTPS was verified on both hosts, at 1 month (the dashboard has no shorter value). includeSubDomains and preload are off, and preload stays off for the beta.

### OVHcloud VPS

- [x] **Firewall (2026-10-29).** `ufw default deny incoming` and `ufw allow 22/tcp`, so inbound is **TCP 22 only**. The app port 8000 is bound to `127.0.0.1` in `compose.yaml`, so Docker's habit of bypassing ufw for published ports does not expose it. The Tunnel is outbound-only.
- [x] **Updates and SSH (2026-10-29).** `unattended-upgrades` is enabled. SSH accepts keys only, set in `/etc/ssh/sshd_config.d/01-hardening.conf`. Keep the `01-` prefix: `50-cloud-init.conf` turns password auth on, and sshd keeps the first value it reads.

### Alerts

- [ ] **fal.ai.** On the dashboard, set a spend limit and an alert for the platform `FAL_KEY`.
- [ ] **UptimeRobot.** Add an HTTPS monitor on `https://<domain>/api/readyz`. It returns 200 when the DB is reachable and 503 when it is not. Alert by email or push.
- [ ] **Sentry.** Create a project and set `SENTRY_DSN`. Releases are tagged with `GIT_SHA`, which is passed as a build arg.
  The in-app watchdog (`SX_ALERT_*`) and the low-disk check log errors, and Sentry turns those into events.
  In Sentry, add an alert rule that notifies you on every new issue whose message starts with `ALERT ` or `Low disk space`.
  The same DSN also sends traces (`SENTRY_TRACES_SAMPLE_RATE`, default 0.2; health checks are skipped), INFO+ logs, and the watchdog counters as metrics. All of these fit in the free Developer plan. Profiling is not included in that plan, so it stays off.
  After the domain is live, add a Sentry uptime monitor on `https://<domain>/api/readyz` (the free plan includes one). It can replace UptimeRobot.
- [ ] **Backups.** Set `BACKUP_SENTRY_CRON_URL` for `deploy/backup.sh`, which creates a Sentry cron monitor on the first run. A healthchecks.io check (`BACKUP_PING_URL`) also works.

### Secret escrow

Store these in a password manager **outside the VPS** before the first user signs up:

- [ ] `SX_SECURITY_SECRET`
- [ ] `SX_MESSAGE_ENCRYPTION_KEY`. Losing it makes every DM and all report evidence unreadable.
- [ ] `SX_FAL_KEY_ENCRYPTION_KEY`. Losing it makes saved per-user fal keys unreadable.
- [ ] The R2 app token and the R2 backup token.
- [ ] `TUNNEL_TOKEN`.
- [ ] `POSTGRES_PASSWORD`.

A database backup is useless without the first three secrets (`docs/backup-restore-runbook.md`).

## 2. First deploy

Run these as a non-root sudo user on the VPS.

```bash
# Docker Engine + compose plugin (docs.docker.com/engine/install/debian) and rclone
# from rclone.org (the Debian package is too old for R2; docs/backup-restore-runbook.md), then:
sudo mkdir -p /opt/echo && sudo chown "$USER" /opt/echo
git clone <repo-url> /opt/echo && cd /opt/echo
cp deploy/env.example .env && chmod 600 .env    # fill in every <...>
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker compose up -d                              # app + postgres, loopback only
curl -fsS http://127.0.0.1:8000/api/readyz        # 200 = DB reachable
docker compose --profile tunnel up -d             # start cloudflared
```

If the app exits immediately, read `docker compose logs app`. With `SX_ENV=production`, the boot check lists every missing or unsafe value at once.

The entrypoint runs `alembic upgrade head` on every start. It then starts **one** uvicorn worker. Never scale the `app` service or add `--workers` to it: JobManager and the staged-upload registries are in-process. Read capacity is added with `app-read` instead (section "Read service" below).

## 3. Routine deploy

```bash
cd /opt/echo && git pull
git diff --stat HEAD@{1} HEAD -- migrations/      # non-empty: take a pre-deploy dump first
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker tag echo-app:latest "echo-app:$(git rev-parse --short=12 HEAD)"   # kept for rollback
docker compose --profile tunnel up -d
docker compose ps                                  # app should turn "healthy"
```

Rollback, the pre-deploy dump and migrations: `docs/incident-response.md`.

### Automatic deploy from CI

A push to `main` runs the CI checks, and when all four pass the `deploy` job in `.github/workflows/ci.yml` SSHes to the VPS and runs `deploy/deploy.sh` for that commit. It does the steps above, takes the pre-deploy dump when `migrations/` changed, and waits for `/api/readyz`. A push to `dev`, or a pull request, runs the same checks and never deploys. The script refuses to run if the VPS checkout is not on `main`.

One-time setup:

1. Use the VPS user that owns `/opt/echo` and is in the `docker` group (the deploy writes to the checkout and reads `.env`). Add the public half of a new SSH key, used only by CI, to its `~/.ssh/authorized_keys`. Password auth is already off. Check that `git fetch origin main` works for that user in `/opt/echo`.
2. In GitHub, create an environment named `production`. Optionally add a required reviewer there to gate each deploy.
3. Add these Actions secrets (to the `production` environment): `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (the private key) and `VPS_KNOWN_HOSTS` (the output of `ssh-keyscan -t ed25519 <host>`, run from a machine you trust).

The job does not know whether the job queue is idle, so an automatic deploy can drop in-flight jobs (see below). Merge to `main` when the queue is quiet.

A restart drops in-flight jobs and staged uploads, because both live in container `/tmp`. Completed jobs are read back from R2. Deploy when the job queue is idle.

## 4. Operations

| Task | Command |
|---|---|
| Tail logs | `docker compose logs -f --tail=200 app` (`app-read` and `proxy` have their own) |
| Check CPU and memory | `docker stats` |
| Check ffmpeg niceness | `docker compose exec app ps -o ni,comm -C ffmpeg` |
| Open a psql shell | `docker compose exec postgres psql -U echo echo` |
| Check the schema revision | `docker compose exec app alembic current`. Expect `20261101_0020`. |
| Check disk | `df -h /` and `docker system df` |

Logs rotate at 10 MB × 5 files per service (json-file driver).

Resource caps:
- app: 3 CPUs, 6 GB memory. ffmpeg also runs under `nice 10`.
- app-read: 2 CPUs, 2 GB memory, for `SX_READ_WORKERS` processes (default 2).
- postgres: 1.5 CPUs.

The caps add up to more than the 4 vCPUs. Each is a ceiling, not a reservation: the readers use what the writer and encodes leave idle. Encodes cannot starve the database.

Health checks:
- The Docker HEALTHCHECK calls `/api/healthz` every 30 s, with a 10 s timeout and 3 retries. After about 90 s with no answer, the container is marked unhealthy. `restart: unless-stopped` restarts the app only when it exits, not when it is unhealthy.
- `/api/healthz` is async and does no I/O, so it stays fast when sync handlers fill the threadpool. Under 100 load-test users before this change, it waited for a threadpool slot: p95 2.2 s, max 3.3 s, against the old 4 s probe timeout. After the change: p95 0.2 s, max 0.4 s (1.1 s p95 right after a restart).
- `/api/readyz` checks the DB and storage. It still runs in the threadpool and uses a pool connection, so it slows down under load. It is for humans and scripts, not the HEALTHCHECK.
- `/api/health` (ffmpeg probes, cached 60 s) rebuilds in one request at a time. Other polls get the previous snapshot meanwhile.
- The app service sets `init: true`. tini runs as PID 1 and reaps orphaned processes. Before, they stayed as `[python] <defunct>`. To check: `docker compose exec app ps -eo stat,args | grep -c defunct`. Expect `0`.

## 5. Takedowns

Removing a post only hides it in the app. Its R2 objects stay, and their URLs keep working for anyone who has them. **The Cloudflare edge can also keep serving a cached copy for up to 1 day.** For an urgent takedown (CSAM, legal request, doxxing):

1. Remove the content in the app (admin delete).
2. Delete the post's objects in R2: in `/moderation` → CONTENT, find the removed post and press **PURGE MEDIA** (admin only). It deletes every object of the post (video, poster, previews, web proxy, stereo variants, slides) and lists their URLs. It cannot be undone and the post cannot be restored afterwards. It does not delete the job result under `jobs/<hash>/` (public, removed by the lifecycle rule after 30 days) or the source copy in the log bucket: open the post under UPLOAD LOGS to find both, and delete them in R2 by hand when the case requires it. If the bucket cannot be reached it answers 503 and changes nothing; then delete `uploads/<stem>.<ext>` and every `uploads/<stem>-*` object by hand in R2 (`posts.media_files` lists every key).
3. Go to Cloudflare → Caching → Configuration → **Custom Purge** → purge by URL. Purge every URL that PURGE MEDIA listed.
   - Once the anonymous list rule is applied, the edge also keeps listing a removed post to anonymous visitors for up to 30 s per colo (in `/api/reels`, tag and location suggestions). That expires by itself, and purge by URL cannot reach every query-string variant. If it cannot wait 30 s, use **Purge Everything** for the zone. That also empties the media cache, so R2 serves every object again once.
4. Verify the takedown:
   ```bash
   curl -sI https://media.<domain>/<key>
   ```
   Expect `404`, with no `cf-cache-status: HIT`.

## 6. Read service

One process cannot use more than one core, and the `app` service must stay one process. `app-read` runs more processes of the same image with `SX_ROLE=reader`, and `proxy` (Caddy, `deploy/Caddyfile`) decides per request which service answers. The reasons and the code-side list are in `server/read_routes.py`.

**What goes where**

| Request | Served by |
|---|---|
| `GET` of `/api/reels`, `/api/reels/feed`, `/api/reels/player`, `/api/reels/player-inline`, `/api/reels/tags` or `/api/recommendations/creators`, with no `echo_session` cookie | `app-read` |
| The same while `app-read` is down or restarting | `app` (the proxy falls back within 3 s) |
| Everything else: signed-in requests, every write, jobs, uploads, SSE, admin, the SPA | `app` |

A reader refuses any other request with 404 `NOT_ON_READER`, so a mistake in the proxy rule cannot reach a write route on a reader. It runs no migrations, jobs, encodes or periodic tasks, and mounts `data` and `output` read-only.

**What differs on a reader**

- **Staleness, at most 10 s.** A reader does not hear the writer's cache invalidation. A new or edited post, a comment or a like count can be up to 10 s old for an anonymous visitor. Deleted, unpublished and blocked posts are filtered by a query on every request, so a takedown applies at once. Signed-in users are served by the writer and see their own writes at once.
- **Rate limits.** The 60 per minute limits on the feed and on creators are counted in the `rate_limit_events` table, so they hold over all processes together. This costs one more insert and commit per feed or creators request. The writer's cleanup loop deletes rows older than one hour.
- **Metrics.** `/admin` Overview and the alert watchdog (`SX_ALERT_*`) count the writer's requests only. Reader requests are in `docker compose logs app-read` (`sx.access` lines) and in Sentry traces.
- **Database connections.** Each process holds up to 15 (pool 5 plus 10 overflow): 15 for the writer plus 15 per reader process, against Postgres's default of 100. Keep `SX_READ_WORKERS` at 4 or lower.

**Sizing.** `SX_READ_WORKERS` in `.env` sets the number of reader processes (default 2). Raise the `cpus` cap of `app-read` in `compose.yaml` with it: one core per process.

**Ports on the VPS.** `127.0.0.1:8000` is the writer alone, as before; `deploy/deploy.sh` waits for `/api/readyz` there. `127.0.0.1:8080` (`SX_PROXY_PORT`) is the proxy, which is what visitors get.

**Turning it on in production (one time).** A deploy starts `app-read` and `proxy`, but visitors keep reaching `app` directly until the Tunnel points at the proxy:

1. Deploy, then check both paths on the VPS:
   ```bash
   docker compose ps                                              # app, app-read, proxy up
   curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/readyz    # 200, from the writer
   curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/reels      # 200, from a reader
   docker compose logs --tail=5 app-read | grep sx.access          # the /api/reels line is here
   ```
2. In Zero Trust → Networks → Tunnels → the tunnel → Public hostname, change the service from `http://app:8000` to `http://proxy:8000`. Leave **HTTP Host Header** empty, as before.
3. Load the site signed out and signed in, publish a post, and watch `docker compose logs -f proxy app-read` for errors.

**Turning it off.** Change the public hostname back to `http://app:8000`. Nothing else has to change; `app` serves every route by itself. `docker compose stop app-read` alone also works: the proxy then sends reads to the writer.

**Adding a route to the readers.** Add the path to `READ_PATHS` in `server/read_routes.py` and to the `@read` matcher in `deploy/Caddyfile` (a test keeps the two equal). The route must be a GET with no other method on the same path, must keep nothing in process memory that another process needs, and any rate limit it checks must pass `shared=True`.
