"""Reward claims for qualified reel viewing."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from server.billing.service import RewardError, claim_reel_reward, flag_enabled
from server.social.auth import AuthContext, keyed_hash, request_identity, require_auth_csrf, validate_origin
from server.social.database import get_db

router = APIRouter(prefix="/api/rewards", tags=["rewards"])


class ReelClaimRequest(BaseModel):
    post_id: str = Field(min_length=1, max_length=36)
    recommendation_impression_id: str = Field(min_length=1, max_length=36)


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
    ip_hash = keyed_hash("reel-reward:" + request_identity(request))
    try:
        return claim_reel_reward(
            db,
            user_id=context.user.id,
            post_id=body.post_id,
            impression_id=body.recommendation_impression_id,
            ip_hash=ip_hash,
        )
    except RewardError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": "REWARD_ALREADY_CLAIMED", "message": "This reel has already been claimed."}) from exc
