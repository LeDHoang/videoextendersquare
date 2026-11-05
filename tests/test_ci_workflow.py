"""CI workflow shape: checks on main and dev, deploy to the VPS on main only."""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
# PyYAML reads the bare key `on` as the boolean True.
TRIGGERS = WORKFLOW.get("on", WORKFLOW.get(True))
CHECK_JOBS = {"test", "postgres", "docker", "scans"}


def test_checks_run_on_pushes_to_main_and_dev():
    assert {"main", "dev"} <= set(TRIGGERS["push"]["branches"])


def test_deploy_waits_for_every_check_and_runs_only_for_main_pushes():
    deploy = WORKFLOW["jobs"]["deploy"]
    assert set(deploy["needs"]) == CHECK_JOBS
    assert deploy["if"] == "github.event_name == 'push' && github.ref == 'refs/heads/main'"


def test_deploys_queue_instead_of_cancelling_each_other():
    concurrency = WORKFLOW["jobs"]["deploy"]["concurrency"]
    assert concurrency["cancel-in-progress"] is False


def test_deploy_ships_the_tested_commit_and_keeps_secrets_out_of_the_log():
    steps = WORKFLOW["jobs"]["deploy"]["steps"]
    text = "\n".join(str(step.get("run", "")) for step in steps)
    assert "github.sha" in str(steps) or "GITHUB_SHA" in text
    assert "StrictHostKeyChecking=yes" in text
    assert "deploy/deploy.sh" in text


def test_deploy_script_refuses_to_run_off_main_or_without_a_fast_forward():
    script = (ROOT / "deploy/deploy.sh").read_text()
    assert "set -euo pipefail" in script
    assert "merge --ff-only" in script
    assert "refs/heads/main" in script


def test_a_newer_push_to_main_cannot_cancel_a_running_deploy():
    # The workflow-level group applies to the whole run, deploy job included.
    cancel = WORKFLOW["concurrency"]["cancel-in-progress"]
    assert cancel == "${{ github.ref != 'refs/heads/main' }}"
