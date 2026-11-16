from __future__ import annotations

from contextlib import ExitStack
from types import SimpleNamespace

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.routers import account_safety, messages, packs, reels, social
from server.social import auth, database, safety
from server.social.database import Base, get_db
from server.social.geo import location_key
from server.social.models import Post, User
from server.social.recommendations import actor_identity
from server.social.recommendations import service as recommendation_service
from server.social.services import create_or_update_post, invalidate_reel_records, scoped_media_paths


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_MESSAGE_ENCRYPTION_KEY", "test-only-message-key-with-at-least-32-chars")
    monkeypatch.setattr(
        auth,
        "PASSWORD_HASHER",
        PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1),
    )
    test_engine = create_engine(
        "sqlite:///" + str(tmp_path / "private.db"),
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(test_engine)

    application = FastAPI()
    application.include_router(account_safety.router)
    application.include_router(social.router)
    application.include_router(packs.router)
    application.include_router(messages.router)
    application.include_router(reels.router)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    application.dependency_overrides[get_db] = override_get_db
    application.state.testing_session = testing_session
    yield application
    Base.metadata.drop_all(test_engine)
    test_engine.dispose()


def register(client: TestClient, username: str, email: str) -> dict:
    response = register_verified(client,
        json={
            "email": email,
            "username": username,
            "password": PASSWORD,
            "accept_terms": True,
            "display_name": username.title(),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client: TestClient) -> dict[str, str]:
    token = client.cookies.get("echo_csrf")
    assert token
    return {"x-csrf-token": token}


def make_post(
    app: FastAPI,
    owner_id: str,
    name: str,
    *,
    visibility: str = "public",
    tags=(),
    media_type: str = "video",
    title: str = "",
    location: dict | None = None,
) -> Post:
    with app.state.testing_session() as db:
        owner = db.get(User, owner_id)
        post = create_or_update_post(
            db,
            media_path=f"uploads/{name}.{'png' if media_type == 'image' else 'mp4'}",
            media_type=media_type,
            owner=owner,
            title=title,
            tags=list(tags),
            location=location,
            visibility=visibility,
        )
        db.commit()
        return post


def stored_visibility(app: FastAPI, post_id: str) -> str:
    with app.state.testing_session() as db:
        return db.get(Post, post_id).visibility


def test_patch_switches_visibility_both_ways(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "switch")
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "private"}, headers=csrf_headers(alice))
        assert r.status_code == 200 and r.json()["post"]["visibility"] == "private"
        assert stored_visibility(app, post.id) == "private"
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "public"}, headers=csrf_headers(alice))
        assert r.json()["post"]["visibility"] == "public"
        assert stored_visibility(app, post.id) == "public"


def test_patch_without_visibility_keeps_it(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "keep", visibility="private")
        r = alice.patch(f"/api/posts/{post.id}", json={"title": "x"}, headers=csrf_headers(alice))
        assert r.status_code == 200 and r.json()["post"]["visibility"] == "private"
        assert stored_visibility(app, post.id) == "private"


def test_only_the_owner_changes_visibility(app):
    with TestClient(app) as alice, TestClient(app) as bob:
        user = register(alice, "alice", "alice@example.com")
        register(bob, "bob", "bob@example.com")
        post = make_post(app, user["id"], "owned")
        r = bob.patch(f"/api/posts/{post.id}", json={"visibility": "private"}, headers=csrf_headers(bob))
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "FORBIDDEN"
        assert stored_visibility(app, post.id) == "public"


def test_unknown_visibility_is_refused(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "bad")
        r = alice.patch(f"/api/posts/{post.id}", json={"visibility": "friends"}, headers=csrf_headers(alice))
        assert r.status_code == 422
        assert stored_visibility(app, post.id) == "public"


