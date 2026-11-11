"""/player-inline splits reels.html once per template version (server/routers/reels.py)."""
import os

from server.routers import reels

TEMPLATE = """<html><head><style>.a { color: red; }</style></head>
<body><div id="x">__ICON_HEART__</div><script>__THREE_JS__</script><script>boot(%s);</script></body></html>"""


def _write(path, text, mtime_ns):
    path.write_text(text, encoding="utf-8")
    os.utime(path, ns=(mtime_ns, mtime_ns))


def test_template_is_split_again_only_when_the_file_or_an_icon_changes(tmp_path, monkeypatch):
    icons = tmp_path / "icons"
    icons.mkdir()
    _write(icons / "heart.svg", "<svg>one</svg>", 1_000_000_000)
    monkeypatch.setattr(reels, "ASSETS_DIR", tmp_path)
    monkeypatch.setattr(reels, "ICON_DIR", icons)
    monkeypatch.setattr(reels, "_icon_cache", {"sigs": {}, "snippets": {}})
    monkeypatch.setattr(reels, "_inline_template_cache", {"key": None, "parts": None})
    template = tmp_path / "reels.html"
    _write(template, TEMPLATE % 1, 1_000_000_000)

    tags, css, body = reels._inline_player_template()
    assert tags == ["__THREE_JS__", "boot(1);"]
    assert "#sxReelsRoot .a { color: red; }" in css
    assert body == '<div id="x"><svg>one</svg></div>'
    assert reels._inline_player_template() is reels._inline_template_cache["parts"]

    calls = []
    scope_css = reels._scope_css
    monkeypatch.setattr(reels, "_scope_css", lambda css: calls.append(1) or scope_css(css))
    reels._inline_player_template()
    assert calls == []

    _write(template, TEMPLATE % 2, 2_000_000_000)
    assert reels._inline_player_template()[0] == ["__THREE_JS__", "boot(2);"]

    _write(icons / "heart.svg", "<svg>two</svg>", 2_000_000_000)
    assert reels._inline_player_template()[2] == '<div id="x"><svg>two</svg></div>'
    assert len(calls) == 2
