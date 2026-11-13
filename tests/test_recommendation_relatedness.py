from datetime import datetime, timezone

from server.social.recommendations.relatedness import (
    block_diverse,
    build_idf,
    location_score,
    location_scores,
    text_scores,
    tokenize,
)
from server.social.recommendations.types import CatalogItem, PostLocation

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


def _item(post_id, caption="", location=None):
    return CatalogItem(post_id, "owner", (), NOW, 0, 0, tokenize(caption), location)


def test_tokenize_keeps_unicode_and_hashtags():
    tokens = tokenize("Phố cổ Hà Nội #streetfood https://x.io/a the")
    assert "phố" in tokens and "nội" in tokens and "streetfood" in tokens
    assert "the" not in tokens and "https" not in tokens and "x.io" not in tokens
    assert "cổ" not in tokens and "hà" not in tokens


def test_tokenize_empty():
    assert tokenize("") == ()


def test_text_scores_prefers_shared_distinctive_words():
    items = {
        item.post_id: item
        for item in (
            _item("A", "saigon night market neon"),
            _item("B", "night market neon lights"),
            _item("C", "mountain hiking sunrise"),
            _item("F1", "coffee brewing morning"),
            _item("F2", "guitar practice session"),
            _item("F3", "beach volleyball summer"),
        )
    }
    scores = text_scores([(items["A"], 1.0)], items, build_idf(items.values()))
    assert scores["B"][0] > scores.get("C", (0.0,))[0]
    assert scores["B"][1] == ("A",)
    assert "A" not in scores


def test_text_scores_degenerate_inputs():
    same = {p: _item(p, "saigon night market") for p in ("A", "B", "C")}
    assert text_scores([(same["A"], 1.0)], same, build_idf(same.values())) == {}

    mixed = {
        "A": _item("A", ""),
        "B": _item("B", "night market neon"),
        "C": _item("C", "mountain hiking sunrise"),
    }
    assert text_scores([(mixed["A"], 1.0)], mixed, build_idf(mixed.values())) == {}

    stop = {p: _item(p, "the and for with that") for p in ("A", "B")}
    assert text_scores([(stop["A"], 1.0)], stop, build_idf(stop.values())) == {}
    assert build_idf([]) == {}


def _place(slug, city, country, coords):
    return PostLocation(slug, city, country, coords)


def test_location_scores_order():
    hanoi = _place("hanoi--vietnam", "Hanoi", "Vietnam", (21.03, 105.85))
    items = {
        item.post_id: item
        for item in (
            _item("seed", location=hanoi),
            _item("same", location=hanoi),
            _item("near", location=_place("ha-noi--vietnam", "Ha Noi", "Vietnam", (21.04, 105.86))),
            _item("far", location=_place("hai-phong--vietnam", "Hai Phong", "Vietnam", (20.86, 106.68))),
            _item("south", location=_place("ho-chi-minh-city--vietnam", "Ho Chi Minh City", "Vietnam", (10.82, 106.63))),
            _item("none"),
        )
    }
    scores = location_scores([(items["seed"], 1.0)], items)
    assert scores["same"][0] == 1.0
    assert scores["same"][0] > scores["near"][0] > scores["far"][0] > scores.get("south", (0.0,))[0]
    assert "south" not in scores  # ~1140 km: exp(-d/50) is under 0.05 and coords rule out the country fallback
    assert "none" not in scores and "seed" not in scores
    assert scores["near"][1] == ("seed",)


def test_location_score_fallbacks_without_coords():
    a = _place("a--vn", "Hue", "Vietnam", None)
    assert location_score(None, a) == 0.0
    assert location_score(a, _place("hue--vn", "hue", "VIETNAM", None)) == 0.6
    assert location_score(a, _place("x--vn", "Dalat", "Vietnam", None)) == 0.15
    assert location_score(a, _place("x--th", "Hue", "Thailand", None)) == 0.0


def test_age_factor_tiers():
    from server.social.recommendations.relatedness import age_factor

    assert age_factor(0) == 1.0
    assert age_factor(90) == 0.85
    assert age_factor(180) == 0.70
    assert age_factor(365) == 0.55
    assert age_factor(2000) == 0.40
    values = [age_factor(day) for day in range(3001)]
    assert all(later <= earlier for earlier, later in zip(values, values[1:]))


def test_block_diverse_caps_creators_per_block():
    ids = [f"a{i}" for i in range(10)] + [f"b{i}" for i in range(10)]
    owner = {post_id: post_id[0] for post_id in ids}
    out = block_diverse(ids, owner, block=6, cap=3)
    assert sorted(out) == sorted(ids)
    for start in range(0, 12, 6):
        chunk = out[start:start + 6]
        assert [owner[p] for p in chunk].count("a") <= 3
        assert [owner[p] for p in chunk].count("b") <= 3
    # Only one creator left: fills in input order past the cap.
    only = block_diverse(["a0", "a1", "a2", "a3", "a4"], {f"a{i}": "a" for i in range(5)}, block=4, cap=2)
    assert only == ["a0", "a1", "a2", "a3", "a4"]
