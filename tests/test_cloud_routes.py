from __future__ import annotations

import time
import uuid

from argon2 import PasswordHasher
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import output
from server.billing.crypto import decrypt_fal_key
from server.billing.service import get_wallet, grant_credits
from server.jobs import JobStatus, job_manager
from server.routers import billing, image, social
from server.social import auth
from server.social.database import Base, get_db
from server.social.models import CloudGenerationBilling, FalCredential


PASSWORD = "correct-horse-battery"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "PASSWORD_HASHER", PasswordHasher(time_cost=1, memory_cost=1024, parallelism=1))
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "cloud-routes.db"),
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    application = FastAPI()
    application.include_router(social.router)
    application.include_router(image.router)
    application.include_router(billing.router)

    def override_get_db():
        with Session() as db:
            yield db

    application.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(image.job_manager, "submit", lambda *args, **kwargs: None)
    created_jobs = []
    staged_ids = []
    application.state.created_jobs = created_jobs
    application.state.staged_ids = staged_ids
    application.state.testing_session = Session
    yield application
    for stage_id in staged_ids:
        image.STAGED_UPLOADS.pop(stage_id, None)
    with job_manager._lock:
        for job_id in created_jobs:
            job_manager._jobs.pop(job_id, None)
    engine.dispose()


def register(client, username):
    response = client.post(
        "/api/auth/register",
        json={
            "email": f"{username}@example.com",
            "username": username,
            "password": PASSWORD,
            "display_name": username,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def csrf_headers(client):
    return {"x-csrf-token": client.cookies.get("echo_csrf")}


def test_cloud_requires_auth_while_square_local_processing_remains_anonymous(app, tmp_path, monkeypatch):
    source = tmp_path / "source.png"
    source.write_bytes(b"staged")
    cloud_stage = "cloud-" + uuid.uuid4().hex[:8]
    local_stage = "local-" + uuid.uuid4().hex[:8]
    app.state.staged_ids.extend([cloud_stage, local_stage])
    image.STAGED_UPLOADS[cloud_stage] = (str(source), time.time())
    image.STAGED_UPLOADS[local_stage] = (str(source), time.time())

    def dimensions(path):
        return (1000, 500) if image.STAGED_UPLOADS[cloud_stage][0] == path and current["stage"] == "cloud" else (1000, 1000)

    current = {"stage": "cloud"}
    monkeypatch.setattr(image, "get_image_dimensions", dimensions)
    with TestClient(app) as client:
        denied = client.post(
            "/api/image/process",
            data={"stage_id": cloud_stage, "upscale_only": "false", "upscale_engine": "fast"},
        )
        assert denied.status_code == 401
        assert denied.json()["detail"]["code"] == "AUTH_REQUIRED"

        current["stage"] = "local"
        accepted = client.post(
            "/api/image/process",
            data={"stage_id": local_stage, "upscale_only": "false", "upscale_engine": "fast"},
        )
        assert accepted.status_code == 200, accepted.text
        body = accepted.json()
        app.state.created_jobs.append(body["job_id"])
        assert body["payment_source"] == "local"
        assert job_manager.get_job(body["job_id"]).owner_id is None


def test_owned_cloud_job_status_and_download_are_private(app, tmp_path):
    with TestClient(app) as owner_client, TestClient(app) as other_client, TestClient(app) as anonymous:
        owner = register(owner_client, "cloud_owner")
        register(other_client, "cloud_other")
        job_id = "owned-" + uuid.uuid4().hex[:8]
        app.state.created_jobs.append(job_id)
        job_manager.create_job("image", owner_id=owner["id"], job_id=job_id)
        record = job_manager.get_job(job_id)
        result_dir = output.job_dir(job_id)
        result_dir.mkdir(parents=True, exist_ok=True)
        result_path = result_dir / "result.png"
        result_path.write_bytes(b"png")
        record.status = JobStatus.COMPLETE
        record.phase = "COMPLETE"
        record.result = {"path": str(result_path), "download_url": f"/api/image/jobs/{job_id}/download"}

        assert owner_client.get(f"/api/image/jobs/{job_id}").status_code == 200
        assert owner_client.get(f"/api/image/jobs/{job_id}/download").status_code == 200
        assert other_client.get(f"/api/image/jobs/{job_id}").status_code == 404
        assert other_client.get(f"/api/image/jobs/{job_id}/download").status_code == 404
        assert anonymous.get(f"/api/image/jobs/{job_id}").status_code == 404

def test_enqueue_failure_releases_reserved_credits(app, tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CREDITS_ENABLED", "1")
    monkeypatch.setenv("FAL_KEY", "platform-fal-key")
    source = tmp_path / "enqueue-failure.png"
    source.write_bytes(b"staged")
    stage_id = "enqueue-" + uuid.uuid4().hex[:8]
    app.state.staged_ids.append(stage_id)
    image.STAGED_UPLOADS[stage_id] = (str(source), time.time())
    monkeypatch.setattr(image, "get_image_dimensions", lambda _path: (1000, 500))
    monkeypatch.setattr(billing, "get_image_dimensions", lambda _path: (1000, 500))

    params = {
        "prompt": "",
        "upscale_only": False,
        "sharpening": 0.0,
        "upscale_engine": "fast",
        "upscale_model": "fal-ai/clarity-upscaler",
        "outpaint_model": "fal-ai/image-apps-v2/outpaint",
        "custom_outpaint_args": {},
        "custom_upscale_args": {},
    }

    with TestClient(app) as client:
        user = register(client, "enqueue_failure")
        with app.state.testing_session() as db:
            grant_credits(
                db, user["id"], 100, source="purchase",
                idempotency_key="purchase:enqueue-failure",
            )
            db.commit()

        quoted = client.post(
            "/api/billing/quote",
            json={"kind": "image", "stage_id": stage_id, "parameters": params},
            headers=csrf_headers(client),
        )
        assert quoted.status_code == 200, quoted.text

        def reject_enqueue(*_args, **_kwargs):
            raise RuntimeError("executor unavailable")

        monkeypatch.setattr(image.job_manager, "submit", reject_enqueue)
        response = client.post(
            "/api/image/process",
            data={
                **params,
                "custom_outpaint_args": "{}",
                "custom_upscale_args": "{}",
                "payment_source": "credits",
                "quote_id": quoted.json()["quote_id"],
                "stage_id": stage_id,
            },
            headers=csrf_headers(client),
        )
        assert response.status_code == 503, response.text
        assert response.json()["detail"]["code"] == "JOB_ENQUEUE_FAILED"

        with app.state.testing_session() as db:
            wallet = get_wallet(db, user["id"])
            billing_row = db.query(CloudGenerationBilling).filter_by(user_id=user["id"]).one()
            assert wallet["available_credits"] == 100
            assert wallet["reserved_credits"] == 0
            assert billing_row.status == "failed"
            assert billing_row.error_code == "enqueue_failed"
            assert job_manager.get_job(billing_row.job_id) is None



def test_fal_key_api_is_encrypted_redacted_and_user_owned(app, monkeypatch):
    monkeypatch.setenv("SX_FAL_KEY_ENCRYPTION_KEY", "test-only-dedicated-fal-encryption-secret")
    secret = "fal-example-secret-a123"

    with TestClient(app) as alice_client, TestClient(app) as bob_client, TestClient(app) as anonymous:
        assert anonymous.get("/api/account/fal-key").status_code == 401
        alice = register(alice_client, "fal_alice")
        bob = register(bob_client, "fal_bob")

        saved = alice_client.put(
            "/api/account/fal-key",
            json={"fal_key": secret},
            headers=csrf_headers(alice_client),
        )
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"configured": True, "hint": "••••a123"}
        assert secret not in saved.text
        assert alice_client.get("/api/account/fal-key").json() == saved.json()
        assert bob_client.get("/api/account/fal-key").json() == {"configured": False, "hint": ""}

        with app.state.testing_session() as db:
            row = db.get(FalCredential, alice["id"])
            assert row is not None
            assert secret not in row.ciphertext
            assert decrypt_fal_key(alice["id"], row.ciphertext) == secret
            assert db.get(FalCredential, bob["id"]) is None

        deleted_other = bob_client.delete(
            "/api/account/fal-key",
            headers=csrf_headers(bob_client),
        )
        assert deleted_other.status_code == 200
        assert alice_client.get("/api/account/fal-key").json()["configured"] is True

        deleted = alice_client.delete(
            "/api/account/fal-key",
            headers=csrf_headers(alice_client),
        )
        assert deleted.status_code == 200
        assert deleted.json() == {"configured": False, "hint": ""}
        assert alice_client.get("/api/account/fal-key").json() == {"configured": False, "hint": ""}
