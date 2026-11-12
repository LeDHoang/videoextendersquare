"""Build the 2k VR rendition (<stem>-2k.mp4) of published videos that lack one.

New videos get it at publish time, as the last derived step. Videos published
before that step existed have none, and the boot requeue does not build it
(it only checks the grid assets and the web preview), so the player falls
back to the master. This builds the one missing file per video, through the
same job a publish runs: the original is fetched from R2 when its local copy
was dropped, the rendition is committed to R2 and recorded on the post, and
the local copies are dropped again afterwards.

On the VPS it runs inside the app container (database, R2 keys, ffmpeg).
scripts/ is not in the image, so copy it in first, from the repo checkout:

    docker compose cp scripts/batch_vr2k.py app:/tmp/batch_vr2k.py
    docker compose exec -w /app -e PYTHONPATH=/app app python /tmp/batch_vr2k.py --dry-run  # list only
    docker compose exec -w /app -e PYTHONPATH=/app app python /tmp/batch_vr2k.py            # build

Locally: .venv/bin/python scripts/batch_vr2k.py [--dry-run], from the repo root.

Local ffmpeg (libx265), no paid APIs. One video at a time; a 4K master can
take several minutes and the encode gives up after 15. Safe to repeat: a
video whose rendition is recorded is skipped, so a second run picks up only
the ones that failed. Soft-deleted posts are skipped. Avoid running it while
a video is being published: both would build that video's rendition.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media as SM  # noqa: E402
from server.routers import uploads  # noqa: E402
from server.social import database  # noqa: E402
from server.social.models import Post  # noqa: E402


def stereo_of(layout: str | None) -> str | None:
    return layout if layout in ("sbs", "tb") else None


def plan(rows) -> tuple[list[tuple[str, str | None]], list[str], list[tuple[str, str]]]:
    """Split (media_path, stereo_layout, media_files) rows into (to build, complete, skipped).

    A post's media record answers presence when it has one: a recorded
    original may live only in R2, and the job fetches it. An unrecorded post
    is judged from this disk.
    """
    root = uploads.OUTPUT_DIR.resolve()
    todo, complete, skipped = [], [], []
    for rel, layout, files in rows:
        dest = uploads.OUTPUT_DIR / rel
        try:
            if root not in dest.resolve().parents:
                skipped.append((rel, "outside output/"))
                continue
            if files is None and not dest.is_file():
                skipped.append((rel, "not recorded and not on this disk"))
                continue
        except OSError as ex:
            skipped.append((rel, f"unreadable path: {ex}"))
            continue
        if SM.has_media_file(SM.vr2k_path(str(dest)), files):
            complete.append(rel)
        else:
            todo.append((rel, stereo_of(layout)))
    return todo, complete, skipped


def build(rel: str, stereo: str | None) -> bool:
    """Run the publish job's VR step for one video; True when the rendition was built and recorded."""
    dest = uploads.OUTPUT_DIR / rel
    built = []
    uploads._run_derived_job(dest, rel, lambda: built.append(
        uploads._derived_step("VR rendition", dest, SM.make_vr2k_rendition, str(dest), stereo=stereo)))
    return bool(built and built[0])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the videos without building anything")
    args = parser.parse_args(argv)

    with database.SessionLocal() as db:
        rows = (
            db.query(Post.media_path, Post.stereo_layout, Post.media_files)
            .filter(Post.media_type == "video", Post.status == "published", Post.deleted_at.is_(None))
            .order_by(Post.created_at.desc())
            .all()
        )
    todo, complete, skipped = plan(rows)
    for rel in complete:
        print(f"{rel} — has a 2k rendition")
    for rel, reason in skipped:
        print(f"{rel} — skipped: {reason}")
    for rel, stereo in todo:
        print(f"[{stereo or 'mono'}] {rel} — missing the 2k rendition")
    print(f"{len(rows)} published video(s): {len(complete)} complete, {len(todo)} to build, {len(skipped)} skipped.")
    if args.dry_run or not todo:
        return 0

    built = failed = 0
    for number, (rel, stereo) in enumerate(todo, 1):
        print(f"({number}/{len(todo)}) {rel} ...", flush=True)
        started = time.time()
        if build(rel, stereo):
            built += 1
            print(f"    built in {time.time() - started:.1f}s", flush=True)
        else:
            failed += 1
            print(f"    FAILED after {time.time() - started:.1f}s (see the app log above)", flush=True)
    print(f"Built {built}, failed {failed}.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
