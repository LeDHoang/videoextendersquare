"""Reward claims for qualified reel viewing."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from server import trust
from server.billing.service import (
    BillingError,
    RewardError,
    claim_reel_reward,
    flag_enabled,
    reel_reward_status,
    require_billing_secrets,
)
from server.settings import env_int
from server.social.auth import AuthContext, keyed_hash, request_identity, require_auth, require_auth_csrf, validate_origin
from server.social.database import get_db

router = APIRouter(prefix="/api/rewards", tags=["rewards"])


class ReelClaimRequest(BaseModel):
    post_id: str = Field(min_length=1, max_length=36)
    recommendation_impression_id: str = Field(min_length=1, max_length=36)


def _account_too_new(context: AuthContext) -> int | None:
    """The minimum account age in hours when this account is still too new to earn, else None."""
    min_age_hours = env_int("SX_REEL_REWARD_MIN_ACCOUNT_AGE_HOURS", 72, minimum=0)
    return min_age_hours if trust.account_age(context.user) < timedelta(hours=min_age_hours) else None


@router.get("/reels/status")
def reel_status(context: AuthContext = Depends(require_auth), db: Session = Depends(get_db)):
    # Accounts that cannot earn yet see no progress they could never complete.
    if not flag_enabled("SX_REEL_REWARDS_ENABLED") or _account_too_new(context) is not None:
        return {"enabled": False}
    return {"enabled": True, **reel_reward_status(db, context.user.id)}


@router.post("/reels/claim")
def claim_reel(
    body: ReelClaimRequest,
    request: Request,
    context: AuthContext = Depends(require_auth_csrf),
    db: Session = Depends(get_db),
):
    validate_origin(request)
    if not flag_enabled("SX_REEL_REWARDS_ENABLED"):
        raise HTTPException(status_code=503, detail={"code": "REWARDS_DISABLED", "message": "Reel rewards are disabled."})
    min_age_hours = _account_too_new(context)
    if min_age_hours is not None:
        raise HTTPException(status_code=422, detail={
            "code": "REWARD_INELIGIBLE",
            "reason": "account_too_new",
            "message": f"New accounts can earn reel rewards after {min_age_hours} hours.",
        })
    ip_hash = keyed_hash("reel-reward:" + request_identity(request))
    try:
        require_billing_secrets()
        return claim_reel_reward(
            db,
            user_id=context.user.id,
            post_id=body.post_id,
            impression_id=body.recommendation_impression_id,
            ip_hash=ip_hash,
        )
    except RewardError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": exc.code, "reason": exc.reason, "message": str(exc)}) from exc
    except BillingError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)}) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": "REWARD_ALREADY_CLAIMED", "message": "This reel has already been claimed."}) from exc
    except OperationalError as exc:
        # SQLite write contention, not a duplicate claim — retryable.
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": "REWARD_RETRYABLE", "message": "Reward service is busy. Try again shortly."}) from exc
