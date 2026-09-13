"""SQLAlchemy engine and request-session helpers for the social subsystem."""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker


DEFAULT_DATABASE_URL = "sqlite:///./data/echo.db"
DATABASE_URL = os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)
EXPECTED_SCHEMA_REVISION = "20260913_0006"

if DATABASE_URL.startswith("sqlite"):
    database_path = DATABASE_URL.removeprefix("sqlite:///")
    if database_path and database_path != ":memory:":
        Path(database_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

engine_options: dict = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {"check_same_thread": False, "timeout": 30}

engine = create_engine(DATABASE_URL, **engine_options)


if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _configure_sqlite(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_database() -> None:
    """Validate that the explicitly managed Alembic schema is installed."""
    required = {
        "users",
        "auth_sessions",
        "posts",
        "password_reset_tokens",
        "rate_limit_events",
        "user_blocks",
        "reports",
        "conversations",
        "conversation_members",
        "direct_messages",
        "message_events",
        "recommendation_sessions",
        "recommendation_requests",
        "recommendation_impressions",
        "recommendation_dismissals",
        "actor_item_affinities",
        "actor_creator_affinities",
        "actor_tag_affinities",
        "post_recommendation_stats",
        "co_watch_pairs",
        "item_similarities",
        "credit_accounts",
        "credit_ledger_entries",
        "billing_quotes",
        "cloud_generation_billings",
        "cloud_generation_stages",
        "stripe_purchases",
        "stripe_events",
        "fal_credentials",
        "reel_reward_claims",
        "alembic_version",
    }
    existing = set(inspect(engine).get_table_names())
    missing = required - existing
    if missing:
        raise RuntimeError(
            "Social database migrations are required before startup. "
            "Run 'make migrate'. Missing tables: " + ", ".join(sorted(missing))
        )
    with engine.connect() as connection:
        installed = {
            row[0]
            for row in connection.execute(text("SELECT version_num FROM alembic_version"))
        }
    if EXPECTED_SCHEMA_REVISION not in installed:
        raise RuntimeError(
            f"Social database schema is not current. Run 'make migrate' (expected {EXPECTED_SCHEMA_REVISION})."
        )
