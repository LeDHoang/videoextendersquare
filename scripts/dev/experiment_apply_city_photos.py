"""Replace the black 32x32 placeholder image posts in output/ with city photos.

Placeholders = tiny PNG/JPG/WEBP (< 2 KB) whose seeded Explore location is a
LOCATION_POOL city. Each gets a hardlink to one of that city's photos from
reports/city_photos/ (see experiment_fetch_city_photos.py), converted to PNG so
the original .png paths (and thus seeded metadata) stay valid.
With --relink-posts, files already linked to a city photo are re-linked per
post instead, so the images of one slideshow post show different photos.
Local only, no network, no cost. Run from repo root:
  .venv/bin/python scripts/dev/experiment_apply_city_photos.py [--dry-run] [--relink-posts]
"""
import hashlib
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root
from server import media as SM  # noqa: E402
from server.routers import reels as R  # noqa: E402
from server.social.database import SessionLocal  # noqa: E402
from server.social.models import Post  # noqa: E402

PHOTOS = Path("reports/city_photos")
PNG_DIR = PHOTOS / "png"
PLACEHOLDER_MAX_BYTES = 2000
MAX_SIDE = 1080
# Off-topic / illustration / badly cropped Commons hits, hand-reviewed.
REJECT = {"berlin-2", "lagos-0", "los-angeles-1", "miami-2", "mexico-city-1", "austin-0", "nairobi-0"}


def slug(city: str) -> str:
    return re.sub(r"\W+", "-", city.lower())


def city_pngs() -> dict[str, list[Path]]:
    PNG_DIR.mkdir(parents=True, exist_ok=True)
    result: dict[str, list[Path]] = {}
    for loc in R.LOCATION_POOL:
        city = loc["city"]
        files = [f for f in sorted(PHOTOS.glob(f"{slug(city)}-?.jpg")) if f.stem not in REJECT]
        for limit in (3.0, 4.0):
            picks = [f for f in files if Image.open(f).width / Image.open(f).height <= limit]
            if len(picks) >= 2 or limit == 4.0:
                break
        out = []
        for f in picks:
            dest = PNG_DIR / f"{f.stem}.png"
            if not dest.exists():
                im = Image.open(f).convert("RGB")
                im.thumbnail((MAX_SIDE, MAX_SIDE))
                im.save(dest, optimize=True)
            out.append(dest)
        result[city] = out
    return result


def _relink(target: Path, pick: Path) -> None:
    tmp = target.with_name(target.name + ".tmp")
    os.link(pick, tmp)
    os.replace(tmp, target)


def relink_posts(dry: bool) -> None:
    """Give each image post's images distinct photos of its city, in order."""
    pngs = city_pngs()
    inodes = {path.stat().st_ino for paths in pngs.values() for path in paths}
    changed = 0
    with SessionLocal() as db:
        for post in db.query(Post).filter(Post.media_type == "image").all():
            photos = pngs.get((post.location or {}).get("city"))
            if not photos:
                continue
            start = int(hashlib.md5(post.media_path.encode()).hexdigest()[:8], 16)
            paths = [post.media_path, *(slide.media_path for slide in post.slides)]
            for position, rel in enumerate(paths):
                target = Path("output") / rel
                if not target.is_file() or target.stat().st_ino not in inodes:
                    continue  # a real upload, not one of our placeholders
                pick = photos[(start + position) % len(photos)]
                if target.stat().st_ino == pick.stat().st_ino:
                    continue
                changed += 1
                if not dry:
                    _relink(target, pick)
    print(changed, "files would be re-linked" if dry else "files re-linked")


def main(dry: bool) -> None:
    pngs = city_pngs()
    raw = SM.scan_output_media("output")
    snap = R._metadata_snapshot(raw)
    counts: dict[str, int] = defaultdict(int)
    for item in raw:
        if not R._is_image_item(item) or item["size_bytes"] >= PLACEHOLDER_MAX_BYTES:
            continue
        city = ((snap[item["rel_path"]].get("location") or {}).get("city"))
        photos = pngs.get(city)
        if not photos:
            continue
        pick = photos[int(hashlib.md5(item["rel_path"].encode()).hexdigest()[:8], 16) % len(photos)]
        counts[city] += 1
        if dry:
            continue
        _relink(Path("output") / item["rel_path"], pick)
    print(dict(counts), sum(counts.values()), "replaced" if not dry else "would replace")


if __name__ == "__main__":
    if "--relink-posts" in sys.argv:
        relink_posts("--dry-run" in sys.argv)
    else:
        main("--dry-run" in sys.argv)
