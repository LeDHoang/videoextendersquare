"""Add ECHO credits, Fal billing, Stripe, credentials, and reel rewards.

Revision ID: 20260913_0006
Revises: 20260912_0005
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op


revision = "20260913_0006"
down_revision = "20260912_0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "credit_accounts",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("available_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reserved_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lifetime_purchased", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lifetime_earned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lifetime_spent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("reserved_balance >= 0", name="ck_credit_account_reserved_nonnegative"),
    )

    op.create_table(
        "credit_ledger_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("entry_type", sa.String(32), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("delta_available", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("delta_reserved", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("balance_available", sa.Integer(), nullable=False),
        sa.Column("balance_reserved", sa.Integer(), nullable=False),
        sa.Column("reference_type", sa.String(32), nullable=True),
        sa.Column("reference_id", sa.String(128), nullable=True),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("delta_available != 0 OR delta_reserved != 0", name="ck_credit_ledger_nonzero_delta"),
        sa.UniqueConstraint("idempotency_key", name="uq_credit_ledger_entries_idempotency_key"),
    )
    for name in ("user_id", "entry_type", "source", "reference_type", "reference_id", "idempotency_key", "created_at"):
        op.create_index(f"ix_credit_ledger_entries_{name}", "credit_ledger_entries", [name])

    op.create_table(
        "billing_quotes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("stage_id", sa.String(64), nullable=False),
        sa.Column("parameter_hash", sa.String(64), nullable=False),
        sa.Column("parameters", sa.JSON(), nullable=False),
        sa.Column("pricing_snapshot", sa.JSON(), nullable=False),
        sa.Column("provider_cost_microusd", sa.Integer(), nullable=False),
        sa.Column("credits", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("provider_cost_microusd >= 0", name="ck_billing_quote_cost_nonnegative"),
        sa.CheckConstraint("credits >= 0", name="ck_billing_quote_credits_nonnegative"),
    )
    for name in ("user_id", "kind", "stage_id", "status", "expires_at"):
        op.create_index(f"ix_billing_quotes_{name}", "billing_quotes", [name])
    op.create_index("ix_billing_quotes_user_status_expiry", "billing_quotes", ["user_id", "status", "expires_at"])

    op.create_table(
        "cloud_generation_billings",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("job_id", sa.String(32), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("quote_id", sa.String(36), sa.ForeignKey("billing_quotes.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("payment_source", sa.String(16), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="reserved"),
        sa.Column("reserved_credits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("captured_credits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_credits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("reserved_credits >= 0", name="ck_cloud_billing_reserved_nonnegative"),
        sa.CheckConstraint("captured_credits >= 0", name="ck_cloud_billing_captured_nonnegative"),
        sa.CheckConstraint("released_credits >= 0", name="ck_cloud_billing_released_nonnegative"),
        sa.UniqueConstraint("job_id", name="uq_cloud_generation_billings_job_id"),
        sa.UniqueConstraint("quote_id", name="uq_cloud_generation_billings_quote_id"),
    )
    for name in ("job_id", "user_id", "kind", "payment_source", "status"):
        op.create_index(f"ix_cloud_generation_billings_{name}", "cloud_generation_billings", [name])
    op.create_index("ix_cloud_generation_user_created", "cloud_generation_billings", ["user_id", "created_at"])

    op.create_table(
        "cloud_generation_stages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("billing_id", sa.String(36), sa.ForeignKey("cloud_generation_billings.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage_name", sa.String(24), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="reserved"),
        sa.Column("provider_cost_microusd", sa.Integer(), nullable=False),
        sa.Column("reserved_credits", sa.Integer(), nullable=False),
        sa.Column("captured_credits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_credits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fal_request_id", sa.String(160), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("reserved_credits >= 0", name="ck_cloud_stage_reserved_nonnegative"),
        sa.CheckConstraint("captured_credits >= 0", name="ck_cloud_stage_captured_nonnegative"),
        sa.CheckConstraint("released_credits >= 0", name="ck_cloud_stage_released_nonnegative"),
        sa.UniqueConstraint("billing_id", "sequence", name="uq_cloud_stage_billing_sequence"),
        sa.UniqueConstraint("fal_request_id", name="uq_cloud_generation_stages_fal_request_id"),
    )
    for name in ("billing_id", "status", "fal_request_id"):
        op.create_index(f"ix_cloud_generation_stages_{name}", "cloud_generation_stages", [name])

    op.create_table(
        "stripe_purchases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("pack_id", sa.String(32), nullable=False),
        sa.Column("stripe_price_id", sa.String(128), nullable=False),
        sa.Column("checkout_session_id", sa.String(128), nullable=False),
        sa.Column("payment_intent_id", sa.String(128), nullable=True),
        sa.Column("amount_total_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="usd"),
        sa.Column("credits", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="created"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fulfilled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("checkout_session_id", name="uq_stripe_purchases_checkout_session_id"),
        sa.UniqueConstraint("payment_intent_id", name="uq_stripe_purchases_payment_intent_id"),
    )
    for name in ("user_id", "checkout_session_id", "payment_intent_id", "status"):
        op.create_index(f"ix_stripe_purchases_{name}", "stripe_purchases", [name])

    op.create_table(
        "stripe_events",
        sa.Column("event_id", sa.String(128), primary_key=True),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="processing"),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_stripe_events_event_type", "stripe_events", ["event_type"])
    op.create_index("ix_stripe_events_status", "stripe_events", ["status"])

    op.create_table(
        "fal_credentials",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("key_hint", sa.String(16), nullable=False, server_default=""),
        sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "reel_reward_claims",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("post_id", sa.String(36), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("impression_id", sa.String(36), sa.ForeignKey("recommendation_impressions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("utc_date", sa.String(10), nullable=False),
        sa.Column("ip_hash", sa.String(64), nullable=False),
        sa.Column("media_type", sa.String(16), nullable=False),
        sa.Column("foreground_ms", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("awarded_credit", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "post_id", "utc_date", name="uq_reel_reward_user_post_day"),
    )
    for name in ("user_id", "post_id", "impression_id", "utc_date", "ip_hash"):
        op.create_index(f"ix_reel_reward_claims_{name}", "reel_reward_claims", [name])
    op.create_index("ix_reel_reward_user_day", "reel_reward_claims", ["user_id", "utc_date", "created_at"])
    op.create_index("ix_reel_reward_ip_day", "reel_reward_claims", ["ip_hash", "utc_date", "created_at"])


def downgrade():
    op.drop_table("reel_reward_claims")
    op.drop_table("fal_credentials")
    op.drop_table("stripe_events")
    op.drop_table("stripe_purchases")
    op.drop_table("cloud_generation_stages")
    op.drop_table("cloud_generation_billings")
    op.drop_table("billing_quotes")
    op.drop_table("credit_ledger_entries")
    op.drop_table("credit_accounts")
