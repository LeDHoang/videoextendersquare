"""Build top-bottom (TB) 3D fixtures and score them with the stereo detector.

Restacks the real side-by-side clips in output/testpipeline-3d/ as top-bottom
(left eye on top) with ffmpeg, in the formats an uploader is likely to send:

* H.264 MP4, 1920 per eye, no stereo metadata (content detection)
* HEVC MP4, 2160 per eye, no metadata (proxy + 2D rendition from HEVC)
* VP9 WebM, 1024 per eye, Matroska ``stereo_mode=top_bottom`` (metadata)
* PNG still, 2048 per eye (image post)

plus negatives that must not be detected: a duplicated eye, two unrelated
clips stacked, and a WebM that declares the inverted ``bottom_top`` layout.

Each eye carries a corner marker (red square on the left eye, blue on the
right eye) so a 2D rendition or a VR eye can be checked for the right eye.

No paid API calls. Outputs go to reports/stereo-tb/ (gitignored).

    .venv/bin/python scripts/dev/experiment_stereo_tb.py [--seconds 10] [--rebuild]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root

from pipeline import stereo_detect as SD  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SOURCES = REPO / "output" / "testpipeline-3d"
OUT = REPO / "reports" / "stereo-tb"
DERIVED = ("-explore", "-preview", "-mono", "-poster")


def _source(word: str) -> Path:
    for path in sorted(SOURCES.glob("*.mp4")):
        if word in path.stem and not any(path.stem.endswith(tag) for tag in DERIVED):
            return path
    sys.exit(f"no SBS source matching {word!r} in {SOURCES}")


def _eyes(eye: int, swap_source: str | None = None) -> str:
    """Filter graph: split an SBS input into marked eyes [l] / [r]."""
    sq = f"scale={eye}:{eye},setsar=1"
    box = f"x={eye * 4 // 100}:y={eye * 4 // 100}:w={eye * 6 // 100}:h={eye * 6 // 100}:t=fill"
    if swap_source:
        left, right = "[0:v]crop=iw/2:ih:0:0", f"[{swap_source}]crop=iw/2:ih:0:0"
    else:
        left, right = "[0:v]split=2[a][b];[a]crop=iw/2:ih:0:0", "[b]crop=iw/2:ih:iw/2:0"
    return f"{left},{sq},drawbox={box}:color=red[l];{right},{sq},drawbox={box}:color=blue[r]"


def _ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def build(seconds: float, rebuild: bool) -> list[dict]:
    weeknd, tron, projectx = _source("Weeknd"), _source("Tron"), _source("Project-X")
    clip = lambda src, start: ["-ss", str(start), "-t", str(seconds), "-i", str(src)]  # noqa: E731
    h264 = ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p"]
    audio = ["-map", "0:a?", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]
    fixtures = [
        {"name": "tb-weeknd-1920-h264.mp4", "expect": "tb",
         "args": [*clip(weeknd, 0), "-filter_complex", _eyes(1920) + ";[l][r]vstack[v]",
                  "-map", "[v]", *h264, *audio]},
        {"name": "tb-tron-2160-hevc.mp4", "expect": "tb",
         "args": [*clip(tron, 2), "-filter_complex", _eyes(2160) + ";[l][r]vstack[v]",
                  "-map", "[v]", "-c:v", "libx265", "-preset", "fast", "-crf", "24", "-tag:v", "hvc1",
                  "-pix_fmt", "yuv420p", "-x265-params", "log-level=error", *audio]},
        {"name": "tb-projectx-1024-meta.webm", "expect": "tb",
         "args": [*clip(projectx, 0), "-filter_complex", _eyes(1024) + ";[l][r]vstack[v]",
                  "-map", "[v]", "-c:v", "libvpx-vp9", "-b:v", "3M", "-deadline", "realtime", "-cpu-used", "8",
                  "-metadata:s:v:0", "stereo_mode=top_bottom", "-map", "0:a?", "-c:a", "libopus"]},
        {"name": "tb-tron-2048-still.png", "expect": "tb",
         "args": ["-ss", "6", "-i", str(tron), "-filter_complex", _eyes(2048) + ";[l][r]vstack[v]",
                  "-map", "[v]", "-frames:v", "1"]},
        {"name": "neg-tb-duplicate.mp4", "expect": "mono",
         "args": [*clip(weeknd, 0), "-filter_complex",
                  "[0:v]crop=iw/2:ih:0:0,scale=1920:1920,setsar=1,split=2[l][r];[l][r]vstack[v]",
                  "-map", "[v]", *h264]},
        {"name": "neg-tb-two-clips.mp4", "expect": "mono",
         "args": [*clip(weeknd, 0), *clip(tron, 2), "-filter_complex", _eyes(1920, "1:v") + ";[l][r]vstack[v]",
                  "-map", "[v]", *h264]},
        {"name": "neg-tb-inverted-meta.webm", "expect": "mono",
         "args": [*clip(projectx, 0), "-filter_complex", _eyes(1024) + ";[l][r]vstack[v]",
                  "-map", "[v]", "-c:v", "libvpx-vp9", "-b:v", "3M", "-deadline", "realtime", "-cpu-used", "8",
                  "-metadata:s:v:0", "stereo_mode=bottom_top"]},
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    for fixture in fixtures:
        dest = OUT / fixture["name"]
        args = fixture.pop("args")
        if rebuild or not dest.exists() or dest.stat().st_size == 0:
            _ffmpeg([*args, str(dest)])
    return fixtures


def _probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = (data.get("streams") or [{}])[0]
    duration = float((data.get("format") or {}).get("duration") or 0)
    return {"codec": stream.get("codec_name"), "width": stream.get("width"),
            "height": stream.get("height"), "duration": duration}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--rebuild", action="store_true", help="re-encode fixtures that already exist")
    args = parser.parse_args()

    print("Cost: $0 (local ffmpeg only).")
    rows = []
    for fixture in build(args.seconds, args.rebuild):
        path = OUT / fixture["name"]
        info = _probe(path)
        kind = "image" if path.suffix == ".png" else "video"
        result = SD.detect_stereo(str(path), info["width"], info["height"], kind=kind,
                                  duration=info["duration"] or None)
        layout = result["candidate"] if result["detected"] else "mono"
        rows.append({**fixture, **info, "kind": kind, **result, "ok": layout == fixture["expect"]})
        print(f"{'ok ' if rows[-1]['ok'] else 'BAD'} {fixture['name']:28s} {info['width']}x{info['height']} "
              f"{info['codec']:5s} detected={result['detected']} method={result['method']} score={result['score']}")

    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    lines = ["| file | size | codec | expect | detected | method | score | ok |", "|---|---|---|---|---|---|---|---|"]
    for row in rows:
        lines.append(f"| {row['name']} | {row['width']}x{row['height']} | {row['codec']} | {row['expect']} | "
                     f"{row['detected']} | {row['method']} | {row['score']} | {'yes' if row['ok'] else 'NO'} |")
    (OUT / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    sys.exit(0 if all(row["ok"] for row in rows) else 1)


if __name__ == "__main__":
    main()
