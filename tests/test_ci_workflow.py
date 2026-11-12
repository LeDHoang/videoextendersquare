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
    assert 'refs/heads/$branch' in script and 'DEPLOY_BRANCH:-main' in script


def test_a_newer_push_to_main_cannot_cancel_a_running_deploy():
    # The workflow-level group applies to the whole run, deploy job included.
    cancel = WORKFLOW["concurrency"]["cancel-in-progress"]
    assert cancel == "${{ github.ref != 'refs/heads/main' }}"


def _run_deploy(tmp_path, *, head="refs/heads/main", env=None, dotenv=None, image_tags=""):
    """Run deploy.sh as CI does (streamed on stdin) against stub docker/git/curl.

    Returns the finished process and the log of stubbed calls."""
    import os
    import subprocess

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls.log"
    calls.write_text("")
    (tmp_path / "tags.txt").write_text(image_tags)
    if dotenv is not None:
        (tmp_path / ".env").write_text(dotenv)
    stubs = {
        "docker": (
            'cat > /dev/null\necho "docker $*" >> "$CALLS"\n'
            'case "$*" in "image ls"*) cat "$TAGS" ;; esac\n'
        ),
        "curl": 'cat > /dev/null\necho "curl $*" >> "$CALLS"\n',
        "git": (
            "cat > /dev/null\n"
            'echo "git $*" >> "$CALLS"\n'
            'case "$*" in\n'
            f'  "symbolic-ref -q HEAD") echo {head} ;;\n'
            "  rev-parse*) echo 0123456789abcdef ;;\n"
            "  diff*) exit 1 ;;\n"  # migrations/ changed, so the dump runs
            "esac\n"
        ),
    }
    for name, body in stubs.items():
        path = bin_dir / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    run_env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(tmp_path),
               "ECHO_DIR": str(tmp_path), "CALLS": str(calls), "TAGS": str(tmp_path / "tags.txt")}
    run_env.pop("DEPLOY_BRANCH", None)
    run_env.update(env or {})
    with open(ROOT / "deploy/deploy.sh", "rb") as script:
        result = subprocess.run(["bash", "-s", "--", "0123456789abcdef"], stdin=script, env=run_env,
                                capture_output=True, text=True, timeout=60)
    return result, calls.read_text()


def test_deploy_script_runs_to_the_end_when_a_command_reads_stdin(tmp_path):
    # CI streams the script over SSH stdin (`bash -s`). `docker compose exec -T`
    # reads stdin too, and once swallowed the rest of the script: the deploy
    # stopped after the dump and still exited 0. Here every stub drains stdin.
    result, ran = _run_deploy(tmp_path)
    assert "migrations changed" in result.stdout
    assert "docker compose build" in ran
    assert "docker compose --profile tunnel up -d" in ran
    assert result.returncode == 0 and "deployed" in result.stdout


def test_deploy_defaults_to_main_and_port_8000(tmp_path):
    result, ran = _run_deploy(tmp_path)
    assert result.returncode == 0
    assert "http://127.0.0.1:8000/api/readyz" in ran
    assert "git fetch --quiet origin main" in ran
    assert "docker image rm" not in ran


def test_deploy_branch_and_port_come_from_env_and_dotenv(tmp_path):
    result, ran = _run_deploy(tmp_path, head="refs/heads/dev", env={"DEPLOY_BRANCH": "dev"},
                              dotenv='SX_ENV=production\nSX_APP_PORT="8001"\n')
    assert result.returncode == 0, result.stderr
    assert "http://127.0.0.1:8001/api/readyz" in ran
    assert "git fetch --quiet origin dev" in ran


def test_deploy_refuses_branch_mismatch(tmp_path):
    result, ran = _run_deploy(tmp_path, head="refs/heads/main", env={"DEPLOY_BRANCH": "dev"})
    assert result.returncode != 0
    assert "checkout is not on dev" in result.stderr
    assert "docker compose build" not in ran


def test_sit_deploy_prunes_old_rollback_tags_keeping_three(tmp_path):
    old = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]  # newest first
    tags = "\n".join(["latest", "0123456789abcdef", *old]) + "\n"
    result, ran = _run_deploy(tmp_path, head="refs/heads/dev", env={"DEPLOY_BRANCH": "dev"},
                              image_tags=tags)
    assert result.returncode == 0, result.stderr
    removed = [line for line in ran.splitlines() if line.startswith("docker image rm")]
    assert len(removed) == 1
    assert "echo-app:cccccccccccc" in removed[0] and "echo-app:dddddddddddd" in removed[0]
    for kept in ("latest", "0123456789abcdef", "aaaaaaaaaaaa", "bbbbbbbbbbbb"):
        assert f"echo-app:{kept}" not in removed[0]
    assert "docker image prune -f" in ran
    assert "docker builder prune -f --filter until=72h" in ran


def test_sit_prune_with_few_tags_is_a_no_op(tmp_path):
    result, ran = _run_deploy(tmp_path, head="refs/heads/dev", env={"DEPLOY_BRANCH": "dev"},
                              image_tags="latest\n0123456789abcdef\n")
    assert result.returncode == 0, result.stderr
    assert "docker image rm" not in ran
