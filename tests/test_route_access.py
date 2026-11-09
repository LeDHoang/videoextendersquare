"""Access rules for every production API route.

Each route is listed in ROUTES with the access it needs, so a new route fails
``test_every_production_route_is_classified`` until someone decides who may
call it. Non-public routes must turn away anonymous callers (401), and
moderator, admin and production-hidden routes must turn away regular users.
"""

from __future__ import annotations

import re
from unittest.mock import patch

from argon2 import PasswordHasher
from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from verified_signup import register_verified
from server.social import auth
from server.social.database import Base, get_db

# server.app calls load_dotenv() at import; keep the developer's .env out.
with patch("dotenv.load_dotenv"):
    from server import app as app_module


# access, method, path. public: no sign-in (handlers may still check
# ownership: a job read is 404 for anyone but its owner); user: any signed-in
# account; moderator, admin: that role or higher; hidden: 404 in production.
ROUTES = """
user      GET    /api/account/fal-key
user      PUT    /api/account/fal-key
user      DELETE /api/account/fal-key
admin     GET    /api/admin/audit
admin     GET    /api/admin/switches
admin     PUT    /api/admin/switches
moderator GET    /api/admin/content
moderator POST   /api/admin/content/{content_type}/{content_id}/remove
admin     POST   /api/admin/content/{content_type}/{content_id}/restore
moderator GET    /api/admin/upload-logs
moderator GET    /api/admin/upload-logs/{post_id}
moderator GET    /api/admin/upload-logs/trace/{trace_id}
moderator GET    /api/admin/users
moderator GET    /api/admin/users/{user_id}
admin     POST   /api/admin/users/{user_id}/credits
admin     POST   /api/admin/users/{user_id}/delete
admin     POST   /api/admin/users/{user_id}/reinstate
admin     PUT    /api/admin/users/{user_id}/role
moderator POST   /api/admin/users/{user_id}/sign-out
moderator POST   /api/admin/users/{user_id}/suspend
public    POST   /api/auth/login
user      POST   /api/auth/logout
public    GET    /api/auth/me
user      PATCH  /api/auth/password
public    POST   /api/auth/password-reset/confirm
public    POST   /api/auth/password-reset/request
public    POST   /api/auth/register
public    POST   /api/auth/resend-verification
public    POST   /api/auth/verify-email
public    GET    /api/billing/catalog
user      POST   /api/billing/checkout-session
user      POST   /api/billing/estimate
user      POST   /api/billing/quote
user      GET    /api/billing/transactions
user      GET    /api/billing/wallet
public    POST   /api/billing/webhooks/stripe
user      DELETE /api/comments/{comment_id}
user      PUT    /api/comments/{comment_id}/like
user      DELETE /api/comments/{comment_id}/like
public    GET    /api/config
user      GET    /api/config/model-info
admin     PUT    /api/config/models
public    POST   /api/events
public    GET    /api/feed
public    GET    /api/health
public    GET    /api/healthz
public    GET    /api/image/jobs/{job_id}
user      POST   /api/image/jobs/{job_id}/cancel
public    GET    /api/image/jobs/{job_id}/download
public    GET    /api/image/jobs/{job_id}/result
public    GET    /api/image/jobs/{job_id}/stream
user      POST   /api/image/process
user      POST   /api/image/upload
user      GET    /api/messages/bootstrap
public    GET    /api/messages/capabilities
user      GET    /api/messages/conversations
user      POST   /api/messages/conversations
user      POST   /api/messages/conversations/{conversation_id}/accept
user      POST   /api/messages/conversations/{conversation_id}/decline
user      GET    /api/messages/conversations/{conversation_id}/messages
user      POST   /api/messages/conversations/{conversation_id}/messages
user      POST   /api/messages/conversations/{conversation_id}/read
user      POST   /api/messages/direct
user      GET    /api/messages/events
user      GET    /api/messages/gifs/search
user      POST   /api/messages/share-content
user      POST   /api/messages/share-reel
user      GET    /api/messages/unread-count
user      DELETE /api/messages/{message_id}
moderator GET    /api/moderation/reports
moderator PATCH  /api/moderation/reports/{report_id}
moderator POST   /api/moderation/reports/{report_id}/claim
moderator DELETE /api/moderation/reports/{report_id}/claim
moderator GET    /api/moderation/stats
moderator GET    /api/moderation/stats/hourly
moderator GET    /api/moderation/stats/accounts
moderator GET    /api/moderation/support
moderator PATCH  /api/moderation/support/{request_id}
moderator POST   /api/moderation/support/{request_id}/file-report
admin     GET    /api/ops/metrics
public    GET    /api/packs
user      POST   /api/packs
public    GET    /api/packs/{pack_id}
user      PATCH  /api/packs/{pack_id}
user      DELETE /api/packs/{pack_id}
user      POST   /api/packs/{pack_id}/items
user      DELETE /api/packs/{pack_id}/items/{post_id}
user      PUT    /api/packs/{pack_id}/like
user      DELETE /api/packs/{pack_id}/like
user      PUT    /api/packs/{pack_id}/progress
user      POST   /api/packs/{pack_id}/publish
user      PUT    /api/packs/{pack_id}/save
user      DELETE /api/packs/{pack_id}/save
public    GET    /api/packs/{pack_id}/share
user      POST   /api/packs/{pack_id}/unpublish
public    GET    /api/posts/{post_id}
user      PATCH  /api/posts/{post_id}
user      DELETE /api/posts/{post_id}
public    GET    /api/posts/{post_id}/comments
user      POST   /api/posts/{post_id}/comments
user      PUT    /api/posts/{post_id}/like
user      DELETE /api/posts/{post_id}/like
user      PUT    /api/posts/{post_id}/save
user      DELETE /api/posts/{post_id}/save
public    GET    /api/posts/{post_id}/share
public    POST   /api/posts/{post_id}/view
public    GET    /api/readyz
public    GET    /api/recommendations/creators
public    POST   /api/recommendations/feedback
public    GET    /api/reels
public    GET    /api/reels/comments
user      POST   /api/reels/comments
user      DELETE /api/reels/comments/{comment_id}
user      POST   /api/reels/comments/{comment_id}/like
hidden    GET    /api/reels/diag
hidden    POST   /api/reels/diag
public    GET    /api/reels/earth-texture
user      POST   /api/reels/explore-preview
public    GET    /api/reels/feed
user      POST   /api/reels/like
public    GET    /api/reels/locations
public    GET    /api/reels/locations/activity
public    GET    /api/reels/locations/{location_key}
public    GET    /api/reels/map-tiles/attribution
public    GET    /api/reels/map-tiles/{layer}/{z}/{x}/{y}.png
public    GET    /api/reels/map-tiles/{z}/{x}/{y}.png
public    GET    /api/reels/player
public    GET    /api/reels/player-inline
public    GET    /api/reels/player-script/{name}
admin     POST   /api/reels/proxy
admin     POST   /api/reels/spatialize
admin     GET    /api/reels/spatialize/jobs/{job_id}
public    GET    /api/reels/tags
public    GET    /api/reels/tags/{tag_name}
user      POST   /api/reels/unlike
public    POST   /api/reels/view
hidden    GET    /api/reels/vr-video-path-ab
user      POST   /api/reports
user      POST   /api/rewards/reels/claim
public    GET    /api/search/suggestions
user      POST   /api/stereo/convert
public    POST   /api/support
user      POST   /api/uploads/publish
user      PATCH  /api/users/me
user      DELETE /api/users/me
user      POST   /api/users/me/avatar
user      DELETE /api/users/me/avatar
user      GET    /api/users/me/blocked
user      GET    /api/users/me/packs
user      GET    /api/users/me/saved
user      GET    /api/users/me/saved-packs
public    GET    /api/users/{username}
user      PUT    /api/users/{username}/block
user      DELETE /api/users/{username}/block
user      PUT    /api/users/{username}/follow
user      DELETE /api/users/{username}/follow
public    GET    /api/users/{username}/followers
public    GET    /api/users/{username}/following
public    GET    /api/users/{username}/packs
public    GET    /api/users/{username}/posts
public    GET    /api/video/jobs/{job_id}
user      POST   /api/video/jobs/{job_id}/cancel
public    GET    /api/video/jobs/{job_id}/download
public    GET    /api/video/jobs/{job_id}/result
public    GET    /api/video/jobs/{job_id}/stream
user      POST   /api/video/process
user      POST   /api/video/upload
"""
ACCESS = {(method, path): access for access, method, path in (line.split() for line in ROUTES.strip().splitlines())}

