# Incident response — invite-only beta

One operator is on call for the beta. This page is what to do when something breaks.
Commands run on the VPS in `/opt/echo` (`docs/deploy-runbook.md`).

## Alerts

| Source | Fires on | Where it comes from |
|---|---|---|
| UptimeRobot | `/api/readyz` not 200 (app down, or DB unreachable: 503) | `docs/deploy-runbook.md` §Alerts |
| Sentry | New or spiking server errors, tagged with `GIT_SHA` and the request ID | `SENTRY_DSN` |
| fal.ai | Spend limit or spend alert on the platform `FAL_KEY` | fal.ai dashboard |
| healthchecks.io (optional) | Nightly backup failed or did not run | `BACKUP_PING_URL` |
| Support inbox | A user writes in (`SX_SUPPORT_EMAIL`) | `docs/moderation-runbook.md` |

## Severity

| Level | Meaning | Examples | Response |
|---|---|---|---|
| SEV1 | Site down, data loss or exposure, or an illegal-content emergency | readyz 503 for more than 5 min; leaked secret; wrong user sees private data; CSAM report | Start now. Tell invitees within 1 hour. |
| SEV2 | A core feature is broken for everyone | Publishing fails; DMs fail; media does not load; fal spend runaway | Start within 4 hours. Tell invitees if it lasts over 4 hours. |
| SEV3 | Degraded or limited to a few users | One job type failing; slow Explore; map tiles offline | Next working day. |

## First 15 minutes

1. **Look.** Is it down for everyone?
   ```bash
   curl -fsS https://<domain>/api/readyz; curl -fsS http://127.0.0.1:8000/api/readyz
   docker compose ps
   docker compose logs --tail=200 app
   ```
   If the public URL fails but loopback works, the problem is the Tunnel or
   Cloudflare (`docker compose logs cloudflared`, the Cloudflare status page).
2. **Note the start time** and what changed last: a deploy (`git log -1`), a
   config change, an env value, or a provider outage (Cloudflare, Hetzner, fal.ai).
3. **Stop the bleeding** before finding the root cause:
   - bad deploy: roll back (below);
   - fal.ai spend runaway: revoke or rotate `FAL_KEY` in the fal dashboard, set
     `FAL_KEY=` in `.env`, then `docker compose up -d app` (local engines keep working);
   - abuse from one account: suspend it from `/moderation`;
   - disk full: `df -h /`, then `docker system prune` (images and build cache only;
     never `-a --volumes`);
   - database down: `docker compose logs postgres`, then `docker compose restart postgres`.
4. **Leaked secret:** rotate it now. `SX_SECURITY_SECRET` rotation signs everyone
   out. `SX_MESSAGE_ENCRYPTION_KEY` and `SX_FAL_KEY_ENCRYPTION_KEY` **cannot** be
   rotated without losing the data they encrypt; treat a leak of either as SEV1,
   restrict VPS access and get advice before changing them. Update the escrow copy.
5. **Tell invitees** if the severity calls for it (template below).
6. **Write a short timeline** as you go, in `logs/incident-<date>.md` on your
   machine (gitignored). It becomes the post-incident note.

Search logs by request ID: a Sentry event's `request_id` tag matches the
`X-Request-ID` header and the `request_id` field in the app's JSON logs.

```bash
docker compose logs app | grep '<request-id>'
```

## Rollback

`compose.yaml` always builds `echo-app:latest`. Each deploy also tags the new
image with its commit (`docs/deploy-runbook.md` §3), so earlier builds stay
available:

```bash
docker images echo-app                       # tags are short commit SHAs
```

If the deploy you are undoing added **no** migration
(`git diff <previous-sha> HEAD --stat -- migrations/` is empty):

```bash
docker tag echo-app:<previous-sha> echo-app:latest
docker compose --profile tunnel up -d --no-build
```

If it **did** add a migration, read "Migrations" first: the old image cannot
start on the newer schema.

If the old image is gone, rebuild it: `git checkout <previous-sha>`, then
`docker compose build --build-arg GIT_SHA=<previous-sha>` and `up -d`. Return to
the branch with `git checkout -` afterwards.

A restart drops jobs in flight. Queued jobs are cancelled and refunded during the
shutdown drain (`SX_SHUTDOWN_DRAIN_S`), and missing previews and posters are
re-encoded at the next boot.

## Migrations

Migrations only go forward in normal operation. The entrypoint runs
`alembic upgrade head` on every start, and the app refuses to boot unless the
database is at the revision its code expects.

- An old image **cannot start** on a schema migrated by a newer one: its Alembic
  does not know the newer revision, so `alembic upgrade head` fails and the
  container exits.
- **Prefer fixing forward**: a new commit and deploy, with the schema left as is.
- If you must roll back across a migration, downgrade **with the new image still
  running**, then switch images:
  ```bash
  docker compose exec app alembic downgrade <previous-revision>
  docker tag echo-app:<previous-sha> echo-app:latest
  docker compose --profile tunnel up -d --no-build
  ```
  A downgrade drops the tables and columns the migration added, with their data.
- If the downgrade fails, or the data in those tables matters, restore the dump
  taken before the deploy (`docs/backup-restore-runbook.md`). A restore loses
  everything written since that dump.
- **Take a manual dump before any deploy with a migration:**
  ```bash
  docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > ~/pre-deploy-$(date -u +%Y%m%dT%H%M).dump
  ```

### Interrupted migration

PostgreSQL runs each Alembic migration in a transaction, so a migration killed
halfway is rolled back and `alembic current` still shows the previous revision.

1. `docker compose logs app` shows the failing migration and error.
2. `docker compose exec app alembic current` shows where the schema is.
3. If it is the previous revision, fix the cause (disk, lock, bad data) and restart
   the app; the entrypoint retries the upgrade. While the app keeps crash-looping,
   stop it with `docker compose stop app`.
4. If the schema is in a state no revision describes (a migration with
   non-transactional steps, or manual edits), restore the pre-deploy dump.

## Message to invitees

Send from the operator address, BCC to invitees. Keep it short and factual.

> **Subject:** ECHO is [down / having problems with X]
>
> Hi — since [time, timezone], [what users see: "the site does not load" /
> "publishing fails"]. [Your data is safe. / We are checking whether any data was
> affected and will tell you within 24 hours.]
>
> We are working on it and will write again by [time], or sooner when it is fixed.
> You do not need to do anything [/ please do X].
>
> — [name]

When it is fixed, reply on the same thread with what happened, what was affected,
and what changes to prevent it. For a data exposure, say which data and whose,
and check the notification duties that apply **(confirm with lawyer)**.

## After the incident

Within a week, write a short note in `logs/` (or the issue tracker): timeline,
cause, what helped, what to change. Turn each change into a task in
`docs/todolist.md`.
