"""Read-only platform-key status and administrator-only model settings."""

import os
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from core import models as _models
from server.social.auth import AuthContext, require_admin_csrf, validate_origin

router = APIRouter(prefix="/api/config", tags=["config"])

# In-memory model endpoints config. The static catalogs (labels + pricing)
# live in core/models.py — this dict holds only administrator-editable overrides.
DEFAULT_MODELS = {
    "outpaint_img": _models.IMAGE_MODELS["outpaint_img"],
    "upscale_img": _models.IMAGE_MODELS["upscale_img"],
    "outpaint_vid": _models.DEFAULT_VIDEO_MODELS["outpaint_vid"],
    "upscale_vid": _models.DEFAULT_VIDEO_MODELS["upscale_vid"],
}

_model_config = dict(DEFAULT_MODELS)


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


@router.put("/models")
def update_models(
    body: ModelsUpdate,
    request: Request,
    context: AuthContext = Depends(require_admin_csrf),
):
    """Update model endpoint overrides.

    A non-empty value sets a custom endpoint (unknown ids surface as
    ``CUSTOM(...)`` options in the extenders). URLs are normalized to bare
    ids on save. An empty string resets that slot back to its stock default.
    """
    validate_origin(request)
    updates = body.model_dump(exclude_unset=True)
    for k, v in updates.items():
        if k not in _model_config:
            continue
        norm = _models.normalize_model_id(v or "")
        _model_config[k] = norm or DEFAULT_MODELS[k]
    return {"status": "ok", "models": _models.config_payload(_model_config)}