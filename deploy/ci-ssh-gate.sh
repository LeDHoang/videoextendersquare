#!/usr/bin/env bash
# Forced command for the CI deploy key (echo-ci) on the production VPS.
# Installed as /usr/local/bin/echo-ci-deploy (root-owned, 0755) and bound to
# the key in ~debian/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/bin/echo-ci-deploy" ssh-ed25519 AAAA... echo-ci
#
# The key can then only deploy a commit that is already on origin/main, with
# that commit's own deploy/deploy.sh. It gets no shell, no pty and no port or
# agent forwarding, so a leaked VPS_SSH_KEY no longer means root on the host.
# The CI job still sends `bash -s -- <sha>` with the script on stdin; the
# stdin copy is ignored.
set -euo pipefail

cmd="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$cmd" =~ ^bash\ -s\ --\ ([0-9a-f]{40})$ ]]; then
    echo "echo-ci: refused: only 'bash -s -- <40-hex sha>' is allowed" >&2
    exit 1
fi
sha="${BASH_REMATCH[1]}"

cd /opt/echo
git fetch --quiet origin main
if ! git merge-base --is-ancestor "$sha" origin/main; then
    echo "echo-ci: refused: $sha is not on origin/main" >&2
    exit 1
fi

script="$(git show "$sha:deploy/deploy.sh")"
exec bash -c "$script" deploy.sh "$sha" < /dev/null
