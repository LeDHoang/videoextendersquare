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
#   ECHO_DIR       checkout holding compose.yaml (default: /opt/echo)
#   DEPLOY_BRANCH  branch the checkout must be on and fetches (default: main).
#                  SIT deploys dev; any branch but main also prunes old images.
#   DOCKER_HOST    passed through to docker; SIT points it at its rootless daemon.
#
# The readiness check polls SX_APP_PORT from $ECHO_DIR/.env (default 8000).
# SIT setup: docs/sit-runbook.md
set -euo pipefail

# bash reads a braced group to its end before running any of it. Without the
# braces, a command that reads stdin takes the rest of this script as its input
# when the script is streamed, and bash stops there with exit status 0.
{
SHA="${1:?usage: deploy.sh <commit sha>}"
cd "${ECHO_DIR:-/opt/echo}"
branch="${DEPLOY_BRANCH:-main}"

# A checkout on another branch, or one with diverged history, must stop the
# deploy rather than ship something CI never tested.
[[ "$(git symbolic-ref -q HEAD || true)" == "refs/heads/$branch" ]] \
    || { echo "checkout is not on $branch; not deploying" >&2; exit 1; }
old="$(git rev-parse HEAD)"
git fetch --quiet origin "$branch"
git merge --ff-only "$SHA"

# Prod only: SIT's data is throwaway, and a stopped SIT stack would fail the
# dump and with it the deploy.
if [[ "$branch" == main ]] && ! git diff --quiet "$old" HEAD -- migrations/; then
    dump="$HOME/pre-deploy-$(date -u +%Y%m%dT%H%M).dump"
    echo "migrations changed: dumping the database to $dump"
    docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' < /dev/null > "$dump"
fi

short="$(git rev-parse --short=12 HEAD)"
docker compose build --build-arg GIT_SHA="$(git rev-parse HEAD)"
docker tag echo-app:latest "echo-app:$short"   # kept for rollback

# SIT shares the prod disk: keep its newest 3 rollback tags ($short included)
# and drop dangling images and old build cache. Prod keeps every tag.
if [[ "$branch" != main ]]; then
    stale="$(docker image ls echo-app --format '{{.Tag}}' \
        | { grep -vx -e latest -e "$short" || true; } | tail -n +3)"
    if [[ -n "$stale" ]]; then
        # shellcheck disable=SC2046  # tags are hex, safe to split
        docker image rm $(printf 'echo-app:%s ' $stale) \
            || echo "warning: could not remove old images: $stale" >&2
    fi
    docker image prune -f
    docker builder prune -f --filter until=72h
fi
docker compose --profile tunnel up -d

# The app listens on 127.0.0.1:${SX_APP_PORT:-8000} only (compose.yaml).
port=""
if [[ -f .env ]]; then
    port="$(sed -n 's/^SX_APP_PORT=//p' .env | tail -n 1 | tr -d "\"'[:space:]")"
fi
port="${port:-8000}"
for _ in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/api/readyz"; then
        echo "deployed $short"
        exit 0
    fi
    sleep 4
done
echo "app not ready after 120s; last logs:" >&2
docker compose logs --tail 50 app >&2
exit 1
}
