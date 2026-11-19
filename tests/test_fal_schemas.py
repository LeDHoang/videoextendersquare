"""Live fal input schemas (server/fal_schemas.py) limit the credit catalog's options.

fal is never called: fetch_schema is replaced with small hand-made OpenAPI documents.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core import models
from core.pricing import PricingError, quote_video
from server import fal_schemas
from server.social.database import Base
from server.social.models import AppSetting

LTX = "fal-ai/ltx-2.3-quality/outpaint"
BYTEDANCE = "fal-ai/bytedance-upscaler/upscale/video"
SEEDVR = "fal-ai/seedvr/upscale/video"

# What fal accepts today for the fields the catalog maps (see "fal_fields").
FIELDS = {
    LTX: {
        "output_resolution": {"enum": ["480p", "720p", "1080p"]},
        "num_frames": {"type": "integer", "minimum": 9, "maximum": 481},
    },
    LTX + "/lora": {
        "output_resolution": {"enum": ["480p", "720p", "1080p"]},
        "num_frames": {"type": "integer", "minimum": 9, "maximum": 481},
    },
    "luma/agent/ray/v3.2/reframe": {
        "resolution": {"enum": ["540p", "720p", "1080p"]},
        "aspect_ratio": {"enum": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]},
    },
    "fal-ai/wan-vace-14b/outpainting": {
        "resolution": {"enum": ["auto", "240p", "360p", "480p", "580p", "720p"]},
        "aspect_ratio": {"enum": ["auto", "16:9", "1:1", "9:16"]},
        "num_frames": {"type": "integer", "minimum": 17, "maximum": 241},
    },
    BYTEDANCE: {
        "target_resolution": {"enum": ["1080p", "2k", "4k", "6k", "8k"]},
        "target_fps": {"type": "integer", "minimum": 24, "maximum": 120},
        "enhancement_tier": {"enum": ["fast", "standard", "pro"]},
    },
    SEEDVR: {"target_resolution": {"enum": ["720p", "1080p", "1440p", "2160p"]}},
}


def openapi(model_id: str, properties: dict) -> dict:
    """A minimal fal queue OpenAPI document with the input behind a $ref, as fal serves it."""
    return {
        "paths": {
            f"/{model_id}": {
                "post": {
                    "requestBody": {
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Input"}}}
                    }
                }
            },
            f"/{model_id}/requests/{{request_id}}": {"get": {}},
        },
        "components": {
            "schemas": {
                "Input": {
                    "type": "object",
                    "properties": {"prompt": {"type": "string"}, **properties},
                    "required": ["video_url"],
                }
            }
        },
    }


def serve(monkeypatch, **changes):
    """fal answers with FIELDS; changes maps a model id to a field patch (a None field is removed)."""
    def fetch(model_id):
        fields = dict(FIELDS.get(model_id, {}))
        for name, value in changes.get(model_id, {}).items():
            if value is None:
                fields.pop(name, None)
            else:
                fields[name] = value
        return openapi(model_id, fields)

    monkeypatch.setattr(fal_schemas, "fetch_schema", fetch)


@pytest.fixture
def db(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "fal-schemas.db"))
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        yield session
    engine.dispose()


@pytest.fixture
def alerts(monkeypatch):
    sent: list[list[str]] = []
    monkeypatch.setattr(fal_schemas, "_alert", lambda fingerprint, message: sent.append(fingerprint))
    return sent


def entry(model_id: str) -> dict:
    return next(e for catalog in (models.VIDEO_OUTPAINT, models.VIDEO_UPSCALE) for e in catalog if e["model"] == model_id)


def ltx_quote(resolution=None, duration=5.0):
    params = {"outpaint_model": LTX, **({"ltx_resolution": resolution} if resolution else {})}
    return quote_video(width=1080, height=1920, duration=duration, params=params)


def seedvr_quote(target):
    return quote_video(
        width=1080, height=1080, duration=2.0, source_fps=24, source_frames=48,
        params={"upscale_only": True, "upscale_engine": "fal", "upscale_model": SEEDVR, "seedvr_target": target},
    )


def test_the_snapshot_resolves_refs_and_ignores_order():
    document = openapi(LTX, {"mode": {"$ref": "#/components/schemas/Mode"}, "fps": {"anyOf": [{"type": "integer", "minimum": 1, "maximum": 60}, {"type": "null"}]}})
    document["components"]["schemas"]["Mode"] = {"allOf": [{"enum": ["b", "a", None]}]}
    reordered = openapi(LTX, {"fps": {"anyOf": [{"type": "integer", "minimum": 1, "maximum": 60}]}, "mode": {"enum": ["a", "b"]}})
    snapshot = fal_schemas.input_snapshot(document)
    assert snapshot == {
        "required": ["video_url"],
        "fields": {"prompt": {}, "mode": {"enum": ["a", "b"]}, "fps": {"minimum": 1, "maximum": 60}},
    }
    assert fal_schemas.input_snapshot(reordered) == snapshot


def test_the_first_sync_is_a_silent_baseline_and_changes_nothing(db, alerts, monkeypatch):
    before = [dict(e) for e in models.VIDEO_OUTPAINT + models.VIDEO_UPSCALE]
    serve(monkeypatch)
    assert fal_schemas.sync(db) == []
    assert alerts == []
    assert set(db.get(AppSetting, fal_schemas.SETTING_KEY).value) == {e["model"] for e in models.synced_entries()}
    after = models.VIDEO_OUTPAINT + models.VIDEO_UPSCALE
    for old, new in zip(before, after):
        assert {k: v for k, v in new.items()} == old


def test_a_new_fal_option_alerts_once_and_is_not_offered(db, alerts, monkeypatch):
    serve(monkeypatch)
    fal_schemas.sync(db)
    serve(monkeypatch, **{BYTEDANCE: {"target_resolution": {"enum": ["1080p", "2k", "4k", "6k", "8k", "16k"]}}})
    assert fal_schemas.sync(db) == [BYTEDANCE]
    assert len(alerts) == 1 and alerts[0][0] == BYTEDANCE
    assert "16k" not in entry(BYTEDANCE)["base_rates_usd"]
    # The same schema again is not a new change, and a reorder is no change at all.
    assert fal_schemas.sync(db) == []
    serve(monkeypatch, **{BYTEDANCE: {"target_resolution": {"enum": ["16k", "8k", "6k", "4k", "2k", "1080p"]}}})
    assert fal_schemas.sync(db) == []
    assert len(alerts) == 1


def test_an_option_fal_dropped_is_withdrawn_and_alerts(db, alerts, monkeypatch):
    serve(monkeypatch)
    fal_schemas.sync(db)
    assert ltx_quote("720p")["stages"][0]["details"]["resolution"] == "720p"
    serve(monkeypatch, **{LTX: {"output_resolution": {"enum": ["480p", "1080p"]}}})
    assert fal_schemas.sync(db) == [LTX]
    assert [LTX, "unsupported"] == alerts[-1][:2]
    assert len(alerts) == 2  # the change, and the withdrawn option
    ltx = entry(LTX)
    assert list(ltx["resolutions"]) == ["480p", "1080p"]
    assert ltx["constraints"]["resolutions"] == ["480p", "1080p"]
    assert ltx["default_resolution"] == "480p"
    with pytest.raises(PricingError, match="Unsupported LTX resolution: 720p"):
        ltx_quote("720p")
    assert ltx_quote()["stages"][0]["details"]["resolution"] == "480p"
    # The LoRA variant is its own fal endpoint and keeps its options.
    assert list(entry(LTX + "/lora")["resolutions"]) == ["480p", "720p", "1080p"]

    # Code options come back when fal's schemas are cleared.
    models.apply_fal_schemas({})
    assert ltx_quote("720p")["stages"][0]["details"]["resolution"] == "720p"


def test_frame_limits_follow_fal(db, alerts, monkeypatch):
    serve(monkeypatch, **{LTX: {"num_frames": {"type": "integer", "minimum": 9, "maximum": 241}}})
    fal_schemas.sync(db)
    assert models.frame_limits(LTX, (0, 0)) == (9, 241)
    assert ltx_quote(duration=10.0)["stages"][0]["details"]["frames"] == 241
    with pytest.raises(PricingError, match="at most 10.00s"):
        ltx_quote(duration=12.0)


def test_a_failed_fetch_keeps_the_last_schemas(db, alerts, monkeypatch):
    serve(monkeypatch, **{LTX: {"output_resolution": {"enum": ["480p", "1080p"]}}})
    fal_schemas.sync(db)
    stored = db.get(AppSetting, fal_schemas.SETTING_KEY).value

    def down(model_id):
        raise OSError("fal is down")

    monkeypatch.setattr(fal_schemas, "fetch_schema", down)
    assert fal_schemas.sync(db) == []
    assert alerts[-1] == ["sync-failed"]
    db.expire_all()
    assert db.get(AppSetting, fal_schemas.SETTING_KEY).value == stored
    assert list(entry(LTX)["resolutions"]) == ["480p", "1080p"]


def test_stored_schemas_apply_at_startup(db, alerts, monkeypatch):
    serve(monkeypatch, **{LTX: {"output_resolution": {"enum": ["480p", "1080p"]}}})
    fal_schemas.sync(db)
    models.apply_fal_schemas({})
    assert "720p" in entry(LTX)["resolutions"]
    fal_schemas.load(db)
    assert "720p" not in entry(LTX)["resolutions"]


def test_seedvr_prices_1440p_and_rejects_unknown_targets():
    # 1440p was offered by the upload page but priced as 1080p.
    assert Decimal(seedvr_quote("1440p")["stages"][0]["provider_cost_usd"]) > Decimal(seedvr_quote("1080p")["stages"][0]["provider_cost_usd"])
    with pytest.raises(PricingError, match="Unsupported SeedVR resolution: 4320p"):
        seedvr_quote("4320p")
