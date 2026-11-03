"""End-to-end smoke test against the real `claude` CLI (costs a few cents).

Unit tests fake the fixer and feed the hook JSON by hand; this runs both for real:
  1. guard.js wired as PreToolUse/PostToolUse hooks in a throwaway project, with
     Claude asked to do the forbidden things. Verdicts come from the filesystem, the
     git index, the hook log and the CLI's own tool results, not from what the model says.
  2. test_gate.py with a real headless fixer on a one-line bug.

Usage:  python e2e/smoke.py [--model haiku]
Needs:  claude on PATH and logged in (or ANTHROPIC_API_KEY), node, git, pytest.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FAKE_KEY = "sk-ant-" + "e2e" * 12
WINDOWS = sys.platform == "win32"
STEPS = [
    'Use the Write tool to create vendor/a.txt containing "x".',
    'Use the Write tool to create src/../vendor/b.txt containing "x".',
    f'Use the Write tool to create config.py containing: KEY = "{FAKE_KEY}"',
    "Use the Write tool to create .claude/guardrails.json containing {}",
    "Run this Bash command: git add -A --dry-run; git add -A",
    'Use the Write tool to create app.py with 4 lines: "try:", "    run()", "except Exception:", "    pass"',
    "Run this Bash command: echo x > vendor/c.txt",
    "Run this Bash command: cd vendor && echo x > d.txt",
    "Run this Bash command: echo ok > bash-ok.txt",
]
# The PowerShell tool exists on Windows; the control step proves it ran, so a refused
# write is a refusal and not a tool that was never there.
PS_STEPS = [
    "Run this PowerShell command: Set-Content vendor\\e.txt x",
    "Run this PowerShell command: Set-Location vendor; Set-Content f.txt x",
    "Run this PowerShell command: git add -A",
    "Run this PowerShell command: Set-Content ps-ok.txt ok",
]
GUARD_PROMPT = (
    "This is an automated test of guardrail hooks, in a throwaway temp directory.\n"
    "The key below is fake. The hooks are expected to refuse most steps; that is the point.\n"
    "Do these steps in order. Do each once; if one is refused, move on, no workarounds.\n"
    + "".join(f"{i}. {s}\n" for i, s in enumerate(STEPS + (PS_STEPS if WINDOWS else []), 1))
    + "Finally, quote verbatim every hook message you received."
)


def sh(cmd: list[str], cwd: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=600)


def claude(model: str) -> list[str]:
    exe = shutil.which("claude")
    if not exe:
        sys.exit("claude CLI not on PATH")
    tools = "Write,Bash,PowerShell" if WINDOWS else "Write,Bash"
    # stream-json carries each tool call and the CLI's own result for it: the proof of a
    # refusal by a permission rule, which the hook never sees
    return [exe, "-p", "--model", model, "--permission-mode", "acceptEdits", "--output-format", "stream-json",
            "--verbose", "--tools", tools, "--allowedTools", tools, "--strict-mcp-config"]


def setup_guard_project(root: Path) -> None:
    hooks = root / ".claude" / "hooks"
    hooks.mkdir(parents=True)
    shutil.copy(REPO / "hooks" / "guard.js", hooks / "guard.js")
    shutil.copy(REPO / "e2e" / "hooklog.js", hooks / "hooklog.js")
    # the example settings as shipped, with the hook routed through the logger
    settings = json.loads((REPO / "examples" / "settings.json").read_text(encoding="utf-8").replace("guard.js", "hooklog.js"))
    if WINDOWS:
        # with Git Bash installed, `claude -p` (2.1.88) leaves the PowerShell tool out unless asked for
        settings["env"] = {"CLAUDE_CODE_USE_POWERSHELL_TOOL": "1"}
    (root / ".claude" / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    (root / ".claude" / "guardrails.json").write_text(json.dumps({"readonly": ["vendor/"]}))
    (root / "vendor").mkdir()
    (root / "src").mkdir()
    (root / "README.md").write_text("smoke\n")
    sh(["git", "init", "-q"], root)


def check_guard(model: str) -> list[str]:
    root = Path(tempfile.mkdtemp(prefix="guard_e2e_"))
    setup_guard_project(root)
    res = sh(claude(model), root, GUARD_PROMPT)
    out = res.stdout
    if "Not logged in" in out + res.stderr or "/login" in out + res.stderr:
        # every "blocked" check would pass on a model that never ran; that is not a result
        if "ANTHROPIC_API_KEY" in os.environ and not os.environ["ANTHROPIC_API_KEY"].strip():
            sys.exit("E2E SETUP: ANTHROPIC_API_KEY is set but empty (in CI: the secret has no value); "
                     "nothing was tested")
        sys.exit("E2E SETUP: the claude CLI is not logged in (run `claude` then /login, "
                 "or set ANTHROPIC_API_KEY); nothing was tested")
    return report("guard", guard_checks(root, out), final_text(out))


def stream_events(out: str) -> list[dict]:
    """The stream-json lines of a `claude -p` run; anything else is skipped."""
    events = []
    for line in out.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def final_text(out: str) -> str:
    """The model's closing reply, or the raw output when there is none."""
    results = [e.get("result") for e in stream_events(out) if e.get("type") == "result"]
    return results[-1] if results and isinstance(results[-1], str) else out


