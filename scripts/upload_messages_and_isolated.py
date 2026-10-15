#!/usr/bin/env python3
"""Upload updated Direct Messages and isolated Messaging Panel to Stitch and set canvas positions."""

import base64
import json
import os
import pathlib
import ssl
import sys
import time
import urllib.request
import certifi

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from scripts.upload_pages_to_stitch import get_api_key

PROJECT_ID = "11464227886850320723"
API_URL = "https://stitch.googleapis.com"

def upload_screen(api_key: str, file_path: pathlib.Path, title: str):
    print(f"Uploading {title} from {file_path}...")
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

    url = f"{API_URL}/v1/projects/{PROJECT_ID}/screens:batchCreate"
    payload = {
        "parent": f"projects/{PROJECT_ID}",
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
        res = json.loads(resp.read().decode("utf-8"))
        screen = res.get("results", [{}])[0].get("screen", {})
        print(f"  ✓ Created screen ID: {screen.get('id')} ({screen.get('title')})")
        return screen

def patch_screen_instances(api_key: str, new_instances_to_add_or_update: list[dict]):
    ctx = ssl.create_default_context(cafile=certifi.where())
    
    # 1. Get current project
    url = f"{API_URL}/v1/projects/{PROJECT_ID}"
    req = urllib.request.Request(url, headers={"X-Goog-Api-Key": api_key})
    with urllib.request.urlopen(req, context=ctx) as resp:
        proj = json.loads(resp.read().decode("utf-8"))

    existing_instances = proj.get("screenInstances", [])
    print(f"Current total screenInstances: {len(existing_instances)}")

    # Map by instance ID or sourceScreen
    instances_map = {inst.get("id"): inst for inst in existing_instances if inst.get("id")}

    for new_inst in new_instances_to_add_or_update:
        inst_id = new_inst.get("id")
        # Remove any existing instance pointing to the same sourceScreen at the same spot or replace
        instances_map[inst_id] = new_inst

    updated_list = list(instances_map.values())

    # 2. Patch screenInstances
    patch_url = f"{API_URL}/v1/projects/{PROJECT_ID}?updateMask=screenInstances"
    patch_payload = {
        "screenInstances": updated_list
    }
    patch_data = json.dumps(patch_payload).encode("utf-8")
    patch_req = urllib.request.Request(
        patch_url,
        data=patch_data,
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
        },
        method="PATCH",
    )
    with urllib.request.urlopen(patch_req, context=ctx, timeout=60) as resp:
        patched_proj = json.loads(resp.read().decode("utf-8"))
        print(f"  ✓ Patched screenInstances successfully. Total count: {len(patched_proj.get('screenInstances', []))}")
        return patched_proj

def main():
    api_key = get_api_key()
    pages_dir = pathlib.Path(".stitch/pages")

    # 1. Upload populated full direct messages page
    messages_png = pages_dir / "13_messages.png"
    messages_screen = upload_screen(api_key, messages_png, "ECHO - Direct Messages (Active Conversation)")

    # 2. Upload isolated messaging panel
    isolated_png = pages_dir / "23_message_dock_isolated.png"
    isolated_screen = upload_screen(api_key, isolated_png, "ECHO - Messaging Panel (Isolated)")

    time.sleep(2)

    # 3. Position instances so they are prominently visible
    # We place:
    # - Direct Messages at x: 12252, y: -1952 (updating old position) and at x: 12100, y: 1222
    # - Messaging Panel (Isolated) right next to it at x: 13800, y: -1952 and at x: 10500, y: 1222
    msg_sid = messages_screen["id"]
    iso_sid = isolated_screen["id"]

    instances = [
        # Cluster 1: Around -1952
        {
            "id": f"inst_dm_{msg_sid[:8]}",
            "sourceScreen": f"projects/{PROJECT_ID}/screens/{msg_sid}",
            "x": 12252,
            "y": -1952,
            "width": 1440,
            "height": 1027,
            "hidden": False
        },
        {
            "id": f"inst_iso_{iso_sid[:8]}",
            "sourceScreen": f"projects/{PROJECT_ID}/screens/{iso_sid}",
            "x": 13850,
            "y": -1952,
            "width": 720,
            "height": 520,
            "hidden": False
        },
        # Cluster 2: Around y: 1222 (Expanded components row)
        {
            "id": f"inst_dm_row2_{msg_sid[:8]}",
            "sourceScreen": f"projects/{PROJECT_ID}/screens/{msg_sid}",
            "x": 12100,
            "y": 1222,
            "width": 1440,
            "height": 1027,
            "hidden": False
        },
        {
            "id": f"inst_iso_row2_{iso_sid[:8]}",
            "sourceScreen": f"projects/{PROJECT_ID}/screens/{iso_sid}",
            "x": 10500,
            "y": 1222,
            "width": 720,
            "height": 520,
            "hidden": False
        },
        # Cluster 3: Also update old isolated screen if needed
        {
            "id": "5693862851266941129",
            "sourceScreen": f"projects/{PROJECT_ID}/screens/5693862851266941129",
            "x": 14700,
            "y": -1952,
            "width": 720,
            "height": 520,
            "hidden": False
        }
    ]

    print("\nPatching canvas positions...")
    patch_screen_instances(api_key, instances)
    print("\n✅ Finished uploading and positioning screens on Stitch!")

if __name__ == "__main__":
    main()
