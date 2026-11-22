"""Give the published videos that have no audio track a silent one.

In an immersive WebXR session the Quest browser keeps the clock of a
video-only file running past its buffered data: no "waiting" event, no
loading overlay, and frames trickle in as they download. With an audio track
the same file stalls and resumes like any other video. New uploads get the
track at publish (server/media.py add_silent_audio) and new renditions of a
video-only original get it in their encode; this fixes the files published
before that.

Each post's original and its played renditions (-preview, -2k, -mono) are
probed straight from their public URLs, so the dry run downloads nothing. A
file without audio is fetched, remuxed (stream copy, no frame re-encoded),
uploaded to the same R2 key and recorded on the post again.

The CDN and browsers can keep the old copy for up to a day
(Cache-Control max-age=86400). The run prints the URLs to purge in
Cloudflare (by URL, see docs/deploy-runbook.md) so viewers get the new
copies at once.

On the VPS it runs inside the app container (database, R2 keys, ffmpeg).
scripts/ is not in the image, so copy it in first, from the repo checkout:

    docker compose cp scripts/batch_silent_audio.py app:/tmp/batch_silent_audio.py
    docker compose exec -w /app -e PYTHONPATH=/app app python /tmp/batch_silent_audio.py --dry-run  # list only
    docker compose exec -w /app -e PYTHONPATH=/app app python /tmp/batch_silent_audio.py            # remux

Locally: .venv/bin/python scripts/batch_silent_audio.py [--dry-run], from the repo root.

Local ffmpeg, no paid APIs. Safe to repeat: a file that has audio is
skipped. Soft-deleted posts are skipped. Avoid running it while a video is
being published.
"""
import argparse
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # repo root

from server import media as SM  # noqa: E402
from server import media_store  # noqa: E402
from server.routers import uploads  # noqa: E402
from server.social import database  # noqa: E402
from server.social.models import Post  # noqa: E402

REMUXABLE = {".mp4", ".m4v", ".mov"}


def played_files(dest: Path, files: dict | None) -> list[Path]:
    """The original and the renditions a player can play, as recorded (or on disk)."""
    candidates = [
        dest,
        dest.with_name(dest.stem + "-preview.mp4"),
        SM.vr2k_path(str(dest)),
        SM.mono_sibling_path(str(dest)),
    ]
    return [path for path in candidates if path.suffix.lower() in REMUXABLE and SM.has_media_file(path, files)]


def audio_of(path: Path) -> str:
    """"audio", "none" or "unreadable", probed from R2's public URL when R2 is on."""
    rel = media_store.rel_path(path)
    src = media_store.public_url(rel) if media_store.enabled() and rel else str(path)
    if not SM.probe_media_info(src):
        return "unreadable"
    return "audio" if SM.has_audio(src) else "none"


def plan(rows) -> tuple[dict[str, list[Path]], int, list[tuple[str, str]]]:
    """Split (media_path, media_files) rows into ({post: files to remux}, files with audio, skipped)."""
    root = uploads.OUTPUT_DIR.resolve()
    checks: list[tuple[str, Path]] = []
    skipped: list[tuple[str, str]] = []
    for rel, files in rows:
        dest = uploads.OUTPUT_DIR / rel
        if root not in dest.resolve().parents:
            skipped.append((rel, "outside output/"))
            continue
        found = played_files(dest, files)
        if not found:
            skipped.append((rel, "no recorded MP4/MOV file"))
        checks.extend((rel, path) for path in found)
    with ThreadPoolExecutor(max_workers=8) as pool:
        states = list(pool.map(lambda check: audio_of(check[1]), checks))
    todo: dict[str, list[Path]] = {}
    with_audio = 0
    for (rel, path), state in zip(checks, states):
        if state == "audio":
            with_audio += 1
        elif state == "none":
            todo.setdefault(rel, []).append(path)
        else:
            skipped.append((media_store.rel_path(path) or str(path), "could not be probed"))
    return todo, with_audio, skipped


def remux(rel: str, paths: list[Path]) -> list[Path]:
    """Add the silent track to *paths* of one post, through the publish job; returns the files changed."""
    dest = uploads.OUTPUT_DIR / rel
    changed: list[Path] = []

    def job():
        for path in paths:
            if not path.is_file() and not media_store.fetch_local(path):
                continue
            part = path.with_name(f".{path.name}.part")
            try:
                shutil.copy2(path, part)
                if SM.add_silent_audio(part, path.suffix.lstrip(".")):
                    media_store.commit(part, path)
                    changed.append(path)
            finally:
                part.unlink(missing_ok=True)
        if changed:
            uploads._record_files(dest)

    uploads._run_derived_job(dest, rel, job)
    return changed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list the files without changing anything")
    args = parser.parse_args(argv)

    with database.SessionLocal() as db:
        rows = (
            db.query(Post.media_path, Post.media_files)
            .filter(Post.media_type == "video", Post.status == "published", Post.deleted_at.is_(None))
            .order_by(Post.created_at.desc())
            .all()
        )
    todo, with_audio, skipped = plan(rows)
    for rel, reason in skipped:
        print(f"{rel} — skipped: {reason}")
    for rel, paths in todo.items():
        print(f"{rel} — no audio: {', '.join(path.name for path in paths)}")
    count = sum(len(paths) for paths in todo.values())
    print(f"{len(rows)} published video(s): {with_audio} file(s) with audio, "
          f"{count} file(s) in {len(todo)} post(s) to remux, {len(skipped)} skipped.")
    if args.dry_run or not todo:
        return 0

    changed: list[Path] = []
    failed = 0
    for number, (rel, paths) in enumerate(todo.items(), 1):
        print(f"({number}/{len(todo)}) {rel} ...", flush=True)
        done = remux(rel, paths)
        changed.extend(done)
        failed += len(paths) - len(done)
        print(f"    {len(done)} of {len(paths)} remuxed", flush=True)
    print(f"Remuxed {len(changed)}, failed {failed}.")
    if changed and media_store.enabled():
        print("Purge these URLs in Cloudflare:")
        for path in changed:
            print(media_store.public_url(media_store.rel_path(path)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
