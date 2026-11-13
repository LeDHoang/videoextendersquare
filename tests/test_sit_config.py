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


SIT_DIR = ROOT / "deploy/sit"
RUNBOOK = ROOT / "docs/sit-runbook.md"
SIT_SECRETS = ("VPS_HOST", "VPS_KNOWN_HOSTS", "VPS_SIT_USER", "VPS_SIT_SSH_KEY",
               "SIT_PROBE_EMAIL", "SIT_PROBE_PEER", "SIT_PROBE_PASSWORD")


def test_delegate_conf_delegates_cpu_io_memory():
    text = (SIT_DIR / "delegate.conf").read_text()
    assert "[Service]" in text
    assert "Delegate=cpu cpuset io memory pids" in text


def test_slice_limits_match_spec():
    sit = (SIT_DIR / "echosit-slice.conf").read_text()
    for line in ("CPUWeight=10", "CPUQuota=200%", "MemoryHigh=2.5G", "MemoryMax=3G"):
        assert line in sit, line
    assert "CPUWeight=20" in (SIT_DIR / "user-slice.conf").read_text()


def test_nft_rule_blocks_echosit_from_prod():
    text = (SIT_DIR / "echosit.nft").read_text()
    # echosit's uid and its whole subuid range: a process in a user namespace
    # can setuid to a subuid while staying in the host network namespace.
    assert "define echosit_uids = { @ECHOSIT_UID@, @ECHOSIT_SUBUIDS@ }" in text
    rules = [line for line in text.splitlines() if "reject" in line and not line.lstrip().startswith("#")]
    assert len(rules) == 2 and all("meta skuid $echosit_uids" in rule for rule in rules)
    for needed in ("127.0.0.1", "8000", "8080", "172.16.0.0/12"):
        assert needed in text, needed
    # SIT's own readiness poll and proxy must stay reachable.
    assert "8001" not in text and "8081" not in text


def test_sit_runbook_covers_setup_isolation_and_promotion():
    text = RUNBOOK.read_text()
    for needed in ("loginctl enable-linger echosit", "50-sit-priority.conf",
                   "127.0.0.1:8000", "127.0.0.1:8001", "git push origin <sha>:main",
                   "ssh -L 8025:127.0.0.1:8025", "environment set to `production`", *SIT_SECRETS):
        assert needed in text, needed


def test_user_manager_needs_the_nft_guard():
    # Fail closed: echosit's user manager, and its Docker daemon, never start
    # without the guard table in place.
    text = (SIT_DIR / "user-at-nft.conf").read_text()
    assert "[Unit]" in text
    assert "Requires=echosit-nft.service" in text and "After=echosit-nft.service" in text


def test_sit_runbook_closes_the_isolation_gaps():
    text = RUNBOOK.read_text()
    for needed in (
        "/etc/cron.deny", "/etc/at.deny",                  # cron and at run outside the slice
        "/dev/tcp/<prod-pg-ip>/5432",                      # prod Postgres on its bridge IP
        "setpriv",                                         # the subuid bypass must fail
        "@ECHOSIT_SUBUIDS@", "user-at-nft.conf",
        "read-only deploy key", "git fetch origin dev",
        "show \"origin/dev:deploy/sit/",                   # files come from dev before promotion
        "apt-get -s", "nftables",                          # no surprise docker-ce upgrade
        "/opt/echo/.env*", "AllowUsers",
        "50-sit-priority.conf",
    ):
        assert needed in text, needed
    assert "systemctl revert user.slice" not in text      # it removes more than SIT added
    assert "10.0.2.2" not in text                          # that check proves nothing


def test_sit_env_keeps_the_sentry_read_token_off_by_default():
    text = ENV_SIT.read_text()
    assert _env()["SENTRY_AUTH_TOKEN"] == ""
    assert "prod's issues" in text
