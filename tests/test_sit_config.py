"""SIT environment files: compose override, env template, host config, runbook."""
from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parent.parent
COMPOSE_SIT = ROOT / "deploy/compose.sit.yaml"
ENV_SIT = ROOT / "deploy/env.sit.example"


def _services() -> dict:
    return yaml.safe_load(COMPOSE_SIT.read_text())["services"]


def _env() -> dict[str, str]:
    values = {}
    for line in ENV_SIT.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key] = value
    return values


def test_every_sit_service_is_oom_preferred():
    services = _services()
    for name in ("app", "app-read", "proxy", "postgres", "cloudflared", "mailpit"):
        assert services[name]["oom_score_adj"] == 500, name


def test_sit_memory_caps():
    services = _services()
    assert services["postgres"]["mem_limit"] == "512m"
    assert services["app-read"]["mem_limit"] == "512m"
    assert services["proxy"]["mem_limit"] == "128m"
    assert services["cloudflared"]["mem_limit"] == "128m"
    assert services["mailpit"]["mem_limit"] == "64m"
    assert "mem_limit" not in services["app"]


def test_mailpit_ui_is_loopback_only():
    ports = _services()["mailpit"]["ports"]
    assert ports and all(str(port).startswith("127.0.0.1:") for port in ports)


def test_sit_env_pins_spec_values():
    env = _env()
    expected = {
        "SX_ENV": "production",
        "SENTRY_ENVIRONMENT": "sit",
        "COMPOSE_FILE": "compose.yaml:deploy/compose.sit.yaml",
        "SX_APP_PORT": "8001",
        "SX_PROXY_PORT": "8081",
        "SX_PUBLIC_URL": "https://sit.echomultiverse.com",
        "SX_PUBLIC_BASE_URL": "https://sit.echomultiverse.com",
        "SX_MEDIA_BASE_URL": "https://sit-media.echomultiverse.com",
        "FAL_KEY": "",
        "SX_STRIPE_ENABLED": "0",
        "SX_PUBLISH_HOURLY_MAX": "60",
        "SX_PUBLISH_DAILY_MAX": "200",
        "SX_READ_WORKERS": "1",
        "SX_FFMPEG_NICE": "19",
        "SX_DISK_MIN_FREE_GB": "10",
        "SX_SMTP_HOST": "mailpit",
        "SX_SMTP_PORT": "1025",
    }
    for key, value in expected.items():
        assert env.get(key) == value, key
    assert "R2_LOG_BUCKET" not in env


def test_sit_files_hold_no_known_password():
    for path in (COMPOSE_SIT, ENV_SIT):
        assert "staging-only-password-1" not in path.read_text()


def test_sit_env_passes_production_boot_checks(monkeypatch):
    for key, value in _env().items():
        monkeypatch.setenv(key, re.sub(r"<[^>]*>", "x" * 64, value))
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://u:p@postgres/echo")
    monkeypatch.delenv("SX_LOGIN_RATE_LIMIT", raising=False)
    with patch("dotenv.load_dotenv"):
        from server import settings
    assert settings.production_config_errors() == []
