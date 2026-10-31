# Storage design

Last updated: 2026-10-31

What the production deployment stores, where, and how the pieces connect. Three rules hold it together:

1. **PostgreSQL is the source of truth.** A post's row says what it is, who may see it, and which media files it has (`posts.media_files`).
2. **R2 is the only durable media store.** Every published file lives in the public R2 bucket and is served from `media.<domain>`.
3. **The VPS disk is a work area.** Media lands there to be encoded or probed, and leaves once R2 holds it. The one exception is moderation evidence (see [Unpublish and restore](#unpublish-and-restore)).

R2 is an object store, not a database. Postgres holds the records; R2 holds the bytes they point at.

## Where everything lives

| What | Where | Durable? | Backed up |
|---|---|---|---|
| Users, posts, slides, likes, comments, DMs, reports, credits, staff audit | Postgres, `pgdata` volume | Yes | Nightly `pg_dump -Fc` to the private R2 bucket (`deploy/backup.sh`) |
| Media record of each post (`posts.media_files`) | Postgres, same row as the post | Yes | With the dump |
| Published media: originals, previews, posters, left-eye renditions | Public R2 bucket, `uploads/<name>` | Yes | No copy; R2 itself is the store, and a delete is a takedown |
| Avatars | `data` volume, `/app/data/avatars`, served by the app at `/avatars` | Yes | Nightly tarball to the private R2 bucket |
| Files of unpublished posts (moderation evidence) | `output` volume, `/app/output/uploads` | Only on this host | No (see `docs/backup-restore-runbook.md` §3) |
| Media being built: a fresh publish, a lazy rebuild, a fetched original | `output` volume, `/app/output/uploads` | No: dropped when the job ends | No |
| Staged uploads (picked but not yet published) | Container `/tmp/square_extender_api/uploads` | No: 6 h TTL, lost on restart | No |
| API job results (outpaint and other generators) | Container `/tmp/square_extender_api/<job_id>` | No | No |
| Map-tile cache | `data` volume, `/app/data/map_tiles` | Rebuildable | No |
| Legacy reel metadata and comments | `output/reels_meta.json`, `output/reels_comments.json` | Legacy | No |
| Secrets (`SX_SECURITY_SECRET`, `SX_MESSAGE_ENCRYPTION_KEY`, `SX_FAL_KEY_ENCRYPTION_KEY`) | `.env` on the VPS | Yes | Password-manager escrow (`docs/deploy-runbook.md`) |

Outside the VPS:

- **Cloudflare Tunnel** (`cloudflared` container) carries every request to the app; nothing on the VPS listens publicly.
- **Cloudflare edge cache** serves `media.<domain>` with `Cache-Control: public, max-age=86400`, so a deleted object can be served for up to a day unless its URL is purged.
- **fal** runs the outpaint and stereo models; job results land in a job dir under container `/tmp`.
- **Sentry** receives errors, traces, and the `echo-backup` cron check-ins.
- **SMTP** sends account and support mail.

The compose stack is `app` (uvicorn, one worker), `postgres:16` and `cloudflared`, with the volumes `data`, `output` and `pgdata`. Container `/tmp` is not a volume.

## The two R2 buckets

| Bucket | Holds | Written by | Read by |
|---|---|---|---|
| Public (`R2_PUBLIC_BUCKET`) | Published media, keyed by the path under `output/` (`uploads/<name>`) | The app (`server/media_store.py`) | Browsers, through `SX_MEDIA_BASE_URL`; the app, when it fetches an original back |
| Private backup | `<date>/` folders with the DB dump and the avatars tarball | `deploy/backup.sh` on the host, with its own backup-only token | Restores only |

The app's R2 token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) reaches the public bucket only. The backup bucket holds no media: published media is not copied anywhere.

R2 is on when `SX_MEDIA_BASE_URL` and `R2_PUBLIC_BUCKET` are both set; production requires them (`server/settings.py`). Without them (local development) URLs fall back to the `/media` static mount over `output/`, nothing is uploaded, and nothing is dropped, because the disk then holds the only copy.

## The media record

`posts.media_files` (migration `20261031_0018`) lists every file the post has, cover and slides and every generated sibling, keyed by its path under `output/`:

```json
{
  "uploads/abc.mp4":         {"bytes": 48211234, "codec": "hevc", "width": 3840, "height": 1920},
  "uploads/abc-preview.mp4": {"bytes": 9123412,  "codec": "h264", "width": 1920, "height": 960},
  "uploads/abc-explore.mp4": {"bytes": 812345},
  "uploads/abc-poster.jpg":  {"bytes": 64123}
}
```

The siblings an original can own are listed by `derived_files` in `server/media.py`:

| Sibling | Built for |
|---|---|
| `<stem>-preview.mp4` | H.264 web proxy of a video original the browser cannot play |
| `<stem>-explore.mp4` | Explore grid preview |
| `<stem>-poster.jpg` | Poster frame |
| `<stem>-mono.<ext>` | Left-eye 2D rendition of a stereo original (videos are always `.mp4`) |
| `<stem>-mono-explore.mp4`, `<stem>-mono-poster.jpg` | Grid assets of the left-eye rendition |

`local_media_files` builds the entries from disk: missing, empty and stale siblings (older than the original) are left out, and the video original and its `-preview.mp4` also carry the probed codec and size. `record_media_files` merges new entries into the record, so a file whose local copy was dropped stays recorded. A new or replaced original resets the record.

Readers use the record instead of the disk:

- The feed (`post_media_items`) lists a post only when its cover is recorded. Its size comes from the record and its mtime is the post's `created_at`.
- Cards and playback fields (`post_card`, `stereo_fields`, `has_media_file`) choose URLs from the recorded siblings.
- The boot requeue looks for siblings missing from the record.

A NULL record means "not recorded yet" (posts older than the migration that were never re-recorded). Those readers fall back to the disk, as before. Once a record exists it is the truth, even when the disk is empty.

## Flows

### Publish

```
staged upload (/tmp)          output/uploads/            R2 public bucket       posts row
  pick ──────────────► .part ── commit: upload, rename ──► uploads/<name>
                                  record ─────────────────────────────────────► media_files
                         derived job: build siblings ─────► uploads/<stem>-*     rerecord
                         drop_local ◄── HEAD size matches
```

1. The browser stages the file under `/tmp/square_extender_api/uploads`. A staged file not published within 6 h is swept.
2. Publishing copies it into `output/uploads` as a hidden `.part` file. `media_store.commit` uploads the object first, then renames the `.part` into place. So a file exists under its real name only once R2 has it.
3. The post row is written with `record_media_files(post, reset=True)`, which records the original.
4. **Images** have no background work. `drop_local` removes their copies as soon as the response is built.
5. **Videos** queue a derived job (`_run_derived_job` in `server/routers/uploads.py`):
   - `_fetch_inputs` brings the original back from R2 if it was dropped, plus the siblings the record lists, so the job reuses them instead of encoding them again. A fresh publish already has everything on disk and fetches nothing.
   - The build steps write each sibling through `commit` and record it (`_record_files`, then `rerecord_media_files`).
   - When the job ends, whatever happened, `drop_local` removes every copy whose R2 object exists with the same size. A post deleted while it was encoding gets the siblings it uploaded afterwards removed from R2.

A publish that fails before its row commits removes its objects with `delete_paths(..., evidence=False)`: there is no post, so there is nothing to keep.

### Lazy rebuilds at request time

`/explore-preview` and `/proxy` (`server/routers/reels.py`) build missing grid previews, posters, and H.264 proxies when a viewer asks for them. They `fetch_local` the original from R2, build, record with `rerecord_media_files`, and then `_drop_local_copies`. That last step skips posts whose publish job is still running, because the job reads those files.

### Boot requeue

A restart loses queued and running encodes. At boot, `requeue_missing_derived` looks at live video posts whose expected siblings are missing from the record, and queues them again. Their job fetches the original from R2. Unrecorded posts are only requeued when their original is still on disk.

### Unpublish and restore

Every removal (owner delete, account deletion, staff takedown) follows the same order:

1. Collect the post's files with `post_media_files` before the commit that removes the row.
2. Commit the database change.
3. Call `media_store.delete_paths(files)`. It downloads any dropped local copy back from R2 first, then deletes the objects.

The local copies left in `output/uploads` are unserved moderation evidence. They are also what a staff restore publishes again. **The takedown wins over evidence:** an object that cannot be downloaded is logged and still deleted.

A staff restore (`server/routers/admin.py`) requires the originals on disk; without them it answers `409 MEDIA_MISSING`. It resets the record, uploads the files again with `republish_paths` before the commit, and then drops the local copies.

### Backup and restore

`deploy/backup.sh` runs nightly at 03:15 UTC on the host. It writes the DB dump and the avatars tarball to the private bucket. Media needs no backup step: a restored database points at the same R2 objects. The only media that lives on the host alone is moderation evidence; the runbook copies it across when moving hosts. See `docs/backup-restore-runbook.md`.

### Pruning older copies

Posts published before this design kept their local copies. `scripts/prune_local_media.py` frees them once:

- It records each published post first, so nothing it drops goes missing from the record.
- It then drops each copy whose R2 object exists with the same size.
- It keeps unpublished posts (evidence), posts it cannot record, and copies R2 lacks or holds at another size.

```bash
docker compose exec -T app python - --dry-run < scripts/prune_local_media.py
docker compose exec -T app python - < scripts/prune_local_media.py
```

Run it in a quiet window (see the limits below).

## How the disk stays safe

`drop_local` removes a copy only when a `HEAD` on its object returns the same size. A file that never reached R2, or that R2 holds at another size, stays.

`drop_local` and the evidence download in `delete_paths` run under one `fcntl` lock on `output/.media-store.lock`. Without it, a takedown could download a copy back while a builder drops it. The lock file is harmless: the scanners only look for media extensions.

`fetch_local` downloads through a `.part` file and renames it, so a reader never sees a half-written original.

## Known limits

- **Takedown downloads are synchronous.** Deleting an account with many large videos downloads every dropped copy before it answers. Cloudflare closes the request after 100 s; the database change has already committed by then, and the downloads and deletes carry on.
- **Concurrent lazy builds can race a drop.** Two viewers rebuilding siblings of one post at the same time can see a file dropped under them. The request answers "transcode failed" and the client retries.
- **The prune script needs a quiet window.** Which encodes are pending is held in the app's memory, and the script runs in another process, so it cannot see them. A job running at the same time can lose an input, or its record entries, and is rebuilt on the next boot.
- **`scripts/batch_stereo_mono.py` reads local files.** It cannot process a post whose original was dropped.
- **A recorded feed item's mtime is the post's `created_at`,** not the file's mtime.
- **Stale siblings are not recorded.** A sibling older than its original is left out of the record and rebuilt.
- **Explore previews of HEVC posts on H.264 clients.** `_build_payload` in `server/routers/reels.py` plays the `-preview.mp4` proxy, and derives the Explore URL from it as `<stem>-preview-explore.mp4`. That file is never built and is not one of `derived_files`. This behavior predates this design and is unchanged.

## Code map

| Concern | Code |
|---|---|
| Upload, fetch, drop, unpublish, republish | `server/media_store.py` |
| Sibling names and the record shape | `server/media.py` (`derived_files`, `local_media_files`, `has_media_file`) |
| Recording, feed and card reads | `server/social/services.py` (`record_media_files`, `rerecord_media_files`, `post_media_items`, `post_card`, `stereo_fields`) |
| Publish, derived job, boot requeue | `server/routers/uploads.py` |
| Lazy rebuilds | `server/routers/reels.py` (`/explore-preview`, `/proxy`, `_drop_local_copies`) |
| Takedown and restore | `server/routers/admin.py`, `server/social/staff.py`, `server/routers/social.py`, `server/routers/account_safety.py` |
| Record column | `server/social/models.py`, `migrations/versions/20261031_0018_post_media_files.py` |
| One-off prune | `scripts/prune_local_media.py` |
| Nightly backup | `deploy/backup.sh` |
