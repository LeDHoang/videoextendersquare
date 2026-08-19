"""Config router — FAL_KEY and model endpoint settings."""

import os
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/config", tags=["config"])

# In-memory model endpoints config
DEFAULT_MODELS = {
    "outpaint_img": "fal-ai/flux/outpaint",
    "upscale_img": "fal-ai/clarity-upscaler",
    "outpaint_vid": "fal-ai/ltx-2.3-quality/outpaint",
    "upscale_vid": "fal-ai/seedvr/upscale/video",
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
    """Return current configuration state (masked FAL key & model endpoints)."""
    key = os.environ.get("FAL_KEY", "")
    masked = f"****{key[-4:]}" if len(key) >= 4 else ("set" if key else "")
    return {
        "fal_key_set": bool(key),
        "fal_key_masked": masked,
        "models": _model_config,
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
    """Update model endpoint overrides."""
    updates = body.model_dump(exclude_unset=True)
    for k, v in updates.items():
        if v and k in _model_config:
            _model_config[k] = v.strip()
    return {"status": "ok", "models": _model_config}