def test_reimport_keeps_a_private_post_private(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        post = make_post(app, user["id"], "reimport", visibility="private")
        with app.state.testing_session() as db:
            owner = db.get(User, user["id"])
            create_or_update_post(db, media_path="uploads/reimport.mp4", media_type="video", owner=owner)
            db.commit()
        assert stored_visibility(app, post.id) == "private"


def test_invalid_visibility_argument_raises(app):
    with TestClient(app) as alice:
        user = register(alice, "alice", "alice@example.com")
        with app.state.testing_session() as db:
            owner = db.get(User, user["id"])
            with pytest.raises(ValueError):
                create_or_update_post(
                    db, media_path="uploads/x.mp4", media_type="video", owner=owner, visibility="friends"
                )


# --- Task 3: private posts leave every listing --------------------------------

# Hanoi has no built-in coordinates; the activity map drops places without them.
HANOI = {"city": "Hanoi", "country": "Vietnam", "lat": 21.03, "lon": 105.85}
HANOI_KEY = location_key("Hanoi", "Vietnam")


def scan_item(post: Post, mtime: float) -> dict:
    """One scanned file, shaped like tests/test_reels_paging.py's ``item``."""
    folder, filename = post.media_path.rsplit("/", 1)
    return {
        "rel_path": post.media_path,
        "path": f"output/{post.media_path}",
        "filename": filename,
        "folder": folder,
        "size_human": "1 KB",
        "mtime": mtime,
        "media_type": "image",
    }


def make_sweep_post(app: FastAPI, owner_id: str, visibility: str) -> Post:
    return make_post(
        app, owner_id, f"sweep-{visibility}", visibility=visibility, tags=["sweep"],
        media_type="image", title=f"sweep {visibility}", location=dict(HANOI),
    )


def hanoi_activity(client: TestClient) -> dict:
    rows = client.get("/api/reels/locations/activity").json()["locations"]
    return next(row for row in rows if row["slug"] == HANOI_KEY)


@pytest.fixture
def world(app, tmp_path, monkeypatch):
    """alice has public ``pub`` and private ``priv``; bob follows alice; ``anon`` is signed out."""
    # Routes that open their own session (locations, tags) must read this database.
    monkeypatch.setattr(database, "SessionLocal", app.state.testing_session)
    monkeypatch.setattr(safety, "SessionLocal", app.state.testing_session)
    monkeypatch.setattr(reels, "META_FILE", tmp_path / "reels_meta.json")
    monkeypatch.setattr(reels, "COMMENTS_FILE", tmp_path / "reels_comments.json")
    scan: list[dict] = []
    monkeypatch.setattr(reels, "_scan_cached", lambda db=None: list(scan))
    with ExitStack() as stack:
        anon, bob, alice = (stack.enter_context(TestClient(app)) for _ in range(3))
        alice_user = register(alice, "alice", "alice@example.com")
        register(bob, "bob", "bob@example.com")
        assert bob.put("/api/users/alice/follow", headers=csrf_headers(bob)).status_code == 200
        pub = make_sweep_post(app, alice_user["id"], "public")
        scan.append(scan_item(pub, 1000))
        # The count lines must read the same with and without priv.
        baseline = {
            "locations": anon.get("/api/reels/locations").json(),
            "tags": anon.get("/api/reels/tags", params={"q": "sweep"}).json(),
            "activity": hanoi_activity(anon),
        }
        priv = make_sweep_post(app, alice_user["id"], "private")
        scan.append(scan_item(priv, 2000))
        invalidate_reel_records()
        yield SimpleNamespace(
            app=app, anon=anon, bob=bob, alice=alice, alice_id=alice_user["id"],
            pub=pub, priv=priv, baseline=baseline,
        )


SWEEP = [
    # (path, viewers it applies to, whether the response lists pub)
    ("/api/reels?limit=50", ("anon", "bob", "alice"), True),
    ("/api/reels?limit=50&sort=newest", ("anon", "bob", "alice"), True),
    ("/api/reels?limit=50&sort=for_you", ("anon", "bob", "alice"), True),
    ("/api/reels?limit=50&search=sweep", ("anon", "bob", "alice"), True),
    ("/api/reels?limit=50&feed=following", ("bob", "alice"), True),
    ("/api/reels/feed?limit=50", ("anon", "bob", "alice"), True),
    ("/api/reels/tags/sweep", ("anon", "bob", "alice"), True),
    (f"/api/reels/locations/{HANOI_KEY}", ("anon", "bob", "alice"), True),
    ("/api/reels/locations", ("anon", "bob", "alice"), False),
    ("/api/reels/locations/activity", ("anon", "bob", "alice"), False),
    ("/api/reels/tags?q=sweep", ("anon", "bob", "alice"), False),
    ("/api/feed", ("anon", "bob", "alice"), True),
    ("/api/search/suggestions?q=sweep", ("anon", "bob", "alice"), True),
    ("/api/users/alice/posts", ("anon", "bob"), True),
    # Returns creators, not posts; bob follows alice, so she is not among them.
    ("/api/recommendations/creators", ("bob",), False),
]


@pytest.mark.parametrize(
    ("path", "viewer", "lists_pub"),
    [(path, viewer, lists_pub) for path, viewers, lists_pub in SWEEP for viewer in viewers],
)
def test_private_post_leaves_every_listing(world, path, viewer, lists_pub):
    response = getattr(world, viewer).get(path)
    assert response.status_code == 200, response.text
    assert world.priv.id not in response.text
    assert world.priv.media_path not in response.text
    if lists_pub:
        assert world.pub.media_path in response.text


@pytest.mark.parametrize("viewer", ["anon", "bob", "alice"])
def test_private_post_leaves_the_place_and_tag_counts(world, viewer):
    client = getattr(world, viewer)
    locations = client.get("/api/reels/locations").json()
    assert next(row for row in locations["locations"] if row["slug"] == HANOI_KEY)["reel_count"] == 1
    assert locations == world.baseline["locations"]
    tags = client.get("/api/reels/tags", params={"q": "sweep"}).json()
    assert next(row for row in tags["tags"] if row["slug"] == "sweep")["reel_count"] == 1
    assert tags == world.baseline["tags"]
    activity = hanoi_activity(client)
    assert activity["active_reel_count"] == world.baseline["activity"]["active_reel_count"] == 1


def test_owner_sees_private_post_on_own_profile(world):
    items = world.alice.get("/api/users/alice/posts").json()["items"]
    cards = {item["id"]: item for item in items}
    assert world.pub.id in cards
    assert cards[world.priv.id]["visibility"] == "private"


def test_profile_like_total_counts_public_only(world):
    for post in (world.pub, world.priv):
        assert world.bob.put(f"/api/posts/{post.id}/like", headers=csrf_headers(world.bob)).status_code == 200
    assert world.anon.get("/api/users/alice").json()["user"]["like_count"] == 1


def test_saved_list_hides_a_post_turned_private(world):
    def saved_ids() -> set[str]:
        return {item["id"] for item in world.bob.get("/api/users/me/saved").json()["items"]}

    assert world.bob.put(f"/api/posts/{world.pub.id}/save", headers=csrf_headers(world.bob)).status_code == 200
    assert world.pub.id in saved_ids()
    world.alice.patch(f"/api/posts/{world.pub.id}", json={"visibility": "private"}, headers=csrf_headers(world.alice))
    assert world.pub.id not in saved_ids()
    world.alice.patch(f"/api/posts/{world.pub.id}", json={"visibility": "public"}, headers=csrf_headers(world.alice))
    assert world.pub.id in saved_ids()


def test_a_post_turned_private_leaves_the_grid_at_once(world):
    # sort=for_you is the ranked grid (and its cache); the default sort is newest.
    grid = "/api/reels?limit=50&sort=for_you"
    assert world.pub.media_path in world.bob.get(grid).text
    r = world.alice.patch(f"/api/posts/{world.pub.id}", json={"visibility": "private"}, headers=csrf_headers(world.alice))
    assert r.status_code == 200
    assert world.pub.media_path not in world.bob.get(grid).text


def test_creator_with_only_private_posts_is_not_recommended(world):
    with TestClient(world.app) as carol, TestClient(world.app) as dave:
        carol_id = register(carol, "carol", "carol@example.com")["id"]
        dave_id = register(dave, "dave", "dave@example.com")["id"]
    make_post(world.app, carol_id, "carol-only", visibility="private", media_type="image")
    make_post(world.app, dave_id, "dave-only", media_type="image")
    response = world.anon.get("/api/recommendations/creators", params={"limit": 8})
    assert response.status_code == 200, response.text
    usernames = {item["creator"]["username"] for item in response.json()["items"]}
    assert "dave" in usernames
    assert "carol" not in usernames


def test_unavailable_paths_reveal_only_lifts_privacy(world):
    with world.app.state.testing_session() as db:
        assert world.priv.media_path in safety.unavailable_media_paths_for_viewer(None, db)
        assert world.priv.media_path in safety.unavailable_media_paths_for_viewer(world.alice_id, db)
        assert world.priv.media_path not in safety.unavailable_media_paths_for_viewer(
            None, db, reveal_post_id=world.priv.id
        )
        assert world.priv.media_path not in safety.unavailable_media_paths_for_viewer(
            world.alice_id, db, reveal_owner_id=world.alice_id
        )
        assert world.pub.media_path not in safety.unavailable_media_paths_for_viewer(None, db)
        db.get(Post, world.priv.id).status = "deleted"
        db.commit()
        assert world.priv.media_path in safety.unavailable_media_paths_for_viewer(
            world.alice_id, db, reveal_post_id=world.priv.id, reveal_owner_id=world.alice_id
        )


def test_scoped_paths_keep_private_rows_only_on_the_owners_own_author_feed(world):
    with world.app.state.testing_session() as db:
        bob_id = db.query(User.id).filter(User.username_norm == "bob").scalar()
        own = scoped_media_paths(viewer_id=world.alice_id, author="alice", db=db)
        assert world.priv.media_path in own and world.pub.media_path in own
        for paths in (
            scoped_media_paths(viewer_id=bob_id, author="alice", db=db),
            scoped_media_paths(viewer_id=None, author="alice", db=db),
            scoped_media_paths(viewer_id=world.alice_id, feed="following", db=db),
            scoped_media_paths(viewer_id=bob_id, feed="following", db=db),
        ):
            assert world.pub.media_path in paths
            assert world.priv.media_path not in paths


def test_recommender_catalog_skips_private_items_it_was_not_given(world):
    actor = actor_identity(world.alice_id, None)
    with world.app.state.testing_session() as db:
        def catalog(allowed):
            return recommendation_service._catalog(
                db, actor=actor, allowed_post_ids=allowed, excluded_post_ids=set(), surface="for_you",
            )

        assert set(catalog(None)) == {world.pub.id}
        assert set(catalog({world.pub.id, world.priv.id})) == {world.pub.id, world.priv.id}
