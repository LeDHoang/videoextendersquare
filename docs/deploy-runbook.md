# Deploy runbook — invite-only beta

One Hetzner VPS (SIN, CPX32: 4 vCPU / 8 GB) runs `compose.yaml`: the app, `postgres:16` and `cloudflared`. Nothing listens on a public port. Traffic arrives through a Cloudflare Tunnel, and public media is served from a Cloudflare R2 bucket on `media.<domain>`.

Related docs:
- `deploy/env.example`: the production `.env` template.
- `docs/backup-restore-runbook.md`: nightly backups and the restore drill.
- `docs/manual-beta-checks.md`: the manual checks to run before inviting users.
- `docs/to-beta.md`: release blockers and infrastructure verdicts.

## 1. One-time dashboard checklist

Complete each item once per environment. Tick it in your own copy of this list.

### Cloudflare

- [ ] **Tunnel.** Go to Zero Trust → Networks → Tunnels and create a tunnel. Copy its connector token into `TUNNEL_TOKEN` in `.env`.
  - Add a public hostname: `<domain>` → service `http://app:8000`. `app` is the compose service name.
  - Leave **HTTP Host Header** empty, which is the default. cloudflared then keeps the browser's `Host`. `validate_origin` in `server/social/auth.py` compares `Origin` with `Host`, so every mutating request returns 403 `ORIGIN_DENIED` if you override `Host`.
- [ ] **R2 public bucket.** Create it with location hint **`apac`** (Asia-Pacific).
  - Connect the custom domain `media.<domain>`. Do not enable the `r2.dev` URL.
  - Set `R2_PUBLIC_BUCKET` and `SX_MEDIA_BASE_URL=https://media.<domain>`.
- [ ] **R2 private backup bucket.** Create it with location hint `apac`, and leave it with no public access and no custom domain.
  - Add a lifecycle rule that deletes objects after **30 days**.
- [ ] **R2 API tokens.** Create two tokens:
  - The app token: Object Read & Write, scoped to the **public bucket only**. It goes into `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
  - The backup token: Object Read & Write, scoped to the **backup bucket only**. It goes into the host's rclone config only, never into `.env`.
- [ ] **Public bucket CORS policy:**
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
- [ ] **Response Header Transform Rule on `media.<domain>`.** Go to Rules → Transform Rules → Modify Response Header.
  - When the hostname equals `media.<domain>`, *set static* `Access-Control-Allow-Origin: https://<domain>`.
  - Also set `Vary: Origin`.
  - Why the rule is needed:
    - React `<video>` and `<img>` tags send no `crossorigin`, so the first request for an object carries no `Origin`.
    - R2 then answers without ACAO, and the edge caches that copy.
    - WebXR loads the same URL with `crossOrigin = "anonymous"` and gets the cached copy without ACAO. The texture is tainted and the reel renders black.
    - A static header makes every cached copy CORS-safe, whichever request filled the cache.
- [ ] **Cache Rules** (Caching → Cache Rules), in this order:
  1. When the hostname is `<domain>`, the URI path starts with `/api/` and does **not** start with `/api/reels/map-tiles/`: **Bypass cache**. Without this rule, authenticated JSON and SSE could be cached at the edge.
  2. When the hostname is `media.<domain>`: **Eligible for cache** ("Cache Everything"), with edge TTL respecting origin or 1 day.
  - Map tiles (`/api/reels/map-tiles/*`) stay cacheable. They are public, and the app sends cache headers for them.
- [ ] **Map tiles: keep OpenStreetMap for the beta.** The tile proxy (`server/routers/map_tiles.py`) defaults to the keyless OSM standard tiles. It meets the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) at invite-only scale:
  - it sends an identifying `User-Agent`;
  - it fetches each tile upstream at most once and caches it on disk;
  - a per-IP guard stops clients from enumerating tiles through the proxy;
  - the edge caches tiles too (the Cache Rule above).
  - Attribution is a license requirement. Every tile response carries `X-Map-Attribution`, and the VR map shows "© OPENSTREETMAP" (from `/api/reels/map-tiles/attribution`) whenever tiles are visible. Keep it visible if the map UI changes.
  - If OSM blocks or rate-limits the server, the Earth view still works: the globe uses the bundled texture, and city zoom falls back to "MAP OFFLINE — CITY VIEW".
  - **Before the public launch**, switch to a provider with a commercial plan by setting `SX_MAP_TILES_URL` (and `SX_MAP_LABELS_URL` for split label layers, for example keyed CARTO or Esri), and update the attribution and the privacy page.
