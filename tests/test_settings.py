from server import settings


GOOD_ENV = {
    "SX_ENV": "production",
    "SX_SECURITY_SECRET": "s" * 40,
    "SX_MESSAGE_ENCRYPTION_KEY": "m" * 40,
    "SX_FAL_KEY_ENCRYPTION_KEY": "f" * 40,
    "SX_COOKIE_SECURE": "1",
    "SX_TRUST_PROXY_HEADERS": "1",
    "SX_PUBLIC_URL": "https://app.example.com",
    "DATABASE_URL": "postgresql+psycopg://echo:pw@postgres:5432/echo",
    "SX_MEDIA_BASE_URL": "https://media.example.com/",
    "R2_ACCOUNT_ID": "acct",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_PUBLIC_BUCKET": "media",
}


def _apply(monkeypatch, env):
    for name in list(GOOD_ENV) + ["SX_DEV_ORIGINS"]:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)


def test_dev_mode_has_no_errors(monkeypatch):
    _apply(monkeypatch, {})
    assert not settings.is_production()
    assert settings.production_config_errors() == []


def test_complete_production_config_passes(monkeypatch):
    _apply(monkeypatch, GOOD_ENV)
    assert settings.is_production()
    assert settings.production_config_errors() == []


def test_empty_production_config_lists_every_problem(monkeypatch):
    _apply(monkeypatch, {"SX_ENV": "production"})
    errors = "\n".join(settings.production_config_errors())
    for name in (
        "SX_SECURITY_SECRET",
        "SX_MESSAGE_ENCRYPTION_KEY",
        "SX_FAL_KEY_ENCRYPTION_KEY",
        "SX_COOKIE_SECURE",
        "SX_TRUST_PROXY_HEADERS",
        "SX_PUBLIC_URL",
        "DATABASE_URL",
        "SX_MEDIA_BASE_URL",
        "R2_PUBLIC_BUCKET",
    ):
        assert name in errors


def test_rejects_dev_secret_short_secret_and_sqlite(monkeypatch):
    _apply(
        monkeypatch,
        {
            **GOOD_ENV,
            "SX_SECURITY_SECRET": settings.DEV_SECURITY_SECRET,
            "SX_MESSAGE_ENCRYPTION_KEY": "short",
            "DATABASE_URL": "sqlite:///data/echo.db",
            "SX_PUBLIC_URL": "http://app.example.com",
        },
    )
    errors = "\n".join(settings.production_config_errors())
    assert "SX_SECURITY_SECRET uses the development default" in errors
    assert "SX_MESSAGE_ENCRYPTION_KEY must be at least" in errors
    assert "DATABASE_URL" in errors
    assert "SX_PUBLIC_URL" in errors


def test_rejects_local_dev_origins(monkeypatch):
    _apply(monkeypatch, {**GOOD_ENV, "SX_DEV_ORIGINS": "https://app.example.com,http://localhost:5173"})
    errors = settings.production_config_errors()
    assert len(errors) == 1 and "localhost" in errors[0]


def test_env_int_falls_back_and_clamps(monkeypatch):
    monkeypatch.setenv("SX_TEST_INT", "nope")
    assert settings.env_int("SX_TEST_INT", 7) == 7
    monkeypatch.setenv("SX_TEST_INT", "-3")
    assert settings.env_int("SX_TEST_INT", 7, minimum=1) == 1
