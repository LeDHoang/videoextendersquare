"""Calibrate the stereo content detector against non-stereo 2:1 split screens.

Builds short 2:1 (and 1:2) negatives from the square clips in
output/testpipeline/ with ffmpeg — two different clips side by side, an
identical duplicate, a mirrored copy, time-offset copies, a before/after
colour grade, a zoomed copy — and scores them, plus the real SBS clips in
output/testpipeline-3d/, with pipeline.stereo_detect.detect_stereo.

For every frame it also records the best shift and the score at shift 0, to
see whether "identical halves" (best shift 0, score ~1) separates duplicates
from real stereo.

No paid API calls. Outputs go to reports/stereo-threshold/ (gitignored).

    .venv/bin/python scripts/dev/experiment_stereo_threshold.py [--seconds 6] [--keep]
"""
from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # repo root

from pipeline import stereo_detect as SD  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SOURCES = REPO / "output" / "testpipeline"
POSITIVES = REPO / "output" / "testpipeline-3d"
OUT = REPO / "reports" / "stereo-threshold"
EYE = 512
DERIVED = ("-explore", "-preview", "-mono", "-poster")


def _clips(folder: Path) -> list[Path]:
    return sorted(
        path for path in folder.glob("*.mp4")
        if not any(path.stem.endswith(tag) for tag in DERIVED)
    )


def _duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out or 0)


def _size(path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()[0]
    w, h = out.split("x")[:2]
    return int(w), int(h)


def _variants(seconds: float) -> dict[str, tuple[str, str]]:
    """name -> (filter for the second eye built from [a]/[b], stack: hstack|vstack)."""
    sq = f"scale={EYE}:{EYE}:force_original_aspect_ratio=increase,crop={EYE}:{EYE},setsar=1"
    zoom = f"crop=iw*0.8:ih*0.8,{sq}"
    return {
        "two_clips": ("[1:v]" + sq + "[r]", "hstack"),
        "duplicate": ("[0:v]" + sq + "[r]", "hstack"),
        "duplicate_tb": ("[0:v]" + sq + "[r]", "vstack"),
        "mirrored": ("[0:v]" + sq + ",hflip[r]", "hstack"),
        "offset_0.2s": ("[2:v]" + sq + "[r]", "hstack"),
        "offset_0.5s": ("[3:v]" + sq + "[r]", "hstack"),
        "offset_0.5s_tb": ("[3:v]" + sq + "[r]", "vstack"),
        "offset_2s": ("[4:v]" + sq + "[r]", "hstack"),
        "graded": ("[0:v]" + sq + ",eq=saturation=0.2:contrast=1.3:brightness=0.06,colorbalance=rs=0.3:bs=-0.3[r]", "hstack"),
        "zoomed": ("[0:v]" + zoom + "[r]", "hstack"),
    }


def _build(a: Path, b: Path, start: float, seconds: float, name: str, spec: tuple[str, str], dest: Path) -> None:
    second, stack = spec
    sq = f"scale={EYE}:{EYE}:force_original_aspect_ratio=increase,crop={EYE}:{EYE},setsar=1"
    inputs = []
    for path, offset in ((a, 0.0), (b, 0.0), (a, 0.2), (a, 0.5), (a, 2.0)):
        inputs += ["-ss", f"{start + offset:.3f}", "-t", f"{seconds:.3f}", "-i", str(path)]
    graph = f"[0:v]{sq}[l];{second};[l][r]{stack}=inputs=2[v]"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[v]",
         "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", str(dest)],
        check=True,
    )


def _frame_detail(path: Path, layout: str, duration: float) -> list[dict]:
    """Per frame: score, best shift, score at shift 0 (same math as pair_score)."""
    rows = []
    for frame in SD._video_frames(str(path), duration, layout):
        left, right = SD.eye_halves(frame, layout)
        a, b = SD._detail_patch(left), SD._detail_patch(right)
        spread = min(SD.ImageStat.Stat(a).stddev[0], SD.ImageStat.Stat(b).stddev[0])
        if spread < SD.MIN_DETAIL:
            rows.append({"flat": True})
            continue
        diffs = {s: SD._shift_diff(a, b, s) for s in range(-SD.MAX_SHIFT, SD.MAX_SHIFT + 1)}
        best_shift = min(diffs, key=diffs.get)
        unrelated = 1.128 * spread
        rows.append({
            "score": round(max(0.0, 1 - diffs[best_shift] / unrelated), 3),
            "best_shift": best_shift,
            "score_shift0": round(max(0.0, 1 - diffs[0] / unrelated), 3),
            "best_diff": round(diffs[best_shift], 3),
        })
    return rows


def _score(path: Path, label: str, group: str) -> dict:
    width, height = _size(path)
    duration = _duration(path)
    result = SD.detect_stereo(str(path), width, height, kind="video", duration=duration)
    layout = result["candidate"] or "sbs"
    frames = _frame_detail(path, layout, duration)
    scores = [frame["score"] for frame in frames if "score" in frame]
    # Content score even when metadata decided (the content pass is skipped then).
    content = round(statistics.median(scores), 3) if scores else None
    return {
        "group": group, "label": label, "file": str(path.relative_to(REPO)),
        "size": f"{width}x{height}", **result, "content_score": content, "frames": frames,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=6.0)
    parser.add_argument("--keep", action="store_true", help="keep the generated negatives")
    args = parser.parse_args()

    print("Cost: $0 (local ffmpeg only).")
    # Square clips long enough for the 2 s offset variant.
    sources = [
        clip for clip in _clips(SOURCES)
        if _size(clip)[0] == _size(clip)[1] and _duration(clip) >= args.seconds + 4
    ]
    if len(sources) < 2:
        sys.exit(f"need at least two square clips in {SOURCES}")
    OUT.mkdir(parents=True, exist_ok=True)
    clips_dir = OUT / "clips"
    clips_dir.mkdir(exist_ok=True)

    rows = []
    for index, a in enumerate(sources):
        b = sources[(index + 1) % len(sources)]
        start = max(0.0, min(10.0, _duration(a) - args.seconds - 2.5))
        for name, spec in _variants(args.seconds).items():
            dest = clips_dir / f"{index:02d}-{name}.mp4"
            _build(a, b, start, args.seconds, name, spec, dest)
            row = _score(dest, f"{a.stem[:40]} / {name}", name)
            rows.append(row)
            print(f"neg {name:15s} {row['content_score']!s:6} detected={row['detected']}  {a.stem[:40]}")

    for clip in _clips(POSITIVES):
        width, height = _size(clip)
        if SD.candidate_layout(width, height) is None:
            continue
        row = _score(clip, clip.stem[:50], "real_sbs" if width > height else "real_tb")
        rows.append(row)
        print(f"pos {row['group']:15s} {row['content_score']!s:6} detected={row['detected']} method={row['method']}  {clip.stem[:40]}")

    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    groups: dict[str, list[float]] = {}
    for row in rows:
        if row["content_score"] is not None:
            groups.setdefault(row["group"], []).append(row["content_score"])
    lines = [f"Threshold {SD.CONTENT_THRESHOLD}", "", "| group | n | min | median | max | detected |", "|---|---|---|---|---|---|"]
    for group, scores in groups.items():
        hits = sum(1 for row in rows if row["group"] == group and row["detected"])
        lines.append(
            f"| {group} | {len(scores)} | {min(scores):.2f} | {statistics.median(scores):.2f} | {max(scores):.2f} | {hits} |"
        )
    (OUT / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    if not args.keep:
        shutil.rmtree(clips_dir)


if __name__ == "__main__":
    main()
