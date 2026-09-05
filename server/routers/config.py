"""Config router — FAL_KEY and model endpoint settings."""

import os
from fastapi import APIRouter
from pydantic import BaseModel

from core import models as _models

router = APIRouter(prefix="/api/config", tags=["config"])

# In-memory model endpoints config. The static catalogs (labels + pricing)
# live in core/models.py — this dict holds only the user-editable overrides.
DEFAULT_MODELS = {
    "outpaint_img": _models.IMAGE_MODELS["outpaint_img"],
    "upscale_img": _models.IMAGE_MODELS["upscale_img"],
    "outpaint_vid": _models.DEFAULT_VIDEO_MODELS["outpaint_vid"],
    "upscale_vid": _models.DEFAULT_VIDEO_MODELS["upscale_vid"],
}

_model_config = dict(DEFAULT_MODELS)


class FalKeyUpdate(BaseModel):
    fal_key: str


class ModelsUpdate(BaseModel):
    outpaint_img: str | None = None
    upscale_img: str | None = None
    outpaint_vid: str | None = None
    upscale_vid: str | None = None


@router.get("")
def get_config():
    """Return current configuration state (masked FAL key, model overrides,
    and the full model/pricing catalog the frontend renders from)."""
    key = os.environ.get("FAL_KEY", "")
    masked = f"****{key[-4:]}" if len(key) >= 4 else ("set" if key else "")
    return {
        "fal_key_set": bool(key),
        "fal_key_masked": masked,
        "models": _models.config_payload(_model_config),
    }


@router.put("/fal-key")
def set_fal_key(body: FalKeyUpdate):
    """Set or update FAL_KEY in environment."""
    key = body.fal_key.strip()
    if key:
        os.environ["FAL_KEY"] = key
    elif "FAL_KEY" in os.environ:
        del os.environ["FAL_KEY"]

    masked = f"****{key[-4:]}" if len(key) >= 4 else ("set" if key else "")
    return {"status": "ok", "fal_key_set": bool(key), "fal_key_masked": masked}


@router.put("/models")
def update_models(body: ModelsUpdate):
    """Update model endpoint overrides.

    A non-empty value sets a custom endpoint (unknown ids surface as
    ``CUSTOM(...)`` options in the extenders). URLs are normalized to bare
    ids on save. An empty string resets that slot back to its stock default.
    """
    updates = body.model_dump(exclude_unset=True)
    for k, v in updates.items():
        if k not in _model_config:
            continue
        norm = _models.normalize_model_id(v or "")
        _model_config[k] = norm or DEFAULT_MODELS[k]
    return {"status": "ok", "models": _models.config_payload(_model_config)}