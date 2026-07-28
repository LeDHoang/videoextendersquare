import os
import shutil
import time
from pipeline.video_worker import process_video
from pipeline.utils import get_video_dimensions_and_duration

INPUT_DIR = os.path.join("input", "preupscale", "FAL Playground test")
OUTPUT_DIR = os.path.join("output", "FAL Playground test 4K")

def console_log(msg):
    print(f"  [STATUS] {msg}")

def main():
    if not os.path.exists(INPUT_DIR):
        print(f"Directory {INPUT_DIR} does not exist.")
        return

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith((".mp4", ".mov", ".avi", ".webm"))]

    if not files:
        print(f"No video files found in {INPUT_DIR}.")
        return

    print(f"Found {len(files)} video(s) in '{INPUT_DIR}'.")
    print(f"Output folder set to: '{OUTPUT_DIR}'\n")

    for file in sorted(files):
        file_path = os.path.join(INPUT_DIR, file)
        base_name, ext = os.path.splitext(file)
        
        w, h, d = get_video_dimensions_and_duration(file_path)
        print(f"==================================================")
        print(f"Processing: {file} ({w}x{h}, {d:.2f}s)")
        print(f"==================================================")

        # Studio Quality Upscale (VapourSynth znedi3 + FineSharp)
        studio_out = os.path.join(OUTPUT_DIR, f"{base_name}_studio_4k.mp4")
        if not os.path.exists(studio_out):
            print("  -> Running Local Studio Quality Upscale (znedi3 + FineSharp)...")
            t0 = time.time()
            try:
                _, upscaled_local = process_video(
                    video_path=file_path,
                    prompt=None,
                    upscale_only=True,
                    sharpening=0.0,
                    upscale_engine="studio",
                    status_callback=console_log
                )
                shutil.copy(upscaled_local, studio_out)
                print(f"  -> Saved {studio_out} (took {time.time()-t0:.2f}s)")
            except Exception as e:
                print(f"  -> Error in Studio upscale: {e}")
        else:
            print(f"  -> {studio_out} already exists. Skipping.")

    print("\nBatch upscale complete for FAL Playground test!")

if __name__ == "__main__":
    main()
