"""scripts/prune_local_media.py: record first, then drop only the copies R2 holds."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import media_store
from server.social.database import Base
from server.social.models import Post, PostSlide
from test_media_store import FakeS3


def _prune_module():
    spec = importlib.util.spec_from_file_location(
        "prune_local_media", Path(__file__).resolve().parents[1] / "scripts" / "prune_local_media.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output" / "uploads").mkdir(parents=True)
    monkeypatch.setenv("SX_MEDIA_BASE_URL", "https://media.example.com")
    monkeypatch.setenv("R2_PUBLIC_BUCKET", "public-media")
    s3 = FakeS3()
    media_store.set_client(s3)
    engine = create_engine("sqlite:///" + str(tmp_path / "prune.db"))
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def add_post(name, *, status="published", files=(), in_r2=(), slides=()):
        for file in files:
            Path("output/uploads", file).write_bytes(b"bytes of " + file.encode())
        for file in in_r2:
            s3.objects[f"uploads/{file}"] = {"body": b"bytes of " + file.encode()}
        with Session() as db:
            post = Post(owner_id="owner", media_path=f"uploads/{name}.jpg", media_type="image", status=status)
            post.slides.extend(PostSlide(media_path=f"uploads/{slide}", position=i + 1) for i, slide in enumerate(slides))
            db.add(post)
            db.commit()

    yield Session, s3, add_post
    media_store.set_client(None)
    engine.dispose()


def test_prune_records_then_drops_what_r2_holds(library):
    Session, s3, add_post = library
    add_post(
        "cover",
        files=("cover.jpg", "cover-poster.jpg", "slide.jpg"),
        in_r2=("cover.jpg", "cover-poster.jpg"),  # the slide never reached R2
        slides=("slide.jpg",),
    )
    add_post("removed", status="hidden", files=("removed.jpg",), in_r2=("removed.jpg",))
    add_post("lost")

    with Session() as db:
        totals = _prune_module().prune(db)

    assert totals == {"posts": 2, "files": 3, "bytes": 61, "dropped": 2, "freed": 43, "unrecorded": 1}
    with Session() as db:
        cover = db.query(Post).filter_by(media_path="uploads/cover.jpg").one()
        assert set(cover.media_files) == {"uploads/cover.jpg", "uploads/cover-poster.jpg", "uploads/slide.jpg"}
        assert db.query(Post).filter_by(media_path="uploads/lost.jpg").one().media_files is None
    assert not Path("output/uploads/cover.jpg").exists()
    assert not Path("output/uploads/cover-poster.jpg").exists()
    assert Path("output/uploads/slide.jpg").exists()
    # An unpublished post's files are evidence: not even looked at.
    assert Path("output/uploads/removed.jpg").exists()


def test_prune_dry_run_changes_nothing(library):
    Session, s3, add_post = library
    add_post("cover", files=("cover.jpg",), in_r2=("cover.jpg",))

    with Session() as db:
        totals = _prune_module().prune(db, dry_run=True)

    assert totals == {"posts": 1, "files": 1, "bytes": 18, "dropped": 0, "freed": 0, "unrecorded": 0}
    assert Path("output/uploads/cover.jpg").exists()
    with Session() as db:
        assert db.query(Post).one().media_files is None
