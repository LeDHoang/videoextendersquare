"""/api/reels in pages: order, cursor stability, comments left out, cache per page."""

from __future__ import annotations

import json
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import reels
from server.social import database, safety
from server.social.database import Base
from server.social.models import Comment, Post, User
from server.social.services import create_or_update_post


def item(name: str, mtime: float, folder: str = "uploads") -> dict:
    rel_path = f"{folder}/{name}.png"
    return {
        "rel_path": rel_path,
        "path": f"output/{rel_path}",
        "filename": f"{name}.png",
        "folder": folder,
        "size_human": "1 KB",
        "mtime": mtime,
        "media_type": "image",
    }


# Names and times run in different orders, so each sort gives its own list.
NAMES = ["kiwi", "apple", "mango", "fig", "banana", "lime", "cherry", "date", "grape", "lemon"]


@pytest.fixture
def scan(monkeypatch):
    items = [item(name, 1000 + index * 10) for index, name in enumerate(NAMES)]
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: items)
    return items


@pytest.fixture
def db(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "paging.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", testing_session)
    monkeypatch.setattr(safety, "SessionLocal", testing_session)
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    session = testing_session()
    session.add(User(id="ann", username="ann", username_norm="ann", display_name="ann", status="active"))
    session.commit()
    yield session
    session.close()
    engine.dispose()


def call(db, **params):
    params.setdefault("viewer", None)
    return reels.list_reels(db=db, **params)


def paths(response) -> list[str]:
    return [entry["path"] for entry in response["videos"]]


def all_pages(db, limit: int, cursor: str | None = None, **params) -> list[dict]:
    pages = [call(db, limit=limit, cursor=cursor, **params)]
    while pages[-1]["next_cursor"]:
        pages.append(call(db, limit=limit, cursor=pages[-1]["next_cursor"], **params))
    return pages


@pytest.mark.parametrize("sort", ["newest", "oldest", "alphabetical", "views", "likes", "trending"])
def test_pages_follow_the_whole_list_order(db, scan, sort):
    whole = paths(call(db, sort=sort))

    pages = all_pages(db, 3, sort=sort)

    assert [len(page["videos"]) for page in pages] == [3, 3, 3, 1]
    assert sum((paths(page) for page in pages), []) == whole
    assert {page["count"] for page in pages} == {len(NAMES)}
    assert pages[-1]["next_cursor"] is None


def test_the_whole_list_keeps_its_shape(db, scan):
    response = call(db)

    assert len(response["videos"]) == len(NAMES)
    assert response["next_cursor"] is None
    assert all("comments" in entry for entry in response["videos"])


def test_a_shuffle_keeps_its_order_across_pages_and_minutes(db, scan, monkeypatch):
    clock = {"now": 6_000_000.0}
    monkeypatch.setattr(reels.time, "time", lambda: clock["now"])
    first = call(db, sort="shuffle", limit=4)
    assert paths(call(db, sort="shuffle", limit=4)) == paths(first)

    clock["now"] += 600
    rest = all_pages(db, 4, sort="shuffle", cursor=first["next_cursor"])

    shuffled = paths(first) + sum((paths(page) for page in rest), [])
    assert sorted(shuffled) == sorted(entry["rel_path"] for entry in scan)
    assert shuffled != paths(call(db, sort="newest"))


def test_posts_added_after_the_first_page_neither_repeat_nor_shift_it(db, scan):
    first = call(db, limit=4)
    seen = paths(first)

    scan.insert(0, item("newest", 9999))  # lands before the cursor: on no later page
    scan.append(item("ancient", 1))  # lands after it: on a later page
    rest = all_pages(db, 4, cursor=first["next_cursor"])

    later = sum((paths(page) for page in rest), [])
    assert not set(later) & set(seen)
    assert "uploads/newest.png" not in later
    assert later[-1] == "uploads/ancient.png"
    assert len(seen) + len(later) == len(NAMES) + 1


