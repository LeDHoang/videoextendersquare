"""Batch-spatialize every HEVC master in output/testpipeline -> output/testpipeline-3d.

Standalone CLI twin of the /api/reels/spatialize endpoint — run without the
server:
    python batch_spatialize.py            # default dirs
    python batch_spatialize.py --half     # half-SBS (3840x3840 output)
"""

import argparse
import os
import sys
import time

from pipeline.spatial_worker import (
    SpatializeError,
    discover_hevc_sources,
    process_video_spatial,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch 2D->SBS spatializer (local fast path)")
    parser.add_argument("--src", default=os.path.join("output", "testpipeline"))
    parser.add_argument("--out", default=os.path.join("output", "testpipeline-3d"))
    parser.add_argument("--strength", type=float, default=1.0, help="depth strength multiplier")
    parser.add_argument("--half", action="store_true", help="half-SBS output (per-eye downscaled)")
    parser.add_argument("--force", action="store_true", help="force overwrite of existing outputs")
    args = parser.parse_args()

    sources = discover_hevc_sources(args.src)
    if not sources:
        print(f"No HEVC masters found in {args.src}")
        return 1

    os.makedirs(args.out, exist_ok=True)
    print(f"Found {len(sources)} HEVC master(s) in {args.src}")

    failed = []
    processed_times = []
    batch_t0 = time.time()

    for i, src in enumerate(sources, 1):
        name = os.path.basename(src)
        dest = os.path.join(args.out, name)
        if not args.force and os.path.exists(dest) and os.path.getsize(dest) > 0:
            print(f"[{i}/{len(sources)}] SKIP {name} (already exists)")
            continue
        print(f"[{i}/{len(sources)}] {name}")
        try:
            reel_t0 = time.time()
            _, metrics = process_video_spatial(
                src, dest,
                status_callback=lambda m: print(f"    {m}"),
                strength=args.strength,
                half_sbs=args.half,
            )
            elapsed = round(time.time() - reel_t0, 2)
            processed_times.append((name, elapsed, metrics.get("resolution", "unknown"), metrics.get("frames", 0)))
            print(f"    OK {metrics['resolution']} in {elapsed}s")
        except (SpatializeError, Exception) as ex:  # noqa: BLE001
            failed.append((name, str(ex)))
            print(f"    FAILED: {ex}")

    batch_total_time = round(time.time() - batch_t0, 2)

    print("\n" + "=" * 60)
    print("BATCH SPATIALIZATION SUMMARY")
    print("=" * 60)
    if processed_times:
        print(f"Successfully processed: {len(processed_times)}/{len(sources)} reel(s)")
        for name, dur, res, frames in processed_times:
            print(f"  • {name}: {dur}s ({res}, {frames} frames)")
        avg_time = round(sum(t[1] for t in processed_times) / len(processed_times), 2)
        print(f"\nAverage time per reel: {avg_time}s")
        print(f"Total time elapsed:    {batch_total_time}s")
    else:
        print("No new reels were processed.")

    if failed:
        print(f"\n{len(failed)} failed:")
        for name, err in failed:
            print(f"  ✗ {name}: {err}")
        print("=" * 60)
        return 2

    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
