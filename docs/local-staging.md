# Local staging (free production rehearsal)

A production-mode copy of the beta stack that runs on a laptop and costs nothing.
It runs the same image, `SX_ENV=production` boot checks, PostgreSQL 16, invite-only
sign-up and capacity limits as `compose.yaml` on the VPS. Only the paid or external
edges are replaced:

| Production | Local staging | Files |
|---|---|---|
| Cloudflare R2 public + backup buckets | SeaweedFS S3 (`objectstore`, buckets `echo-public`, `echo-backups`) | `deploy/compose.staging.yaml` |
| `media.<domain>` custom domain + Transform Rule (static ACAO) | Caddy on `https://localhost:9443` (`header_down` replaces CORS headers, like "set static") | `deploy/Caddyfile.staging` |
| `https://<domain>` through the Cloudflare Tunnel | Caddy on `https://localhost:8443` (internal CA) | `deploy/Caddyfile.staging` |
| SMTP provider | Mailpit, inbox UI on `http://127.0.0.1:8025` | `deploy/compose.staging.yaml` |
| `/etc/echo-backup.env` + host rclone remote | `rclone` service in the `tools` profile | `deploy/compose.staging.yaml` |

The app reaches SeaweedFS through `R2_ENDPOINT_URL` (`server/media_store.py`). That
variable is unset in production, where the endpoint comes from `R2_ACCOUNT_ID`.

## What it cannot prove

These still need the real accounts listed in `docs/to-beta.md`:

- Cloudflare edge behaviour: `cf-cache-status: HIT`, the Transform Rule on cached
  copies, purge-by-URL, the 100 MB request limit and the 100 s origin timeout.
- Real R2 (needs a payment method on the Cloudflare account) and the named Tunnel
  (needs a domain on Cloudflare).
- VPS timings. An Apple-silicon laptop under the same `cpus: 3` cap is a
  *lower bound* for the VPS, not an equivalent.
- Quest over the network on a trusted HTTPS origin. Caddy's local CA is not
  trusted by the headset; use `adb reverse` (RUNNING.md, Meta Quest section) or a
  free Tailscale Funnel URL. A trycloudflare Quick Tunnel does not work: it does
  not carry Server-Sent Events, which jobs and messaging use.

## Start

```bash
cp deploy/env.staging.example .env.staging && chmod 600 .env.staging
# Replace every <...>: openssl rand -hex 32 for each one.
docker compose --env-file .env.staging up -d --build
node scripts/verify_staging.cjs
```

`--env-file .env.staging` sets `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME=echo-staging`
and `SX_ENV_FILE`, so every `docker compose --env-file .env.staging ...` command
targets the staging project and never touches a production `.env`. The app's
loopback port is `127.0.0.1:8001` (`SX_APP_PORT`), so a dev server on 8000 keeps
running.

Browsers warn about the Caddy certificate. Accept it once for both
`https://localhost:8443` and `https://localhost:9443`. If you do not, media loads
fail with a certificate error.

Invited addresses are `alice@example.com` (admin) and `bob@example.com`. Use
`example.com`: the email validator rejects reserved test domains such as `.test`.
`SX_PUBLISH_HOURLY_MAX` and `SX_PUBLISH_DAILY_MAX` are raised so the probe can be
re-run. Every other limit keeps its production value.

## Probe: `scripts/verify_staging.cjs`

Free: it never calls fal.ai. It exits 1 when any check fails.

| Mode | Checks |
|---|---|
| (default) | healthz/readyz; `/media` and `/api/reels/diag` 404; anonymous upload 401; uninvited sign-up refused; invited sign-in with a `Secure` cookie; publish to the bucket with `media_url` on the media origin; `Range` 206 + `Content-Range`; exactly one ACAO equal to the app origin, with and without `Origin`; `Cache-Control: max-age=86400`; owner delete hides the post (404) and keeps the object (200) |
| `--drill seed` | alice DMs bob a unique marker and publishes a post; prints the `--drill check` command |
| `--drill check --marker <m> --media-url <url>` | readyz 200; bob signs in with the restored password; the DM decrypts; the post media is still served |
| `--time-publish <file.mp4>` | upload + publish of a large video, timed against a 60 s budget (Cloudflare cuts origin requests at 100 s); then waits for the background poster, Explore preview and web proxy to land on the media origin and prints when each did |

Point it at another stack with `--app https://<domain> --media https://media.<domain>`.
TLS checks are disabled only for `localhost` and `127.0.0.1`.

## Other checks