def test_removing_the_cursor_item_keeps_the_next_page_in_place(db, scan):
    whole = paths(call(db))
    first = call(db, limit=4)
    anchor = paths(first)[-1]

    scan[:] = [entry for entry in scan if entry["rel_path"] not in (anchor, whole[0], whole[5])]
    second = call(db, limit=4, cursor=first["next_cursor"])

    assert paths(second) == [path for path in whole[4:] if path != whole[5]][:4]


def test_a_bad_cursor_or_one_from_other_filters_is_refused(db, scan):
    cursor = call(db, limit=2)["next_cursor"]

    for bad, params in (("nope!", {}), (cursor, {"sort": "oldest"}), (cursor, {"folder": "other"})):
        with pytest.raises(HTTPException) as caught:
            call(db, limit=2, cursor=bad, **params)
        assert caught.value.status_code == 400
        assert caught.value.detail["code"] == "INVALID_CURSOR"


def test_the_limit_is_kept_between_1_and_100(db, monkeypatch):
    many = [item(f"n{index:03d}", index) for index in range(130)]
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: many)

    assert len(call(db, limit=0)["videos"]) == 1
    assert len(call(db, limit=500)["videos"]) == 100


def test_a_page_counts_comments_without_embedding_them(db, scan):
    post = create_or_update_post(db, media_path=scan[-1]["rel_path"], media_type="image", owner=db.get(User, "ann"))
    db.add_all([Comment(post_id=post.id, author_id="ann", text=f"hi {index}") for index in range(2)])
    db.commit()

    whole = call(db)["videos"][0]
    paged = call(db, limit=2)["videos"][0]

    assert paged["path"] == whole["path"] == scan[-1]["rel_path"]
    assert len(whole["comments"]) == 2
    assert "comments" not in paged
    assert paged["comments_count"] == 2
    assert {key for key in whole if key != "comments"} <= set(paged)


def test_an_author_feed_pages_newest_first(db, scan):
    owner = db.get(User, "ann")
    for entry in scan[:3]:
        create_or_update_post(db, media_path=entry["rel_path"], media_type="image", owner=owner)
    db.commit()

    pages = all_pages(db, 2, author="ann")

    assert sum((paths(page) for page in pages), []) == paths(call(db, author="ann"))
    assert [len(page["videos"]) for page in pages] == [2, 1]


def test_an_author_feed_pages_by_post_time_not_file_time(db, scan):
    owner = db.get(User, "ann")
    # Posted newest file first, so post order and file order disagree.
    for minute, entry in enumerate(reversed(scan[:3])):
        post = create_or_update_post(db, media_path=entry["rel_path"], media_type="image", owner=owner)
        post.created_at = datetime(2026, 11, 1, 12, minute)
    db.commit()

    pages = all_pages(db, 2, author="ann")

    whole = paths(call(db, author="ann"))
    assert whole == [entry["rel_path"] for entry in scan[:3]]
    assert sum((paths(page) for page in pages), []) == whole


def test_a_post_deep_link_with_a_limit_is_one_page(db, scan):
    post = create_or_update_post(db, media_path=scan[2]["rel_path"], media_type="image", owner=db.get(User, "ann"))
    db.commit()

    response = call(db, post=post.id, limit=5)

    assert paths(response) == [scan[2]["rel_path"]]
    assert response["next_cursor"] is None


def test_each_page_is_built_once_from_the_payload_cache(db, scan, monkeypatch):
    builds: list[list[str]] = []
    real = reels._build_payload_entries

    def counting(videos, *args, **kwargs):
        builds.append([entry["rel_path"] for entry in videos])
        return real(videos, *args, **kwargs)

    monkeypatch.setattr(reels, "_build_payload_entries", counting)
    first = call(db, limit=3)
    second = call(db, limit=3, cursor=first["next_cursor"])
    again = call(db, limit=3)

    assert builds == [paths(first), paths(second)]
    assert json.dumps(again) == json.dumps(first)