ANONYMOUS_EXPECTED = {
    "user": (401, "AUTH_REQUIRED"),
    "moderator": (401, "AUTH_REQUIRED"),
    "admin": (401, "AUTH_REQUIRED"),
    "hidden": (404, None),
}
REGULAR_USER_EXPECTED = {
    "moderator": (403, "MODERATOR_REQUIRED"),
    "admin": (403, "ADMIN_REQUIRED"),
    "hidden": (404, None),
}


@pytest.fixture
def production_app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    monkeypatch.setenv("SX_SECURITY_SECRET", "test-only-security-secret")
    monkeypatch.setenv("SX_ENV", "production")
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "route-access.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    # The image ships a built SPA; a checkout may not. Mount a stub so its
    # routes are the same here as in production.
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html>", encoding="utf-8")
    mount_spa = app_module.mount_spa
    monkeypatch.setattr(app_module, "mount_spa", lambda app, _static_dir: mount_spa(app, static))
    application = app_module.create_app()

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    yield application
    engine.dispose()


def _operations(application) -> set[tuple[str, str]]:
    return {
        (method.upper(), path)
        for path, operations in application.openapi()["paths"].items()
        for method in operations
    }


def _outcomes(client, expected, headers=None) -> list[str]:
    """Call each route in ``expected`` and describe every unexpected answer."""
    wrong = []
    for (method, path), access in sorted(ACCESS.items()):
        if access not in expected:
            continue
        url = re.sub(r"\{[^}]+\}", "1", path)
        # A body lets body-taking routes reach their checks instead of a 422.
        response = client.request(method, url, json=None if method == "GET" else {}, headers=headers)
        detail = response.json().get("detail") if response.headers.get("content-type") == "application/json" else None
        code = detail.get("code") if isinstance(detail, dict) else None
        status, expected_code = expected[access]
        if response.status_code != status or (expected_code and code != expected_code):
            wrong.append(f"{access} {method} {path}: {response.status_code} {code or detail}")
    return wrong


