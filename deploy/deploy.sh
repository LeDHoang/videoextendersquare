#!/usr/bin/env bash
# Deploys one commit on the VPS. The CI deploy job streams this file over SSH:
#
#   ssh deploy@vps 'bash -s -- <sha>' < deploy/deploy.sh
#
# It runs the routine deploy from docs/deploy-runbook.md section 3: fast-forward
# the checkout to the tested commit, take a pre-deploy dump when migrations
# changed, build, tag the image for rollback, restart, and wait for /api/readyz.
# Rollback and the dump: docs/incident-response.md
#
#   ECHO_DIR   checkout holding compose.yaml (default: /opt/echo)
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit sha>}"
cd "${ECHO_DIR:-/opt/echo}"

# A checkout on another branch, or one with diverged history, must stop the
# deploy rather than ship something CI never tested.
[[ "$(git symbolic-ref -q HEAD || true)" == "refs/heads/main" ]] \
    || { echo "checkout is not on main; not deploying" >&2; exit 1; }
old="$(git rev-parse HEAD)"
git fetch --quiet origin main
git merge --ff-only "$SHA"

if ! git diff --quiet "$old" HEAD -- migrations/; then
    dump="$HOME/pre-deploy-$(date -u +%Y%m%dT%H%M).dump"
    echo "migrations changed: dumping the database to $dump"
    docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump"
fi

short="$(git rev-parse --short=12 HEAD)"
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker tag echo-app:latest "echo-app:$short"   # kept for rollback
docker compose --profile tunnel up -d

# The app listens on 127.0.0.1:8000 only (compose.yaml).
for _ in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null http://127.0.0.1:8000/api/readyz; then
        echo "deployed $short"
        exit 0
    fi
    sleep 4
done
echo "app not ready after 120s; last logs:" >&2
docker compose logs --tail 50 app >&2
exit 1
