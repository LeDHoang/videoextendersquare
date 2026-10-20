# Backup and restore runbook

What a full restore needs, and where each piece lives:

| Piece | Lives in | Backed up by |
|---|---|---|
| PostgreSQL (users, posts, DMs, reports, credits) | `pgdata` volume | `deploy/backup.sh`: nightly `pg_dump -Fc` to the private R2 bucket |
| Avatars | `data` volume, `/app/data/avatars` | `deploy/backup.sh`: nightly tarball to the private R2 bucket |
| Published media | R2 public bucket (`media.<domain>`) | R2 itself (no copy; deletes are takedowns) |
| `SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY`, `SX_FAL_KEY_ENCRYPTION_KEY` | `.env` on the VPS | **Password-manager escrow** (`docs/deploy-runbook.md` §Secret escrow) |
| Map-tile cache, job temp files, staged uploads | `data/map_tiles`, container `/tmp` | Not backed up (rebuildable / ephemeral) |

> **The database alone is not a backup.** DMs, report evidence, and saved fal keys are encrypted with the three escrowed secrets. Restoring a dump with different secrets boots fine but every encrypted field is unreadable. Session cookies are signed with `SX_SECURITY_SECRET`; a new one logs everyone out.

## Nightly backup

`deploy/backup.sh` runs on the **host** (not in a container) from the repo checkout.

1. Install rclone and add a remote for the private backup bucket (S3 provider `Cloudflare`, endpoint `https://<account-id>.r2.cloudflarestorage.com`, the **backup-only** R2 token):
   ```bash
   rclone config create r2-backup s3 provider=Cloudflare \
     access_key_id=<backup-token-id> secret_access_key=<backup-token-secret> \
     endpoint=https://<account-id>.r2.cloudflarestorage.com acl=private
   ```
2. Create `/etc/echo-backup.env` (mode 600):
   ```bash
   BACKUP_REMOTE=r2-backup:<backup-bucket>
   BACKUP_PING_URL=https://hc-ping.com/<uuid>   # optional
   ```
3. Cron (`crontab -e` as the deploy user, who must be in the `docker` group):
   ```cron
   15 3 * * * cd /opt/echo && deploy/backup.sh >> "$HOME/echo-backup.log" 2>&1
   ```
4. Run it once by hand and confirm both objects exist:
   ```bash
   deploy/backup.sh && rclone ls r2-backup:<backup-bucket>/$(date -u +%Y-%m-%d)/
   ```

Each run writes `<YYYY-MM-DD>/echo-<stamp>.dump` and `<YYYY-MM-DD>/avatars-<stamp>.tar.gz`. Uploads stream to a `.partial` name and are renamed only when the whole pipe succeeded, so a file without `.partial` is complete. The bucket's 30-day lifecycle rule handles retention (and sweeps any leftover `.partial`). With `BACKUP_PING_URL` set, the script pings `/start`, success, or `/fail`; configure the check's grace period so a *missed* run also alerts.

## Restore (disaster recovery or drill)

Run the drill on a **second, throwaway VM** before inviting users, and again after any schema-heavy release. Steps 1–4 are the drill; step 5 cuts traffic over (real recovery only).

### 0. Prepare the target host

```bash
git clone <repo-url> /opt/echo && cd /opt/echo
git checkout <same commit as production>          # schema must match the dump
cp deploy/env.example .env && chmod 600 .env
# Fill .env with the ESCROWED SX_SECURITY_SECRET, SX_MESSAGE_ENCRYPTION_KEY,
# SX_FAL_KEY_ENCRYPTION_KEY (not new ones). For a drill, point R2_* at a
# staging bucket or leave the public-bucket token read-only.
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker compose up -d postgres
```

### 1. Database: `pg_restore --clean`

```bash
day=<YYYY-MM-DD>; dump=<echo-...dump>
rclone copy "r2-backup:<backup-bucket>/$day/$dump" ./restore/
docker compose exec -T postgres sh -c \
  'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "./restore/$dump"
```

`--clean --if-exists` drops existing objects first, so it is safe on a fresh database and on one the app already migrated. Then start the app; its entrypoint runs `alembic upgrade head`, which is a no-op when the dump is from the same release:

```bash
docker compose up -d app
docker compose exec app alembic current        # expect 20261020_0014 (head)
```

### 2. Avatars: untar into the data volume

```bash
rclone copy "r2-backup:<backup-bucket>/$day/<avatars-...tar.gz>" ./restore/
docker compose exec -T app tar -C /app/data -xzf - < ./restore/avatars-*.tar.gz
```

The `exec` runs as the image's non-root `app` user, so the extracted files are owned correctly.

### 3. Public media: copy the R2 bucket back into `output/uploads`

The request-time sibling probes (posters, previews, stereo variants) look for local copies under `output/uploads`, so a restored host needs them even though R2 still serves the public URLs.

```bash
# rclone remote for the PUBLIC bucket (read-only token is enough):
rclone lsf r2-public:<public-bucket> --max-depth 1          # confirm the key layout
rclone copy r2-public:<public-bucket>/uploads ./restore/uploads --transfers 16
docker compose cp ./restore/uploads app:/app/output/
docker compose exec -u 0 app chown -R app:app /app/output/uploads
```

(If the keys are not prefixed with `uploads/`, copy the bucket root into `./restore/uploads` instead.)

### 4. Verify

- [ ] `curl -fsS http://127.0.0.1:8000/api/readyz` → **200**.
- [ ] Sign in as a test account whose DM history predates the backup and open a conversation: messages **decrypt** (proves `SX_MESSAGE_ENCRYPTION_KEY` matches). A report's evidence opens in the admin queue.
- [ ] A user with a saved fal key can see it as configured (proves `SX_FAL_KEY_ENCRYPTION_KEY`).
- [ ] A reel plays from `media.<domain>` and its poster/preview load; an avatar renders.
- [ ] Record the drill date, dump timestamp, and time-to-restore in `docs/to-beta.md` (Backups & restore).

### 5. Cut over (real recovery only)

Put the restored host's `TUNNEL_TOKEN` in `.env` and run `docker compose --profile tunnel up -d`. Stop cloudflared on the old host first if it is still reachable, so the tunnel does not split traffic across two databases.
