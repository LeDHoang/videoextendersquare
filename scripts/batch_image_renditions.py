"""Build the WebP renditions (Explore tile, 2D, VR) of older image posts.

New image uploads get these at publish time (media.IMAGE_RENDITIONS). Older
posts serve the full original everywhere. This builds, per image (cover +
slides), the missing ones of:

* <stem>-tile.webp — 720 px, the Explore tile (preview_url / poster_url)
* <stem>-2d.webp   — 1080p box, the 2D player (display_url)
* <stem>-vr.webp   — 2048 px, the VR bitmap (vr_url); only for originals
  larger than the 2D box, as nothing is upscaled (and only when the post
  records its size)

An animated still (WebP, APNG) gets the tile only, and a rendition not
smaller than its original is not kept: the original serves instead. The
dry run keeps listing those as missing, and a real run reports them as
"kept the original".

A stereo still gets tile and 2D from its left eye (<stem>-mono), and no VR
file: VR shows the stereo still. A stereo still without its left eye yet is
skipped (run batch_stereo_mono.py first).

Run from the repo root (media is read from ./output), after `make migrate`:

    .venv/bin/python scripts/batch_image_renditions.py --dry-run   # list only
    .venv/bin/python scripts/batch_image_renditions.py --limit 20  # build 20 posts

--dry-run reads the post records (posts.media_files) only: no download, no
write. A real run downloads an original that is only in R2, builds the
missing renditions (uploaded to R2 like any derived file), records them on
the post, then drops the downloaded copies again. Safe to repeat: fresh
renditions are kept. Soft-deleted posts (status != "published") are skipped.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media as SM  # noqa: E402
from server import media_store  # noqa: E402
from server.social.database import SessionLocal  # noqa: E402
from server.social.models import Post  # noqa: E402
from server.social.services import rerecord_media_files  # noqa: E402


def wanted_renditions(width: int | None, height: int | None, stereo: bool) -> list[str]:
    """Renditions an image of this size should have; "vr" only when larger than "2d"."""
    names = ["tile", "2d"]
    if not stereo and width and height:
        size = (width, height)
        if max(SM.image_rendition_size(size, "vr")) > max(SM.image_rendition_size(size, "2d")):
            names.append("vr")
    return names


def missing_renditions(source: Path, names: list[str], files: dict | None) -> list[str]:
    """Names in *names* the post's record (or, unrecorded, the disk) lacks for *source*."""
    return [name for name in names if not SM.has_media_file(SM.image_rendition_path(str(source), name), files)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list what is missing; download and write nothing")
    parser.add_argument("--limit", type=int, default=0, help="build at most this many posts (0 = all)")
    args = parser.parse_args()

    with SessionLocal() as db:
        posts = (
            db.query(Post)
            .filter(Post.media_type == "image", Post.status == "published")
            .order_by(Post.created_at.desc())
            .all()
        )
        jobs = []  # (cover media_path, source, stereo, names missing)
        skipped = 0
        for post in posts:
            stereo = post.stereo_layout in ("sbs", "tb")
            images = [(post.media_path, post.width, post.height)]
            images += [(slide.media_path, slide.width, slide.height) for slide in post.slides]
            for media_path, width, height in images:
                path = Path("output") / media_path
                source = SM.mono_sibling_path(str(path)) if stereo else path
                if stereo and not SM.has_media_file(source, post.media_files):
                    print(f"[skip] {path} — no left-eye still yet (batch_stereo_mono.py)")
                    skipped += 1
                    continue
                missing = missing_renditions(source, wanted_renditions(width, height, stereo), post.media_files)
                print(f"[{'stereo' if stereo else 'mono'}] {source} — {'missing ' + ', '.join(missing) if missing else 'complete'}")
                if missing:
                    jobs.append((post.media_path, source, stereo, missing))

    covers = sorted({cover for cover, *_rest in jobs})
    if args.limit:
        covers = covers[: args.limit]
    todo = [job for job in jobs if job[0] in set(covers)]
    print(f"{len(posts)} image post(s); {len(jobs)} image(s) missing renditions in {len({j[0] for j in jobs})} post(s); "
          f"{skipped} skipped.")
    if args.dry_run:
        print(f"Dry run: would build {len(todo)} image(s) in {len(covers)} post(s).")
        return

    built = failed = 0
    fetched: list[Path] = []
    made: list[Path] = []
    for cover, source, stereo, missing in todo:
        started = time.time()
        was_local = source.is_file()
        if not media_store.fetch_local(source):
            failed += 1
            print(f"    FAILED {source} — not on disk and not in R2")
            continue
        if not was_local:
            fetched.append(source)
        result = SM.make_image_renditions(str(source), vr=not stereo)
        kept = [name for name in missing if name not in result]
        if not was_local:
            made.extend(Path(path) for path in result.values())
        built += 1
        print(f"    built {source} ({', '.join(sorted(result)) or 'none'}) in {time.time() - started:.1f}s"
              + (f"; kept the original for {', '.join(kept)}" if kept else ""))
    if covers:
        with SessionLocal() as db:
            rerecord_media_files(db, covers)
            db.commit()
    # Leave the disk as it was: copies downloaded here, and renditions of
    # them, live on in R2 (drop_local keeps any file R2 does not hold).
    media_store.drop_local([*fetched, *made])
    print(f"built {built}, failed {failed}.")


if __name__ == "__main__":
    main()
