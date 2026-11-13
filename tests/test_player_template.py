"""/player prepares reels.html once per template version (server/routers/reels.py)."""
import os
import re

from server.routers import reels
from server.security_headers import nonce_html

TEMPLATE = """<html><head><title>t</title></head>
<body><div id="x">__ICON_HEART__</div>
<script>
__THREE_JS__
</script>
<script>__MISSING_JS__</script>
<script>boot(%s, __VIDEO_DATA_JSON__);</script></body></html>"""


def _write(path, text, mtime_ns):
    path.write_text(text, encoding="utf-8")
    os.utime(path, ns=(mtime_ns, mtime_ns))


def _per_request(template_html: str, nonce: str) -> str:
    """What /player did on every request before the template was kept."""
    html = nonce_html(template_html, nonce)
    html = reels._inject_icons(html)
    for placeholder, name in reels.PLAYER_SCRIPTS.items():
        url = reels._player_script_url(name)
        html = re.sub(
            rf"(<script\b[^>]*)>\s*{placeholder}\s*</script>",
            (lambda m, url=url: f'{m.group(1)} src="{url}"></script>') if url else "",
            html,
        )
    return html


def test_prepared_template_matches_the_per_request_build_and_is_reused(tmp_path, monkeypatch):
    icons = tmp_path / "icons"
    icons.mkdir()
    _write(icons / "heart.svg", "<svg>one</svg>", 1_000_000_000)
    _write(tmp_path / "three.min.js", "var THREE;", 1_000_000_000)
    monkeypatch.setattr(reels, "ASSETS_DIR", tmp_path)
    monkeypatch.setattr(reels, "ICON_DIR", icons)
    monkeypatch.setattr(reels, "_icon_cache", {"sigs": {}, "snippets": {}})
    monkeypatch.setattr(reels, "_player_script_hashes", {})
    monkeypatch.setattr(reels, "_player_template_cache", {"key": None, "html": None})
    monkeypatch.setattr(reels, "PLAYER_SCRIPTS", {"__THREE_JS__": "three.min.js", "__MISSING_JS__": "missing.js"})
    template = tmp_path / "reels.html"
    _write(template, TEMPLATE % 1, 1_000_000_000)

    prepared = reels._player_template()
    assert '<script src="/api/reels/player-script/three.min.js?v=' in prepared
    assert "__MISSING_JS__" not in prepared and "<svg>one</svg>" in prepared
    assert nonce_html(prepared, "N0nce") == _per_request(TEMPLATE % 1, "N0nce")
    assert reels._player_template() is prepared

    _write(template, TEMPLATE % 2, 2_000_000_000)
    assert "boot(2," in reels._player_template()

    _write(icons / "heart.svg", "<svg>two</svg>", 2_000_000_000)
    assert "<svg>two</svg>" in reels._player_template()

    _write(tmp_path / "three.min.js", "var THREE = 2;", 2_000_000_000)
    assert reels._player_template() != prepared
    assert nonce_html(reels._player_template(), "N0nce") == _per_request(TEMPLATE % 2, "N0nce")


def test_player_emits_a_replay_event_when_a_reel_loops():
    html = (reels.ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    assert "event_type: 'replay'" in html


def test_vr_tile_tap_plays_through_the_recommender():
    html = (reels.ASSETS_DIR / "reels.html").read_text(encoding="utf-8")
    assert "onShellPlayFeed: playVrShellFeed" in html
    assert "scope_ids" in html
    assert "replaceFeedForVr(" in html
