"""Caption the speech in videos published before auto captions ran here.

New publishes are captioned in the background; run this once after installing
requirements-captions.txt, to caption the older videos too:

    .venv/bin/python scripts/batch_backfill_captions.py

Run from the repo root (media is read from ./output). It runs the speech model
on each video in turn, so it can take minutes per reel. Safe to repeat: videos
that already have captions are skipped.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media as SM  # noqa: E402
from server.routers.uploads import backfill_captions  # noqa: E402


def main() -> None:
    if SM._caption_model() is None:
        sys.exit("The speech model cannot load here; install requirements-captions.txt first.")
    count = backfill_captions()
    print(f"Captioned {count} video(s).")


if __name__ == "__main__":
    main()
