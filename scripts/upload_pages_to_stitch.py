#!/usr/bin/env python3
"""Batch upload captured web page screenshots to the Stitch ECHO project."""

import argparse
import base64
import json
import os
import pathlib
import ssl
import sys
import time
import urllib.request
import certifi

DEFAULT_PROJECT_ID = "11464227886850320723"
DEFAULT_MANIFEST = ".stitch/pages/manifest.json"

def get_api_key():
    key = os.environ.get("STITCH_KEY")
    if key:
        return key.strip("\"'")
    env_path = pathlib.Path(".env")
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                if line.startswith("STITCH_KEY="):
                    return line.strip().split("=", 1)[1].strip("\"'")
    raise ValueError("STITCH_KEY not found in environment or .env")

def upload_screenshot(api_url: str, api_key: str, project_id: str, file_path: pathlib.Path, title: str):
    with open(file_path, "rb") as f:
        b64_data = base64.b64encode(f.read()).decode("utf-8")

    screen_request = {
        "screen": {
            "screenshot": {
                "fileContentBase64": b64_data,
                "mimeType": "image/png",
            },
            "screenType": "IMAGE",
            "isCreatedByClient": True,
            "title": title
        }
    }

    url = f"{api_url.rstrip('/')}/v1/projects/{project_id}/screens:batchCreate"
    payload = {
        "parent": f"projects/{project_id}",
        "requests": [screen_request],
        "createScreenInstances": True,
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
        },
        method="POST",
    )

    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", default=DEFAULT_PROJECT_ID)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest)
    if not manifest_path.exists():
        print(f"Error: Manifest {manifest_path} not found.")
        sys.exit(1)

    with open(manifest_path) as f:
        pages = json.load(f)

    print(f"Loaded {len(pages)} pages to upload to Stitch project {args.project_id}")
    api_key = get_api_key()

    successes = []
    failures = []

    for idx, page in enumerate(pages, 1):
        fpath = pathlib.Path(page["filePath"])
        title = page["title"]
        print(f"\n[{idx}/{len(pages)}] Uploading: {title} ({fpath.name}, {page['sizeBytes']} bytes, {page['height']}px)...")

        if args.dry_run:
            print("  [DRY-RUN] Skipping actual HTTP call.")
            continue

        try:
            res = upload_screenshot(
                api_url="https://stitch.googleapis.com",
                api_key=api_key,
                project_id=args.project_id,
                file_path=fpath,
                title=title
            )
            screen_id = res.get("results", [{}])[0].get("screen", {}).get("id", "unknown")
            print(f"  ✓ Uploaded successfully. Screen ID: {screen_id}")
            successes.append({"title": title, "file": fpath.name, "screen_id": screen_id})
        except Exception as e:
            print(f"  ✗ Upload failed: {e}")
            failures.append({"title": title, "file": fpath.name, "error": str(e)})

        # Brief rate-limit pause
        time.sleep(1.0)

    print("\n" + "=" * 50)
    print(f"Upload Summary: {len(successes)} succeeded, {len(failures)} failed.")
    if failures:
        print("Failures:")
        for f in failures:
            print(f"  - {f['title']}: {f['error']}")

if __name__ == "__main__":
    main()