def test_every_production_route_is_classified(production_app):
    routes = _operations(production_app)
    assert sorted(routes - set(ACCESS)) == [], "classify these routes in ROUTES"
    assert sorted(set(ACCESS) - routes) == [], "these ROUTES entries no longer exist"


def test_only_known_routes_are_left_out_of_the_schema(production_app):
    # The checks here walk the OpenAPI schema, which leaves out
    # include_in_schema=False routes, mounts, websockets and FastAPI's own
    # docs pages. These are all public today. A new one must be checked by
    # hand, then listed here.
    operations = _operations(production_app)
    unlisted = sorted(
        (type(context.route).__name__, method, context.path)
        for context in iter_route_contexts(production_app.routes)
        for method in sorted(context.methods or {""})
        if method != "HEAD" and (method, context.path) not in operations
    )
    assert unlisted == [
        ("APIRoute", "GET", "/{full_path:path}"),  # SPA shell
        ("APIRoute", "POST", "/api/csp-report"),
        ("Mount", "", "/assets"),
        ("Mount", "", "/avatars"),
        ("Route", "GET", "/docs"),
        ("Route", "GET", "/docs/oauth2-redirect"),
        ("Route", "GET", "/openapi.json"),
        ("Route", "GET", "/redoc"),
    ]


def test_anonymous_callers_are_refused_on_non_public_routes(production_app):
    assert _outcomes(TestClient(production_app), ANONYMOUS_EXPECTED) == []


def test_regular_users_are_refused_on_staff_and_hidden_routes(production_app):
    client = TestClient(production_app)
    response = register_verified(client,
        json={
            "email": "rita@example.com",
            "username": "rita",
            "password": "correct-horse-battery",
            "accept_terms": True,
            "display_name": "rita",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["role"] == "user"
    # CSRF and same-origin pass, so the role check is what refuses the call.
    headers = {"x-csrf-token": client.cookies.get("echo_csrf")}
    assert _outcomes(client, REGULAR_USER_EXPECTED, headers) == []
