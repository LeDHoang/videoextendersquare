"""Build the missing 2D assets of stereo (SBS / top-bottom) posts.

New stereo uploads get these at publish time. Older stereo rows do not: the
spatialize output that migration 20261015_0013 marked "sbs" has none. Until a
post has them, its 2D view crops the raw file (stereo_crop). This builds, per
post (cover + slides):

* <stem>-mono.<ext>  — the left eye, square (the 2D url)
* <stem>-mono-explore.mp4 / <stem>-mono-poster.jpg — grid preview + poster
* <stem>-preview.mp4 — H.264 stereo proxy when the source needs one

Run from the repo root (media is read from ./output), after `make migrate`:

    .venv/bin/python scripts/batch_stereo_mono.py            # build what is missing
    .venv/bin/python scripts/batch_stereo_mono.py --dry-run  # list only

Local ffmpeg only, no paid APIs. Safe to repeat: each asset is checked on its
own and only the missing ones are made; fresh assets are kept. A VR proxy over
STEREO_PROXY_LONG_SIDE (built before the cap) counts as missing and is
rebuilt. Soft-deleted posts (status != "published") are skipped.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media as SM  # noqa: E402
from server.social.database import SessionLocal  # noqa: E402
from server.social.models import Post  # noqa: E402


def missing_assets(path: Path, layout: str, kind: str) -> list[str]:
    """Names of the derived 2D/VR assets this stereo file still lacks."""
    mono = SM.mono_sibling_path(str(path))
    wanted = {"2D view": mono}
    if kind == "video":
        wanted["grid preview"] = SM.explore_preview_path(str(mono))
        wanted["grid poster"] = SM.explore_poster_path(str(mono))
    else:
        wanted["grid poster"] = SM.explore_poster_path(str(mono))
    missing = [name for name, asset in wanted.items() if not (asset.is_file() and asset.stat().st_size > 0)]
    if kind == "video":
        _mono, stereo = SM.stereo_paths(str(path))
        proxy = path.with_name(path.stem + "-preview.mp4")
        # stereo_paths skips a proxy over the cap; a missing proxy is fine
        # when the original already plays as is (make_web_preview decides).
        if proxy.is_file() and stereo != proxy:
            missing.append("VR proxy (over the cap)")
    return missing


def build(path: Path, layout: str, kind: str) -> bool:
    """Make every missing asset; each make_* call keeps a fresh cached file."""
    mono = SM.make_left_eye_rendition(str(path), layout)
    if not mono:
        return False
    if kind == "video":
        SM.make_web_preview(str(path), stereo=layout)
        SM.make_explore_preview(mono)
        SM.make_explore_poster(mono)
    else:
        SM.make_image_poster(mono)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the files without building anything")
    args = parser.parse_args()

    with SessionLocal() as db:
        posts = (
            db.query(Post)
            .filter(Post.stereo_layout != "mono", Post.status == "published")
            .order_by(Post.created_at.desc())
            .all()
        )
        jobs = []
        for post in posts:
            for media_path in [post.media_path, *(slide.media_path for slide in post.slides)]:
                path = Path("output") / media_path
                if path.is_file():
                    jobs.append((path, post.stereo_layout, post.media_type))

    built = failed = 0
    for path, layout, kind in jobs:
        missing = missing_assets(path, layout, kind)
        state = "complete" if not missing else "missing " + ", ".join(missing)
        print(f"[{layout}] {path} — {state}")
        if args.dry_run or not missing:
            continue
        started = time.time()
        if build(path, layout, kind) and not missing_assets(path, layout, kind):
            built += 1
            print(f"    built in {time.time() - started:.1f}s")
        else:
            failed += 1
            print(f"    FAILED — still missing: {', '.join(missing_assets(path, layout, kind)) or 'nothing'}")
    print(f"{len(jobs)} stereo file(s); built {built}, failed {failed}.")


if __name__ == "__main__":
    main()
