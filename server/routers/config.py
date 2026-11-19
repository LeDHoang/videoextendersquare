"""Read-only platform-key status and administrator-only model settings."""

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core import models as _models
from server import kill_switch
from server import media as SM
from server.billing.parameters import CATALOG_DEFAULTS, MODEL_OVERRIDES_KEY, model_defaults
from server.features import reel_pack_features, spatial_default_enabled, stereo_convert_enabled
from server.social.auth import AuthContext, require_admin_csrf, validate_origin
from server.social.database import get_db
from server.social.models import AppSetting, utcnow
from server.social.turnstile import turnstile_site_key

router = APIRouter(prefix="/api/config", tags=["config"])

# The static catalogs (labels + pricing) live in core/models.py. The
# administrator's model overrides are stored in app_settings, so they survive
# a restart; billing/parameters.py model_defaults() resolves them.
DEFAULT_MODELS = CATALOG_DEFAULTS


class ModelsUpdate(BaseModel):
    outpaint_img: str | None = None
    upscale_img: str | None = None
    outpaint_vid: str | None = None
    upscale_vid: str | None = None


@router.get("")
def get_config(db: Session = Depends(get_db)):
    """Return the model/pricing catalog the frontend renders from.

    The platform Fal key is server-owned and never exposed here — not even
    masked. Operators confirm it via server logs / Stripe dashboard instead.
    """
    return {
        "models": _models.config_payload(model_defaults(db)),
        "features": {
            "reel_packs": reel_pack_features(),
            "stereo_convert": stereo_convert_enabled(),
            "spatial_default": spatial_default_enabled(),
        },
        # The kill switches, so the SPA can say why a job button is off.
        "processing": kill_switch.state(db),
        # Public by design; the SPA renders the Turnstile widget with it. Empty = no challenge.
        "turnstile_site_key": turnstile_site_key(),
        "upload_limits": {
            "image_mb": SM.max_image_upload_bytes() // SM._MB,
            "video_mb": SM.max_video_upload_bytes() // SM._MB,
        },
    }


@router.put("/models")
def update_models(
    body: ModelsUpdate,
    request: Request,
    context: AuthContext = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    """Update model endpoint overrides.

    A non-empty value sets a custom endpoint (unknown ids surface as
    ``CUSTOM(...)`` options in the extenders). URLs are normalized to bare
    ids on save. An empty string resets that slot back to its stock default.
    """
    validate_origin(request)
    updates = body.model_dump(exclude_unset=True)
    current = model_defaults(db)
    for k, v in updates.items():
        if k not in current:
            continue
        norm = _models.normalize_model_id(v or "")
        current[k] = norm or DEFAULT_MODELS[k]
    # Only real overrides, so a later catalog default is not pinned by a stored copy.
    overrides = {k: v for k, v in current.items() if v != DEFAULT_MODELS[k]}
    row = db.get(AppSetting, MODEL_OVERRIDES_KEY)
    if row is None:
        db.add(AppSetting(key=MODEL_OVERRIDES_KEY, value=overrides, updated_by=context.user.id))
    else:
        row.value = overrides
        row.updated_by = context.user.id
        row.updated_at = utcnow()
    db.commit()
    return {"status": "ok", "models": _models.config_payload(current)}
