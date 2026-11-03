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


DENIED = "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"


def stream(calls: list[tuple[str, dict, str]], reply: str = "done") -> str:
    """What `claude -p --output-format stream-json` prints for these (tool, input, result) calls."""
    lines = []
    for i, (tool, ti, result) in enumerate(calls):
        use = {"type": "tool_use", "id": f"t{i}", "name": tool, "input": ti}
        lines.append({"type": "assistant", "message": {"content": [use]}})
        res = {"type": "tool_result", "tool_use_id": f"t{i}", "is_error": True, "content": result}
        lines.append({"type": "user", "message": {"content": [res]}})
    lines.append({"type": "result", "result": reply})
    return "\n".join(json.dumps(line) for line in lines)


def test_a_deny_rule_refusal_counts_from_the_cli_tool_result() -> None:
    # Edit(...) deny rules refuse these Writes before the hook runs: no hook log entry for them
    by_rule = [c for c in CALLS if c[0] == "Write" and "config.py" not in c[1]["file_path"]]
    root = project([c for c in CALLS if c not in by_rule], ["bash-ok.txt", "ps-ok.txt"])
    absolute = {"file_path": str(root / "vendor" / "a.txt"), "content": "x"}  # how the model often writes it
    out = stream([("Write", absolute, DENIED)] + [(t, ti, DENIED) for t, ti in by_rule[1:]], "broad-except-py")
    checks = smoke.guard_checks(root, out)
    assert all(checks.values()), {k: v for k, v in checks.items() if not v}


def test_a_refusal_only_the_model_reports_does_not_count() -> None:
    by_rule = [c for c in CALLS if c[0] == "Write" and "config.py" not in c[1]["file_path"]]
    root = project([c for c in CALLS if c not in by_rule], ["bash-ok.txt", "ps-ok.txt"])
    claim = f"vendor/a.txt: {DENIED} src/../vendor/b.txt: {DENIED} .claude/guardrails.json: {DENIED}"
    checks = smoke.guard_checks(root, stream([], claim))  # no tool call, only the reply says so
    assert not checks["readonly vendor/ refused"] and not checks["guard config refused, untouched"]
    # a secret is the hook's to refuse: no deny rule can stand in for it
    out = stream([("Write", {"file_path": "config.py", "content": "x"}, DENIED)])
    root = project([c for c in CALLS if "config.py" not in c[1].get("file_path", "")], ["bash-ok.txt", "ps-ok.txt"])
    assert not smoke.guard_checks(root, out)["secret refused, never written"]


def test_events_with_a_string_message_are_skipped() -> None:
    # the CLI on Windows emits notices whose "message" is a string, not an object
    notice = json.dumps({"type": "system", "message": "PowerShell tool enabled"})
    out = "\n".join([notice, stream([("Write", {"file_path": "vendor/a.txt"}, DENIED)])])
    assert smoke.tool_calls(out) == [("Write", json.dumps({"file_path": "vendor/a.txt"}), True, DENIED)]


def test_a_control_written_by_another_tool_does_not_count() -> None:
    # ps-ok.txt exists, but the PowerShell hook never saw it
    root = project([c for c in CALLS if c[0] != "PowerShell"], ["bash-ok.txt", "ps-ok.txt"])
    checks = smoke.guard_checks(root, "broad-except-py")
    if smoke.WINDOWS:
        assert not checks["control: an allowed PowerShell write went through"]
