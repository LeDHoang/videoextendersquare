"""Fill duration/size for reels that were created before the probe existed.

The server does this on its own at startup and every 15 minutes; run this to do
it right now, for every post at once, e.g. after restoring the media folder:

    .venv/bin/python scripts/batch_backfill_media_info.py

Run from the repo root (media is read from ./output). Safe to repeat.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server.social.services import backfill_media_info  # noqa: E402


def main() -> None:
    count = backfill_media_info(limit=None)
    print(f"Updated {count} post(s).")


if __name__ == "__main__":
    main()
