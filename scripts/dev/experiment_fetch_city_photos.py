"""Fetch freely licensed Wikimedia Commons photos for each LOCATION_POOL city.

Free API (no cost). Writes JPEGs + credits.json into reports/city_photos/.
Run from repo root: .venv/bin/python scripts/dev/experiment_fetch_city_photos.py
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root
from server.routers.reels import LOCATION_POOL  # noqa: E402

OUT = Path("reports/city_photos")
API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "EchoReelsDev/1.0 (leduchoang011@gmail.com) python-requests"}
PER_CITY = 3
FREE = re.compile(r"^(cc0|cc[- ]by|cc[- ]by[- ]sa|public domain|pd)", re.I)


def search(city: str, country: str) -> list[dict]:
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": f"{city} skyline filetype:bitmap", "gsrnamespace": 6, "gsrlimit": 30,
        "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1280,
    }
    r = requests.get(API, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    pages = (r.json().get("query") or {}).get("pages") or {}
    rows = []
    for page in sorted(pages.values(), key=lambda p: p.get("index", 0)):
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        lic = (meta.get("LicenseShortName") or {}).get("value", "")
        if info.get("mime") != "image/jpeg" or not FREE.match(lic):
            continue
        if info.get("width", 0) < 1200 or info.get("width", 0) < info.get("height", 0):
            continue  # landscape, large enough
        rows.append({
            "title": page["title"], "url": info["thumburl"], "license": lic,
            "artist": re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "")).strip(),
            "page": info.get("descriptionurl"),
        })
    return rows[:PER_CITY]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    credits: dict[str, list[dict]] = {}
    for loc in LOCATION_POOL:
        city = loc["city"]
        slug = re.sub(r"\W+", "-", city.lower())
        rows = search(city, loc["country"])
        credits[city] = []
        for n, row in enumerate(rows):
            dest = OUT / f"{slug}-{n}.jpg"
            if not dest.exists():
                for attempt in range(4):
                    resp = requests.get(row["url"], headers=HEADERS, timeout=60)
                    if resp.status_code == 429:
                        time.sleep(5 * (attempt + 1))
                        continue
                    resp.raise_for_status()
                    dest.write_bytes(resp.content)
                    break
                else:
                    print("skip", row["title"])
                    continue
                time.sleep(1)
            credits[city].append({**row, "file": dest.name})
        print(city, len(credits[city]))
    (OUT / "credits.json").write_text(json.dumps(credits, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
