"""Shared pytest fixtures.

Routes take their session from ``get_db`` (which tests override), but helpers
called without a ``db`` fall back to the module-level ``SessionLocal``. Point
that fallback at an empty throwaway database so no test reads or writes the
developer's ``data/echo.db``. A test that needs the fallback on its own
database still monkeypatches ``SessionLocal`` itself (the later patch wins).
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.social import database, safety


@pytest.fixture(scope="session")
def _fallback_session_factory(tmp_path_factory):
    engine = create_engine(
        "sqlite:///" + str(tmp_path_factory.mktemp("fallback-db") / "fallback.db"),
        connect_args={"check_same_thread": False},
    )
    database.Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()


@pytest.fixture(autouse=True)
def _isolate_global_session_local(monkeypatch, _fallback_session_factory):
    monkeypatch.setattr(database, "SessionLocal", _fallback_session_factory)
    monkeypatch.setattr(safety, "SessionLocal", _fallback_session_factory)