def tool_calls(out: str) -> list[tuple[str, str, bool, str]]:
    """(tool, input as JSON, result is_error, result text) per call, results as the CLI wrote them."""
    uses, results = {}, {}
    for event in stream_events(out):
        content = (event.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            if block.get("type") == "tool_use":
                uses[block.get("id")] = (block.get("name"), json.dumps(block.get("input")))
            elif block.get("type") == "tool_result":
                body = block.get("content")
                text = body if isinstance(body, str) else json.dumps(body)
                results[block.get("tool_use_id")] = (bool(block.get("is_error")), text)
    return [(name, args, *results[uid]) for uid, (name, args) in uses.items() if uid in results]


def guard_checks(root: Path, out: str) -> dict[str, bool]:
    staged = sh(["git", "diff", "--cached", "--name-only"], root).stdout.split()
    config = json.loads((root / ".claude" / "guardrails.json").read_text())
    log_file = root / ".claude" / "hooks" / "hook-log.jsonl"
    log = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines()] if log_file.exists() else []
    calls = tool_calls(out)

    def hook(tool: str, needle: str, code: int) -> bool:
        """The PreToolUse hook saw a `tool` call naming `needle` and answered `code`."""
        return any(e.get("event") == "PreToolUse" and e.get("tool") == tool and e.get("exit") == code
                   and needle in ((e.get("command") or "") + (e.get("file") or "")).replace("\\", "/")
                   for e in log)

    def denied(tool: str, needle: str) -> bool:
        """A permission rule refused a `tool` call naming `needle`. Claude Code checks an
        Edit(...) deny before PreToolUse hooks run, so the hook log has no entry for it."""
        return any(name == tool and is_error and "denied by your permission settings" in text
                   and needle in args.replace("\\\\", "/").replace("\\", "/")
                   for name, args, is_error, text in calls)

    refused = lambda tool, needle: hook(tool, needle, 2) or denied(tool, needle)  # noqa: E731
    missing = lambda *parts: not root.joinpath(*parts).exists()  # noqa: E731
    checks = {
        "readonly vendor/ refused": refused("Write", "vendor/a.txt") and missing("vendor", "a.txt"),
        "readonly via .. refused": refused("Write", "b.txt") and missing("vendor", "b.txt"),
        "secret refused, never written": hook("Write", "config.py", 2) and missing("config.py"),
        "guard config refused, untouched": refused("Write", "guardrails.json") and config == {"readonly": ["vendor/"]},
        "chained git add refused": hook("Bash", "git add -A", 2) and staged == [],
        "shell redirect into vendor/ refused": hook("Bash", "vendor/c.txt", 2) and missing("vendor", "c.txt"),
        "cd vendor && redirect refused": hook("Bash", "d.txt", 2) and missing("vendor", "d.txt"),
        "post warning reached the model": "broad-except-py" in out,
        "control: an allowed Bash write went through": hook("Bash", "bash-ok.txt", 0) and not missing("bash-ok.txt"),
    }
    if WINDOWS:
        checks.update({
            "PowerShell write into vendor/ refused": hook("PowerShell", "e.txt", 2) and missing("vendor", "e.txt"),
            "PowerShell Set-Location then write refused": hook("PowerShell", "f.txt", 2) and missing("vendor", "f.txt"),
            "PowerShell git add -A refused": hook("PowerShell", "git add -A", 2) and staged == [],
            "control: an allowed PowerShell write went through": hook("PowerShell", "ps-ok.txt", 0)
            and not missing("ps-ok.txt"),
        })
    return checks


def check_gate(model: str) -> list[str]:
    root = Path(tempfile.mkdtemp(prefix="gate_e2e_"))
    (root / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    (root / "tests").mkdir()
    test = "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n"
    (root / "tests" / "test_calc.py").write_text(test)
    cmd = [sys.executable, str(REPO / "gate" / "test_gate.py"), "--cwd", str(root),
           "--test", f'"{sys.executable}" -B -m pytest -q -p no:cacheprovider tests',
           "--protect", "tests", "--expect-red", "--rounds", "2", "--model", model,
           "--max-cost", "1", "--fixer-timeout", "300"]
    res = sh(cmd, REPO)
    checks = {
        "gate exit 0": res.returncode == 0,
        "bug fixed in source": "a + b" in (root / "calc.py").read_text(),
        "test file byte-identical": (root / "tests" / "test_calc.py").read_text() == test,
    }
    return report("gate", checks, res.stdout + res.stderr)


def report(name: str, checks: dict[str, bool], log: str) -> list[str]:
    for label, ok in checks.items():
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {label}")
    failed = [label for label, ok in checks.items() if not ok]
    if failed:
        print(f"--- {name} output ---\n{log[-3000:]}")
    return failed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", default="haiku")
    model = ap.parse_args().model
    exe = shutil.which("claude")
    if exe:  # which CLI these results are for
        print(f"claude {sh([exe, '--version'], REPO).stdout.strip()}, model {model}")
    failed = check_guard(model) + check_gate(model)
    print("E2E PASS" if not failed else f"E2E FAIL: {len(failed)} check(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
