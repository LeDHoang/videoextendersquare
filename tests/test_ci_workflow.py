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
    assert "grep -q '^deployed ' deploy.log" in text


def test_deploy_script_refuses_to_run_off_main_or_without_a_fast_forward():
    script = (ROOT / "deploy/deploy.sh").read_text()
    assert "set -euo pipefail" in script
    assert "merge --ff-only" in script
    assert "refs/heads/main" in script


def test_a_newer_push_to_main_cannot_cancel_a_running_deploy():
    # The workflow-level group applies to the whole run, deploy job included.
    cancel = WORKFLOW["concurrency"]["cancel-in-progress"]
    assert cancel == "${{ github.ref != 'refs/heads/main' }}"


def test_deploy_script_runs_to_the_end_when_a_command_reads_stdin(tmp_path):
    # CI streams the script over SSH stdin (`bash -s`). `docker compose exec -T`
    # reads stdin too, and once swallowed the rest of the script: the deploy
    # stopped after the dump and still exited 0. Here every stub drains stdin.
    import os
    import subprocess

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls.log"
    calls.write_text("")
    stubs = {
        "docker": 'cat > /dev/null\necho "docker $*" >> "$CALLS"\n',
        "curl": "cat > /dev/null\n",
        "git": (
            "cat > /dev/null\n"
            'case "$*" in\n'
            '  "symbolic-ref -q HEAD") echo refs/heads/main ;;\n'
            "  rev-parse*) echo 0123456789abcdef ;;\n"
            "  diff*) exit 1 ;;\n"  # migrations/ changed, so the dump runs
            "esac\n"
        ),
    }
    for name, body in stubs.items():
        path = bin_dir / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(tmp_path),
           "ECHO_DIR": str(tmp_path), "CALLS": str(calls)}
    with open(ROOT / "deploy/deploy.sh", "rb") as script:
        result = subprocess.run(["bash", "-s", "--", "0123456789abcdef"], stdin=script, env=env,
                                capture_output=True, text=True, timeout=60)
    ran = calls.read_text()
    assert "migrations changed" in result.stdout
    assert "docker compose build" in ran
    assert "docker compose --profile tunnel up -d" in ran
    assert result.returncode == 0 and "deployed" in result.stdout