- [ ] **SSL/TLS:**
  - Set the mode to Full.
  - Turn on **Always Use HTTPS**.
  - Turn on **HSTS** only after HTTPS is verified end to end on both hosts. Start with a short `max-age`, and do not turn on preload for the beta.

### Hetzner

- [ ] **Firewall.** Allow inbound **TCP 22 only**, ideally from your own IPs. The app port 8000 is bound to `127.0.0.1` in `compose.yaml`, and the Tunnel is outbound-only.
- [ ] Enable automatic security updates (`unattended-upgrades`). Use SSH key auth only.

### Alerts

- [ ] **fal.ai.** On the dashboard, set a spend limit and an alert for the platform `FAL_KEY`.
- [ ] **UptimeRobot.** Add an HTTPS monitor on `https://<domain>/api/readyz`. It returns 200 when the DB is reachable and 503 when it is not. Alert by email or push.
- [ ] **Sentry.** Create a project and set `SENTRY_DSN`. Releases are tagged with `GIT_SHA`, which is passed as a build arg.
- [ ] **Backups.** Optionally add a healthchecks.io check, and set `BACKUP_PING_URL` for `deploy/backup.sh`.

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
# Docker Engine + compose plugin (docs.docker.com/engine/install/debian) and rclone, then:
sudo mkdir -p /opt/echo && sudo chown "$USER" /opt/echo
git clone <repo-url> /opt/echo && cd /opt/echo
cp deploy/env.example .env && chmod 600 .env    # fill in every <...>
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker compose up -d                              # app + postgres, loopback only
curl -fsS http://127.0.0.1:8000/api/readyz        # 200 = DB reachable
docker compose --profile tunnel up -d             # start cloudflared
```

If the app exits immediately, read `docker compose logs app`. With `SX_ENV=production`, the boot check lists every missing or unsafe value at once.

The entrypoint runs `alembic upgrade head` on every start. It then starts **one** uvicorn worker. Never scale the app service or add `--workers`: JobManager and the staged-upload registries are in-process.

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

A restart drops in-flight jobs and staged uploads, because both live in container `/tmp`. Deploy when the job queue is idle.

## 4. Operations

| Task | Command |
|---|---|
| Tail logs | `docker compose logs -f --tail=200 app` |
| Check CPU and memory | `docker stats` |
| Check ffmpeg niceness | `docker compose exec app ps -o ni,comm -C ffmpeg` |
| Open a psql shell | `docker compose exec postgres psql -U echo echo` |
| Check the schema revision | `docker compose exec app alembic current`. Expect `20261020_0014`. |
| Check disk | `df -h /` and `docker system df` |

Logs rotate at 10 MB × 5 files per service (json-file driver).

Resource caps:
- app: 3 CPUs, 6 GB memory. ffmpeg also runs under `nice 10`.
- postgres: 1.5 CPUs.

Encodes cannot starve the database.

## 5. Takedowns

Deleting a post deletes its R2 object. However, **the Cloudflare edge can keep serving a cached copy for up to 1 day**. For an urgent takedown (CSAM, legal request, doxxing):

1. Remove the content in the app (admin delete).
2. Go to Cloudflare → Caching → Configuration → **Custom Purge** → purge by URL. Purge every `https://media.<domain>/...` URL of the post: the video, the poster, the preview and any stereo variants.
3. Verify the takedown:
   ```bash
   curl -sI https://media.<domain>/<key>
   ```
   Expect `404`, with no `cf-cache-status: HIT`.
