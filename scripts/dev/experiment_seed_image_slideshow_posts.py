"""Turn loose image files in output/ into DB image posts (city slideshows).

Loose images (no post row) cannot play in the Reels player or use the action
bar. This groups them by their seeded Explore city into posts of 1-4 images
(same-city only), owned by the existing demo accounts, with zero engagement.
Files already part of a post are skipped, so re-running is safe.

Local only, no network, no cost. Run from repo root after `make migrate`:
  .venv/bin/python scripts/dev/experiment_seed_image_slideshow_posts.py [--dry-run]
"""
import hashlib
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root
from server import media as SM  # noqa: E402
from server.routers import reels as R  # noqa: E402
from server.social.database import SessionLocal  # noqa: E402
from server.social.models import Post, PostSlide, User  # noqa: E402
from server.social.services import create_or_update_post  # noqa: E402

GROUP_SIZES = (1, 2, 3, 3, 4)


def _stable(value: str) -> int:
    return int(hashlib.md5(value.encode("utf-8")).hexdigest()[:8], 16)


def main(dry: bool) -> None:
    raw = [item for item in SM.scan_output_media(str(R.OUTPUT_DIR)) if R._is_image_item(item)]
    snapshot = R._metadata_snapshot(raw)
    with SessionLocal() as db:
        taken = {row[0] for row in db.query(Post.media_path).all()}
        taken |= {row[0] for row in db.query(PostSlide.media_path).all()}
        owners = db.query(User).filter(User.account_type == "demo", User.status == "active").order_by(User.username).all()
        if not owners:
            raise SystemExit("No demo accounts to own the posts; run the legacy import first.")

        by_city: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for item in raw:
            if item["rel_path"] in taken:
                continue
            location = snapshot[item["rel_path"]].get("location") or {}
            if location.get("city"):
                by_city[(location["city"], location.get("country", ""))].append(item)

        created = 0
        for (city, country), items in sorted(by_city.items()):
            items.sort(key=lambda item: item["rel_path"])
            coords = R.CITY_COORDS.get(f"{city},{country}".casefold())
            cursor = 0
            while cursor < len(items):
                cover = items[cursor]
                size = GROUP_SIZES[_stable(cover["rel_path"]) % len(GROUP_SIZES)]
                group = items[cursor:cursor + size]
                cursor += size
                meta = snapshot[cover["rel_path"]]
                owner = owners[_stable(cover["rel_path"] + ":owner") % len(owners)]
                frames = f"{len(group)} frames" if len(group) > 1 else "one frame"
                created += 1
                if dry:
                    continue
                create_or_update_post(
                    db,
                    media_path=cover["rel_path"],
                    media_type="image",
                    owner=owner,
                    title=f"{city} in {frames}"[:100],
                    caption=f"Walking {city}, {country}. #{city.casefold().replace(' ', '')}"[:2200],
                    tags=list(meta.get("tags") or [])[:4],
                    location={
                        "city": city,
                        "country": country,
                        "display_name": f"{city}, {country}",
                        "lat": coords[0] if coords else None,
                        "lon": coords[1] if coords else None,
                        "osm_id": None,
                    },
                    source="upload",
                    created_at=datetime.fromtimestamp(cover["mtime"], tz=timezone.utc),
                    slide_paths=[item["rel_path"] for item in group[1:]],
                )
        if not dry:
            db.commit()
    print(f"{'would create' if dry else 'created'} {created} image posts from {sum(len(v) for v in by_city.values())} loose images")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
