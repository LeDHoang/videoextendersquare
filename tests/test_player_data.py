"""User text reaches the player page only as data (server/routers/reels.py)."""
from __future__ import annotations

import json
import re

from test_private_posts import app, make_post, scan_item, world  # noqa: F401  (fixtures)
from server.routers import reels
from server.social.services import invalidate_reel_records


# A template placeholder, a script close, an HTML comment open and a line
# separator: each one broke or could break the inline script when a title held it.
HOSTILE = "__FEED_STATE_JSON__ __VIDEO_DATA_JSON__ </script><!--<script> a b & c"

DATA_LINES = re.compile(r"let videoData = (.*);\n\s*const initialFeedState = (.*);\n")


def hostile_post(world, monkeypatch):
    post = make_post(world.app, world.alice_id, "hostile", title=HOSTILE)
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: [scan_item(post, 3000)])
    invalidate_reel_records()
    return post


def assert_data_is_intact(script: str, post) -> None:
    match = DATA_LINES.search(script)
    assert match, "the two data lines are missing from the player script"
    video_json, feed_json = match.groups()
    for raw in (video_json, feed_json):
        assert "<" not in raw and ">" not in raw and "&" not in raw
        assert " " not in raw and " " not in raw
    videos = json.loads(video_json)
    feed = json.loads(feed_json)
    assert [item["title"] for item in videos if item["path"] == post.media_path] == [HOSTILE]
    assert [item["title"] for item in feed["items"] if item["path"] == post.media_path] == [HOSTILE]


def test_inline_player_keeps_hostile_title_as_data(world, monkeypatch):
    post = hostile_post(world, monkeypatch)
    body = world.anon.get("/api/reels/player-inline", params={"post": post.id}).json()
    scripts = [script for script in body["scripts"] if isinstance(script, str) and "let videoData" in script]
    assert len(scripts) == 1
    assert_data_is_intact(scripts[0], post)


def test_player_page_keeps_hostile_title_as_data(world, monkeypatch):
    post = hostile_post(world, monkeypatch)
    response = world.anon.get("/api/reels/player", params={"post": post.id})
    assert response.status_code == 200
    assert_data_is_intact(response.text, post)
