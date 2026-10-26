#!/usr/bin/env bash
# Nightly backup, run from host cron in the repo checkout (next to compose.yaml):
#
#   15 3 * * * cd /opt/echo && deploy/backup.sh >> /var/log/echo-backup.log 2>&1
#
# Streams a custom-format pg_dump and a tarball of data/avatars straight into
# the PRIVATE R2 backup bucket via rclone (nothing is staged on local disk).
# Public media already lives in the public R2 bucket and is not copied here.
# Restore procedure: docs/backup-restore-runbook.md
#
# Configuration (env, or the file named by BACKUP_ENV_FILE):
#   BACKUP_REMOTE    rclone destination, e.g. r2-backup:echo-backups (required)
#   BACKUP_PING_URL  optional healthchecks.io-style URL; "/fail" is appended on error
#   BACKUP_SENTRY_CRON_URL  optional Sentry Crons check-in URL; the first
#                    check-in creates the monitor (daily 03:15 UTC, as above)
#   COMPOSE_DIR      directory holding compose.yaml (default: repo root)
set -euo pipefail

BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/echo-backup.env}"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$BACKUP_ENV_FILE"
fi

: "${BACKUP_REMOTE:?set BACKUP_REMOTE (rclone remote:bucket for the private backup bucket)}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_PING_URL="${BACKUP_PING_URL:-}"
BACKUP_SENTRY_CRON_URL="${BACKUP_SENTRY_CRON_URL:-}"

ping() {
    [[ -n "$BACKUP_PING_URL" ]] || return 0
    curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_PING_URL}$1" || true
}

# Sentry Crons: in_progress / ok / error. A missed run alerts from Sentry's side.
checkin() {
    [[ -n "$BACKUP_SENTRY_CRON_URL" ]] || return 0
    curl -fsS -m 10 --retry 3 -o /dev/null -X POST "$BACKUP_SENTRY_CRON_URL" \
        -H 'Content-Type: application/json' \
        --data "{\"status\": \"$1\", \"monitor_config\": {\"schedule\": {\"type\": \"crontab\", \"value\": \"15 3 * * *\"}, \"timezone\": \"UTC\", \"checkin_margin\": 30, \"max_runtime\": 120}}" || true
}
trap 'ping /fail; checkin error' ERR

cd "$COMPOSE_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
day="$(date -u +%Y-%m-%d)"

# Stream to a .partial name and rename only after BOTH ends of the pipe
# succeeded (pipefail), so a failed dump never leaves a truncated file that
# looks like a good backup.
publish() {
    local name="$1"
    rclone moveto "${BACKUP_REMOTE}/${day}/${name}.partial" "${BACKUP_REMOTE}/${day}/${name}"
    echo "backup: wrote ${BACKUP_REMOTE}/${day}/${name}"
}

ping /start
checkin in_progress

# Database: custom format so pg_restore can --clean / pick objects.
db_name="echo-${stamp}.dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
    | rclone rcat "${BACKUP_REMOTE}/${day}/${db_name}.partial"
publish "$db_name"

# Avatars are the only user files kept on the VPS volume (media is in R2).
avatars_name="avatars-${stamp}.tar.gz"
docker compose exec -T app sh -c 'mkdir -p /app/data/avatars && tar -C /app/data -czf - avatars' \
    | rclone rcat "${BACKUP_REMOTE}/${day}/${avatars_name}.partial"
publish "$avatars_name"

ping ""
checkin ok
echo "backup: done ${stamp}"