```bash
# Password-reset email lands in Mailpit:
curl -s http://127.0.0.1:8025/api/v1/messages | head -c 400
# readyz 503 while healthz stays 200:
docker compose --env-file .env.staging stop postgres
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/api/readyz
docker compose --env-file .env.staging start postgres
# ffmpeg runs at nice 10 during an encode:
docker top echo-staging-app-1 -o pid,ni,comm | grep ffmpeg
# Backup bucket is private (expect 403):
docker compose --env-file .env.staging exec objectstore wget -qO- http://127.0.0.1:8333/echo-backups/
# Restart during a publish encode: publish a video, restart while ffmpeg runs,
# then expect "Re-queued derived assets for N posts at boot" (N >= 1) and the
# -poster.jpg / -explore.mp4 / -preview.mp4 siblings to land afterwards:
docker compose --env-file .env.staging restart app
docker compose --env-file .env.staging logs app | grep -E 'Drained|Re-queued'
docker compose --env-file .env.staging exec app ls output/uploads
# Every response carries X-Request-ID; access lines are JSON with request_id:
curl -sk -D - -o /dev/null https://localhost:8443/api/readyz | grep -i x-request-id
docker compose --env-file .env.staging logs app | grep sx.access | tail -n 3
```

## Backup and restore drill

This follows `docs/backup-restore-runbook.md` with the staging object store as the
backup bucket. Run it from the repo root.

1. Seed data that must survive:
   ```bash
   node scripts/verify_staging.cjs --drill seed
   ```
2. Give `deploy/backup.sh` an `rclone` on `PATH` that runs the compose `rclone`
   service, and a backup env file:
   ```bash
   mkdir -p ~/.cache/echo-staging/bin
   cat > ~/.cache/echo-staging/bin/rclone <<EOF
   #!/usr/bin/env bash
   exec docker compose --env-file "$PWD/.env.staging" run --rm -T rclone "\$@"
   EOF
   chmod +x ~/.cache/echo-staging/bin/rclone
   cat > ~/.cache/echo-staging/backup.env <<EOF
   set -a; . "$PWD/.env.staging"; set +a
   BACKUP_REMOTE=staging:echo-backups
   EOF
   export PATH="$HOME/.cache/echo-staging/bin:$PATH"
   BACKUP_ENV_FILE=~/.cache/echo-staging/backup.env deploy/backup.sh
   rclone ls staging:echo-backups
   ```
3. Destroy the database and app volumes. Keep `echo-staging_objectstore`: it
   holds both the backups and the public media.
   ```bash
   docker compose --env-file .env.staging rm -sf app postgres
   docker volume rm echo-staging_pgdata echo-staging_data echo-staging_output
   docker compose --env-file .env.staging up -d postgres
   ```
4. Restore. These are runbook steps 1 to 3, with `staging:` remotes:
   ```bash
   C() { docker compose --env-file .env.staging "$@"; }
   day=$(date -u +%Y-%m-%d)
   rclone cat "staging:echo-backups/$day/<echo-...dump>" > logs/restore.dump
   C exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < logs/restore.dump
   C up -d app && C exec app alembic current          # expect 20261031_0018 (head)
   rclone cat "staging:echo-backups/$day/<avatars-...tar.gz>" | C exec -T app tar -C /app/data -xzf -
   mkdir -p logs/restore-media
   C run --rm -T -v "$PWD/logs/restore-media:/out" rclone copy staging:echo-public/uploads /out/uploads
   C cp logs/restore-media/uploads app:/app/output/
   C exec -u 0 app chown -R app:app /app/output/uploads
   ```
5. Verify with the command printed by step 1:
   ```bash
   node scripts/verify_staging.cjs --drill check --marker <m> --media-url <url>
   ```

The restore files go in `logs/`, which is gitignored.

## Troubleshooting

- **`No writable volumes and no free volumes left` in the objectstore logs**:
  SeaweedFS has run out of volume slots. The compose file passes `-volume.max=0`
  (size the slots from free disk) with 256 MB volumes. An object store created
  before that change needs `docker compose --env-file .env.staging up -d objectstore`.
- **Two `Access-Control-Allow-Origin` values**: an edge that *adds* ACAO on top of
  the store's own CORS headers sends the header twice, and browsers reject the
  response. Caddy uses `header_down` to replace it. The production Transform Rule
  must use "Set static" for the same reason (`docs/deploy-runbook.md`).
- **`TUNNEL_TOKEN` required**: compose checks `:?` variables even for inactive
  profiles. `.env.staging` sets a placeholder; leave it.

## Tear down

```bash
docker compose --env-file .env.staging down          # keeps volumes
docker compose --env-file .env.staging down -v       # also deletes all staging data
```
