"""_build_payload builds each entry once and lays each viewer's state over it."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.routers import reels
from server.social import database, safety
from server.social.database import Base
from server.social.models import Post, PostLike, User, UserBlock
from server.social.services import create_or_update_post

PUBLISHED = "uploads/published.png"
OTHER = "uploads/other.png"
LEGACY = "uploads/legacy-local.png"
ITEMS = [
    {
        "rel_path": rel_path,
        "path": f"output/{rel_path}",
        "filename": rel_path.split("/")[-1],
        "folder": "uploads",
        "size_human": "1 KB",
        "mtime": 100 - index,
        "media_type": "image",
    }
    for index, rel_path in enumerate((PUBLISHED, OTHER, LEGACY))
]


@pytest.fixture
def db(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "payload.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", testing_session)
    monkeypatch.setattr(safety, "SessionLocal", testing_session)
    meta_file = tmp_path / "reels_meta.json"
    meta_file.write_text(json.dumps({LEGACY: {"title": "Local legacy", "likes": 3}}), encoding="utf-8")
    monkeypatch.setattr(reels, "META_FILE", meta_file)
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")

    session = testing_session()
    for name in ("ann", "bob", "cat"):
        session.add(User(id=name, username=name, username_norm=name, display_name=name, status="active"))
    session.flush()
    for path, owner in ((PUBLISHED, "ann"), (OTHER, "bob")):
        create_or_update_post(
            session, media_path=path, media_type="image", owner=session.get(User, owner), title=path
        )
    session.add(PostLike(user_id="cat", post_id=session.query(Post).filter_by(media_path=PUBLISHED).one().id))
    session.commit()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture
def builds(monkeypatch):
    """The rel_paths of every call to the underlying builder."""
    calls: list[list[str]] = []
    real = reels._build_payload_entries

    def counting(videos, *args, **kwargs):
        calls.append([item["rel_path"] for item in videos])
        return real(videos, *args, **kwargs)

    monkeypatch.setattr(reels, "_build_payload_entries", counting)
    return calls


def test_entries_are_built_once_per_item_and_codec(db, builds):
    first = reels._build_payload(ITEMS, "hevc", db=db)
    assert [entry["path"] for entry in first] == [PUBLISHED, OTHER, LEGACY]
    assert builds == [[PUBLISHED, OTHER, LEGACY]]

    assert reels._build_payload(ITEMS, "hevc", db=db) == first
    assert reels._build_payload(ITEMS[1:2], "hevc", db=db) == first[1:2]
    assert builds == [[PUBLISHED, OTHER, LEGACY]]

    reels._build_payload(ITEMS, "h264", db=db)
    assert builds[1:] == [[PUBLISHED, OTHER, LEGACY]]

    # A rescan makes new item dicts, which may describe changed files.
    rescanned = [dict(ITEMS[0]), *ITEMS[1:]]
    assert reels._build_payload(rescanned, "hevc", db=db) == first
    assert builds[2:] == [[PUBLISHED]]


def test_a_caller_cannot_change_the_kept_entries(db):
    first = reels._build_payload(ITEMS, "hevc", db=db)
    snapshot = json.dumps(first)
    for entry in first:
        entry["recommendation"] = {"position": 1}
        entry.pop("url")

    assert json.dumps(reels._build_payload(ITEMS, "hevc", db=db)) == snapshot


def test_a_committed_change_rebuilds_the_entries(db, builds):
    assert reels._build_payload(ITEMS, "hevc", db=db)[0]["title"] == PUBLISHED

    db.query(Post).filter_by(media_path=PUBLISHED).one().title = "Renamed"
    db.commit()

    assert reels._build_payload(ITEMS, "hevc", db=db)[0]["title"] == "Renamed"
    assert len(builds) == 2


@pytest.mark.parametrize("viewer", ["ann", "bob", "cat"])
def test_a_viewer_gets_what_a_direct_build_gives(db, viewer, builds):
    db.add(UserBlock(blocker_id="bob", blocked_id="cat"))
    db.commit()
    direct = reels._build_payload_entries(ITEMS, "hevc", viewer_id=viewer, db=db)
    reels._build_payload(ITEMS, "hevc", db=db)

    payload = reels._build_payload(ITEMS, "hevc", viewer_id=viewer, db=db)

    assert json.dumps(payload) == json.dumps(direct)
    assert payload[0]["liked_by_me"] is (viewer == "cat")
    assert payload[0]["creator"]["is_me"] is (viewer == "ann")
    # Only a post whose owner and viewer block each other is built for the viewer alone.
    assert builds[2:] == ([[OTHER]] if viewer == "cat" else [])
    anonymous = reels._build_payload(ITEMS, "hevc", db=db)
    assert [entry["liked_by_me"] for entry in anonymous] == [False, False, False]


def test_a_tunnel_payload_is_built_directly(db, builds):
    reels._build_payload(ITEMS, "hevc", db=db)

    payload = reels._build_payload(ITEMS, "hevc", tunnel="https://t.example", db=db)

    assert builds[1:] == [[PUBLISHED, OTHER, LEGACY]]
    assert payload == reels._build_payload_entries(ITEMS, "hevc", tunnel="https://t.example", db=db)


def test_saving_legacy_metadata_rebuilds_the_entries(db):
    assert reels._build_payload(ITEMS, "hevc", db=db)[2]["title"] == "Local legacy"

    reels._save_meta_raw({LEGACY: {"title": "Edited legacy", "likes": 3}})

    assert reels._build_payload(ITEMS, "hevc", db=db)[2]["title"] == "Edited legacy"
