"""Drop the local copies of published media that R2 already holds.

Readers serve a post from its record (posts.media_files, migration
20261031_0018) and builders fetch what they need back from R2, so this disk
is only a work area (docs/storage-design.md). New posts drop their copies
when their background job ends; this one-off frees the copies older posts
left behind.

Per published post (cover + slides) it first records the files on disk, so
nothing it drops goes missing from the record, then drops each copy whose R2
object exists with the same size. That covers seed media outside uploads/
too, which R2 holds under the same output-relative key. Copies that R2 lacks
or holds at another size stay. So do the files of unpublished posts (moderation evidence) and of
posts that still have no record (their readers look at this disk).

The image does not ship scripts/, so pipe it into the app container from the
repo checkout on the host. Run it in a quiet window: a derived job running
at the same time can lose an input and rebuild it on the next boot.

    docker compose exec -T app python - --dry-run < scripts/prune_local_media.py
    docker compose exec -T app python - < scripts/prune_local_media.py

Locally (with the R2 env set): .venv/bin/python scripts/prune_local_media.py [--dry-run]
"""
import argparse
import sys
from pathlib import Path

if Path(__file__).is_file():  # piped in (python -) it is "<stdin>", and the cwd (the repo root) is on sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media_store  # noqa: E402
from server.social.database import SessionLocal  # noqa: E402
from server.social.models import Post  # noqa: E402
from server.social.services import post_media_files, rerecord_media_files  # noqa: E402


def _mb(size: int) -> str:
    return f"{size / 1e6:.1f} MB"


def prune(db, dry_run: bool = False) -> dict:
    """Record, then drop, the local copies of every published post; returns the totals."""
    totals = {"posts": 0, "files": 0, "bytes": 0, "dropped": 0, "freed": 0, "unrecorded": 0}
    posts = db.query(Post).filter(Post.status == "published").order_by(Post.created_at).all()
    for post in posts:
        totals["posts"] += 1
        local = {path: path.stat().st_size for path in post_media_files([post]) if path.is_file()}
        totals["files"] += len(local)
        totals["bytes"] += sum(local.values())
        if not dry_run:
            rerecord_media_files(db, [post.media_path])
            db.commit()
        if post.media_files is None and not (dry_run and local):
            totals["unrecorded"] += 1
            print(f"{post.media_path}: no record and nothing on disk to record, skipped")
            continue
        if dry_run:
            if local:
                print(f"{post.media_path}: {len(local)} local file(s), {_mb(sum(local.values()))}")
            continue
        media_store.drop_local(local)
        gone = [path for path in local if not path.exists()]
        totals["dropped"] += len(gone)
        totals["freed"] += sum(local[path] for path in gone)
        if local:
            print(f"{post.media_path}: dropped {len(gone)} of {len(local)} local file(s), "
                  f"{_mb(sum(local[path] for path in gone))}")
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the local copies without recording or dropping")
    args = parser.parse_args()
    if not media_store.enabled():
        sys.exit("R2 is off (SX_MEDIA_BASE_URL and R2_PUBLIC_BUCKET unset): this disk holds the only copies.")

    with SessionLocal() as db:
        totals = prune(db, args.dry_run)
    summary = f"{totals['posts']} published post(s), {totals['files']} local file(s), {_mb(totals['bytes'])}"
    if not args.dry_run:
        summary += f"; dropped {totals['dropped']}, freed {_mb(totals['freed'])}"
    if totals["unrecorded"]:
        summary += f"; {totals['unrecorded']} post(s) with neither a record nor a local file"
    print(summary + ".")


if __name__ == "__main__":
    main()
