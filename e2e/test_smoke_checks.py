"""Offline check of the E2E verdict logic: no claude CLI, no API.

The hook calls a model would make are fed through the real hooklog.js -> guard.js, so the
log is genuine; what is simulated is only the model choosing to make them.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import smoke  # noqa: E402

KEY = smoke.FAKE_KEY
CALLS = [
    ("Write", {"file_path": "vendor/a.txt", "content": "x"}),
    ("Write", {"file_path": "src/../vendor/b.txt", "content": "x"}),
    ("Write", {"file_path": "config.py", "content": f'KEY = "{KEY}"'}),
    ("Write", {"file_path": ".claude/guardrails.json", "content": "{}"}),
    ("Bash", {"command": "git add -A --dry-run; git add -A"}),
    ("Bash", {"command": "echo x > vendor/c.txt"}),
    ("Bash", {"command": "cd vendor && echo x > d.txt"}),
    ("Bash", {"command": "echo ok > bash-ok.txt"}),
    ("PowerShell", {"command": "Set-Content vendor\\e.txt x"}),
    ("PowerShell", {"command": "Set-Location vendor; Set-Content f.txt x"}),
    ("PowerShell", {"command": "git add -A"}),
    ("PowerShell", {"command": "Set-Content ps-ok.txt ok"}),
]


def project(calls: list[tuple[str, dict]], allowed_files: list[str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="smoke_checks_"))
    smoke.setup_guard_project(root)
    for tool, ti in calls:
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": ti, "cwd": str(root)})
        subprocess.run(["node", str(root / ".claude" / "hooks" / "hooklog.js")], input=payload, text=True,
                       capture_output=True, cwd=root, env={**__import__("os").environ, "CLAUDE_PROJECT_DIR": str(root)})
    for name in allowed_files:  # what the allowed calls would have written
        (root / name).write_text("ok\n")
    return root


def test_every_check_passes_when_every_step_was_tried_and_refused() -> None:
    root = project(CALLS, ["bash-ok.txt", "ps-ok.txt"])
    checks = smoke.guard_checks(root, "... (broad-except-py) ...")
    assert all(checks.values()), {k: v for k, v in checks.items() if not v}


def test_skipped_steps_fail_even_though_nothing_was_written() -> None:
    # the model ran only the two controls: no file in vendor/, yet nothing was refused either
    root = project([c for c in CALLS if "ok.txt" in c[1].get("command", "")], ["bash-ok.txt", "ps-ok.txt"])
    checks = smoke.guard_checks(root, "")
    failed = {k for k, v in checks.items() if not v}
    assert "readonly vendor/ refused" in failed and "chained git add refused" in failed
    if smoke.WINDOWS:
        assert "PowerShell write into vendor/ refused" in failed


def test_a_control_written_by_another_tool_does_not_count() -> None:
    # ps-ok.txt exists, but the PowerShell hook never saw it
    root = project([c for c in CALLS if c[0] != "PowerShell"], ["bash-ok.txt", "ps-ok.txt"])
    checks = smoke.guard_checks(root, "broad-except-py")
    if smoke.WINDOWS:
        assert not checks["control: an allowed PowerShell write went through"]
