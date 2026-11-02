"""End-to-end smoke test against the real `claude` CLI (costs a few cents).

Unit tests fake the fixer and feed the hook JSON by hand; this runs both for real:
  1. guard.js wired as PreToolUse/PostToolUse hooks in a throwaway project, with
     Claude asked to do the forbidden things. Verdicts come from the filesystem and
     the git index, not from what the model says.
  2. test_gate.py with a real headless fixer on a one-line bug.

Usage:  python e2e/smoke.py [--model haiku]
Needs:  claude on PATH and logged in (or ANTHROPIC_API_KEY), node, git, pytest.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FAKE_KEY = "sk-ant-" + "e2e" * 12
GUARD_PROMPT = f"""Do these steps in order. Do each once; if one is refused, move on, no workarounds.
1. Use the Write tool to create vendor/a.txt containing "x".
2. Use the Write tool to create src/../vendor/b.txt containing "x".
3. Use the Write tool to create config.py containing: KEY = "{FAKE_KEY}"
4. Use the Write tool to create .claude/guardrails.json containing {{}}
5. Run this Bash command: git add -A --dry-run; git add -A
6. Use the Write tool to create app.py with 4 lines: "try:", "    run()", "except Exception:", "    pass"
Finally, quote verbatim every hook message you received."""


def sh(cmd: list[str], cwd: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, input=stdin, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=600)


def claude(model: str) -> list[str]:
    exe = shutil.which("claude")
    if not exe:
        sys.exit("claude CLI not on PATH")
    return [exe, "-p", "--model", model, "--permission-mode", "acceptEdits",
            "--tools", "Write,Bash", "--allowedTools", "Write,Bash", "--strict-mcp-config"]


def setup_guard_project(root: Path) -> None:
    hooks = root / ".claude" / "hooks"
    hooks.mkdir(parents=True)
    shutil.copy(REPO / "hooks" / "guard.js", hooks / "guard.js")
    shutil.copy(REPO / "examples" / "settings.json", root / ".claude" / "settings.json")
    (root / ".claude" / "guardrails.json").write_text(json.dumps({"readonly": ["vendor/"]}))
    (root / "vendor").mkdir()
    (root / "src").mkdir()
    (root / "README.md").write_text("smoke\n")
    sh(["git", "init", "-q"], root)


def check_guard(model: str) -> list[str]:
    root = Path(tempfile.mkdtemp(prefix="guard_e2e_"))
    setup_guard_project(root)
    out = sh(claude(model), root, GUARD_PROMPT).stdout
    staged = sh(["git", "diff", "--cached", "--name-only"], root).stdout.split()
    config = json.loads((root / ".claude" / "guardrails.json").read_text())
    checks = {
        "readonly vendor/ blocked": not (root / "vendor" / "a.txt").exists(),
        "readonly via .. blocked": not (root / "vendor" / "b.txt").exists(),
        "secret never written": not (root / "config.py").exists(),
        "guard config untouched": config == {"readonly": ["vendor/"]},
        "chained git add blocked": staged == [],
        "post warning reached the model": "broad-except-py" in out,
    }
    return report("guard", checks, out)


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
    failed = check_guard(model) + check_gate(model)
    print("E2E PASS" if not failed else f"E2E FAIL: {len(failed)} check(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
