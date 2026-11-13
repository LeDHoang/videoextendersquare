"""Replies to comments: one level of threading, general (never time-synced), same post only."""
from __future__ import annotations

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient

from test_admin_console import app, code, create_post, mutate, register  # noqa: F401  (app is a fixture)
from test_migration_stereo_layout import _alembic, _reset_postgres, _urls
from server.social.database import EXPECTED_SCHEMA_REVISION
from server.social.models import Post
from server.social.services import reel_records


@pytest.fixture
def clients(app):  # noqa: F811
    with TestClient(app) as ann_client, TestClient(app) as bob_client:
        yield {
            "ann": (ann_client, register(ann_client, "ann_user")),
            "bob": (bob_client, register(bob_client, "bob_user")),
        }


def comments(client, post_id):
    return client.get(f"/api/posts/{post_id}/comments").json()["comments"]


def test_reply_threads_under_the_top_level_comment(app, clients):  # noqa: F811
    ann, ann_user = clients["ann"]
    bob, _ = clients["bob"]
    post_id = create_post(app, ann_user["id"])

    root = mutate(ann, "POST", f"/api/posts/{post_id}/comments", {"text": "first", "timestamp": 3.0}).json()
    assert root["parent_id"] is None and root["timestamp"] == 3.0

    # A reply ignores the sync time it was sent with: replies never pop up on the timeline.
    reply = mutate(bob, "POST", f"/api/posts/{post_id}/comments",
                   {"text": "agreed", "timestamp": 5.0, "parent_id": root["id"]})
    assert reply.status_code == 200, reply.text
    assert reply.json()["parent_id"] == root["id"] and reply.json()["timestamp"] is None

    # Replying to a reply joins the same top-level thread.
    nested = mutate(ann, "POST", f"/api/posts/{post_id}/comments",
                    {"text": "@bob_user thanks", "parent_id": reply.json()["id"]}).json()
    assert nested["parent_id"] == root["id"]

    listed = comments(bob, post_id)
    assert [(row["text"], row["parent_id"]) for row in listed] == [
        ("first", None), ("agreed", root["id"]), ("@bob_user thanks", root["id"]),
    ]
    with app.state.Session() as db:
        # Replies count toward the post's comments.
        assert db.get(Post, post_id).comment_count == 3
        # The feed's batched records carry parent_id too.
        media_path = db.get(Post, post_id).media_path
        records = reel_records([media_path], db=db)[media_path]["comments"]
        assert [row["parent_id"] for row in records] == [None, root["id"], root["id"]]


def test_reply_parent_must_be_a_visible_comment_on_the_same_post(app, clients):  # noqa: F811
    ann, ann_user = clients["ann"]
    bob, _ = clients["bob"]
    post_id = create_post(app, ann_user["id"])
    other_post_id = create_post(app, ann_user["id"], title="Other")
    root = mutate(ann, "POST", f"/api/posts/{post_id}/comments", {"text": "root"}).json()

    elsewhere = mutate(bob, "POST", f"/api/posts/{other_post_id}/comments", {"text": "x", "parent_id": root["id"]})
    assert elsewhere.status_code == 422 and code(elsewhere) == "INVALID_PARENT_COMMENT"

    missing = mutate(bob, "POST", f"/api/posts/{post_id}/comments", {"text": "x", "parent_id": "nope"})
    assert missing.status_code == 404 and code(missing) == "COMMENT_NOT_FOUND"

    assert mutate(ann, "DELETE", f"/api/comments/{root['id']}").status_code == 200
    deleted = mutate(bob, "POST", f"/api/posts/{post_id}/comments", {"text": "x", "parent_id": root["id"]})
    assert deleted.status_code == 404 and code(deleted) == "COMMENT_NOT_FOUND"
    with app.state.Session() as db:
        assert db.get(Post, post_id).comment_count == 0


def test_replies_survive_their_parent_being_deleted(app, clients):  # noqa: F811
    ann, ann_user = clients["ann"]
    bob, _ = clients["bob"]
    post_id = create_post(app, ann_user["id"])
    root = mutate(ann, "POST", f"/api/posts/{post_id}/comments", {"text": "root"}).json()
    reply = mutate(bob, "POST", f"/api/posts/{post_id}/comments", {"text": "reply", "parent_id": root["id"]}).json()

    assert mutate(ann, "DELETE", f"/api/comments/{root['id']}").status_code == 200
    # The reply stays listed and counted; clients show it top-level once its parent is gone.
    assert [row["id"] for row in comments(bob, post_id)] == [reply["id"]]
    with app.state.Session() as db:
        assert db.get(Post, post_id).comment_count == 1

    # The surviving reply now stands top-level, so replying to it threads under it,
    # not under the deleted comment.
    nested = mutate(ann, "POST", f"/api/posts/{post_id}/comments",
                    {"text": "@bob_user still here", "parent_id": reply["id"]}).json()
    assert nested["parent_id"] == reply["id"]


def test_app_expects_the_migration_head(tmp_path, monkeypatch):
    # The app refuses to boot unless the database is at EXPECTED_SCHEMA_REVISION.
    head = ScriptDirectory.from_config(_alembic(_urls(tmp_path)[0], monkeypatch)).get_current_head()
    assert EXPECTED_SCHEMA_REVISION == head == "20261114_0025"


@pytest.mark.parametrize("index", [0, 1])
def test_comment_replies_migration_round_trips(tmp_path, monkeypatch, index):
    urls = _urls(tmp_path)
    if index >= len(urls):
        pytest.skip("SX_TEST_POSTGRES_URL is not set")
    url = urls[index]
    config = _alembic(url, monkeypatch)
    engine = sa.create_engine(url)
    _reset_postgres(engine)

    def columns():
        return {column["name"] for column in sa.inspect(engine).get_columns("comments")}

    try:
        command.upgrade(config, "20261114_0025")
        assert "parent_id" in columns()
        command.downgrade(config, "20261113_0024")
        assert "parent_id" not in columns()
        command.upgrade(config, "20261114_0025")
        assert "parent_id" in columns()
    finally:
        command.upgrade(config, "head")
        engine.dispose()
