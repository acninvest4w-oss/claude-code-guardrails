"""Test gate: loop a headless Claude fixer until the test command exits 0.

Done = the test command exits 0 AND the protected paths (tests, test config)
are byte-for-byte unchanged. The agent's own "done" claim is never consulted.

Usage (run from the project root):
  python path/to/test_gate.py --test "python -m pytest -q tests" \
      --protect tests conftest.py pytest.ini --task "US-42: ..." --expect-red
  python path/to/test_gate.py --check --test "python -m pytest -q tests"

Exit codes: 0 pass | 1 still red after all rounds (call a human)
            3 fixer touched protected files (reverted, aborted)
            4 --expect-red but tests already green | 5 claude CLI not found
            6 fixer call failed (auth/API error), no point retrying
            7 bad setup: test command broken (exit not in --red-codes, e.g.
              pytest 4 = path not found, 5 = no tests) or --protect matched no file
            8 test command timed out (--test-timeout), process tree killed
            9 --max-cost budget reached before the tests went green

Common test-config files (conftest.py, pytest.ini, pyproject.toml, package.json,
jest/vitest config ...) at the project root are protected too, even before they
exist, so a new root conftest.py with collect_ignore is caught. --no-auto-protect
turns that off, e.g. when the fix legitimately needs a new dependency.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

EXIT_PASS = 0
EXIT_STILL_RED = 1
EXIT_TAMPERED = 3
EXIT_NOT_RED = 4
EXIT_NO_CLAUDE = 5
EXIT_FIXER_FAILED = 6
EXIT_BAD_SETUP = 7
EXIT_TIMEOUT = 8
EXIT_BUDGET = 9

FIXER_TOOLS = "Read,Edit,Write,Grep,Glob"
AUTO_PROTECT = (
    "conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini", ".coveragerc",
    "package.json", "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs",
    "vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.mts",
)
BUDGET_SUBTYPE = "error_max_budget_usd"
IGNORED_PARTS = {"__pycache__", ".pytest_cache", "bin", "obj", "node_modules"}
FAIL_MARKERS = re.compile(r"FAILED|ERROR|Error:|AssertionError|assert |Traceback")
EARLY_FAIL_LINES = 20
HASH_CHUNK = 1 << 20


@dataclass
class TestRun:
    code: int | None  # None = timed out
    output: str


@dataclass
class ProcResult:
    code: int | None  # None = timed out, tree killed
    stdout: bytes
    stderr: bytes


@dataclass
class FixerResult:
    failed: bool
    text: str
    cost: float
    budget_hit: bool = False  # claude stopped itself at --max-budget-usd


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill the process and everything it spawned (a shell's pytest, a CLI's node)."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        os.killpg(proc.pid, signal.SIGKILL)


def run_proc(cmd: str | list[str], cwd: Path, timeout: float, **kw: object) -> ProcResult:
    """Popen + communicate with a timeout that kills the whole tree, not just the shell.

    subprocess.run(timeout=) kills only the direct child; a grandchild holding the
    pipes open would keep communicate() blocked forever.
    """
    stdin = kw.pop("stdin_data", None)
    group = {} if os.name == "nt" else {"start_new_session": True}
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, **group,
                            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                            stderr=kw.pop("stderr", subprocess.PIPE), **kw)
    try:
        out, err = proc.communicate(stdin, timeout=timeout)
        return ProcResult(proc.returncode, out or b"", err or b"")
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        out, err = proc.communicate()
        return ProcResult(None, out or b"", err or b"")


def run_tests(cmd: str, cwd: Path, timeout: float) -> TestRun:
    """Run the test command through the shell, stdout and stderr interleaved."""
    res = run_proc(cmd, cwd, timeout, shell=True, stderr=subprocess.STDOUT)
    return TestRun(res.code, res.stdout.decode("utf-8", errors="replace"))


def iter_protected(paths: list[str], cwd: Path) -> list[Path]:
    """Expand protected paths (files or dirs) into files, skipping build caches."""
    files: list[Path] = []
    for raw in paths:
        target = cwd / raw
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            files.extend(f for f in target.rglob("*") if f.is_file()
                         and not IGNORED_PARTS.intersection(f.relative_to(target).parts))
    return sorted(set(files))


@dataclass
class Snapshot:
    """sha256 per protected file in memory; the original bytes live on disk."""
    hashes: dict[Path, str]
    backups: dict[Path, Path]


def file_hash(path: Path) -> str:
    """Stream the file through sha256 so large fixtures never sit in RAM."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(HASH_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_files(paths: list[str], cwd: Path) -> dict[Path, str]:
    """Current sha256 of every protected file."""
    return {f: file_hash(f) for f in iter_protected(paths, cwd)}


def snapshot(paths: list[str], cwd: Path, backup_dir: Path) -> Snapshot:
    """Hash every protected file and copy it to backup_dir for a later restore."""
    hashes = hash_files(paths, cwd)
    backups: dict[Path, Path] = {}
    for idx, f in enumerate(hashes):
        backups[f] = backup_dir / f"{idx}_{f.name}"
        shutil.copy2(f, backups[f])
    return Snapshot(hashes, backups)


def find_tampered(before: Snapshot, paths: list[str], cwd: Path) -> list[Path]:
    """Return protected files that were changed, added or deleted since the snapshot."""
    after = hash_files(paths, cwd)
    changed = [f for f in before.hashes if after.get(f) != before.hashes[f]]
    added = [f for f in after if f not in before.hashes]
    return sorted(changed + added)


def restore(before: Snapshot, tampered: list[Path]) -> None:
    """Put protected files back exactly as snapshotted; remove added ones."""
    for f in tampered:
        if f in before.backups:
            f.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(before.backups[f], f)
        else:
            f.unlink(missing_ok=True)


def summarize_log(text: str, tail: int) -> str:
    """Last `tail` lines, plus early failure lines a plain tail would cut off."""
    lines = text.splitlines()
    early = [ln for ln in lines[:-tail] if FAIL_MARKERS.search(ln)][:EARLY_FAIL_LINES]
    head = ["... failure lines before the tail ..."] + early + ["... tail ..."] if early else []
    return "\n".join(head + lines[-tail:])


def build_prompt(task: str, excerpt: str, protected: list[str]) -> str:
    """Prompt for the fixer: the task, the hard rules, and the failing output."""
    intro = f"Task:\n{task}\n\n" if task else ""
    return intro + (
        "The test command is failing. Edit the source code so the tests pass.\n"
        f"Protected paths, do NOT modify: {', '.join(protected)}. Any change there is "
        "detected, reverted, and the run is aborted.\n"
        "Do not skip, xfail, or weaken tests, and do not special-case test inputs.\n"
        "Finish with a 3-line summary of what you changed.\n\n"
        f"Test output (excerpt):\n{excerpt}\n")


def deny_rules(protected: list[str]) -> str:
    """Permission deny rules so the fixer is refused edits on protected paths."""
    rules: list[str] = []
    for raw in protected:
        pat = raw.replace("\\", "/").rstrip("/")
        rules += [f"Edit(./{pat})", f"Write(./{pat})", f"Edit(./{pat}/**)", f"Write(./{pat}/**)"]
    return ",".join(rules)


def parse_fixer(stdout: str, stderr: str) -> FixerResult:
    """Read claude -p JSON: an auth/API error is fatal, running out of turns is not."""
    lines = stdout.strip().splitlines()
    try:
        data = json.loads(lines[-1])
    except (json.JSONDecodeError, IndexError):
        return FixerResult(True, stdout + stderr, 0.0)
    subtype = data.get("subtype")
    budget_hit = subtype == BUDGET_SUBTYPE
    failed = bool(data.get("is_error")) and subtype != "error_max_turns" and not budget_hit
    text = f"[{subtype}] {data.get('result', '')} {data.get('errors', '')}\n{stderr}"
    return FixerResult(failed, text, float(data.get("total_cost_usd") or 0.0), budget_hit)


def call_fixer(prompt: str, cfg: argparse.Namespace) -> FixerResult:
    """Run one headless Claude round; the prompt goes in on stdin."""
    # --tools removes every other built-in (no Bash); --strict-mcp-config drops MCP servers
    cmd = [cfg.claude, "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
           "--tools", FIXER_TOOLS, "--strict-mcp-config", "--allowedTools", FIXER_TOOLS,
           "--disallowedTools", deny_rules(cfg.protect), "--max-turns", str(cfg.max_turns)]
    if cfg.model:
        cmd += ["--model", cfg.model]
    if cfg.max_cost > 0:  # the CLI stops itself mid-round; overshoot <= one API call
        cmd += ["--max-budget-usd", f"{max(cfg.max_cost - cfg.cost, 0.01):.2f}"]
    res = run_proc(cmd, cfg.cwd, cfg.fixer_timeout, stdin_data=prompt.encode("utf-8"))
    if res.code is None:
        return FixerResult(True, f"fixer timed out after {cfg.fixer_timeout:g}s, killed", 0.0)
    return parse_fixer(res.stdout.decode("utf-8", errors="replace"),
                       res.stderr.decode("utf-8", errors="replace"))


def save_log(cfg: argparse.Namespace, name: str, text: str) -> None:
    """Keep full logs on disk; the console only gets ASCII status lines."""
    (cfg.log_dir / name).write_text(text, encoding="utf-8")


def gate_loop(cfg: argparse.Namespace) -> int:
    """Test -> fix -> test until green, tampered, or out of rounds."""
    before = snapshot(cfg.protect, cfg.cwd, cfg.log_dir / "protected")
    for rnd in range(cfg.rounds + 1):
        run = run_tests(cfg.test, cfg.cwd, cfg.test_timeout)
        save_log(cfg, f"test_{rnd}.log", run.output)
        stop = judge_run(cfg, run, f"test_{rnd}.log", rnd)
        if stop is not None:
            return stop
        if rnd == cfg.rounds:
            break
        stop = fix_round(cfg, run, rnd + 1, before)
        if stop is not None:
            return stop
    print(f"[gate] STILL RED after {cfg.rounds} rounds -> human needed. "
          f"Cost ${cfg.cost:.2f}. Logs: {cfg.log_dir}")
    return EXIT_STILL_RED


def judge_run(cfg: argparse.Namespace, run: TestRun, log_name: str, rnd: int) -> int | None:
    """Green, timed out or a broken command ends the loop; a real red test goes on."""
    if run.code is None:
        print(f"[gate] ABORT: test command timed out after {cfg.test_timeout:g}s, "
              f"process tree killed. Log: {cfg.log_dir / log_name}")
        return EXIT_TIMEOUT
    if run.code == 0:
        return report_green(cfg, rnd)
    if run.code not in cfg.red_codes:
        return report_bad_command(cfg, run.code, log_name)
    return None


def over_budget(cfg: argparse.Namespace, res: FixerResult) -> bool:
    """The CLI enforces the remaining budget inside a round; this catches the rest."""
    return res.budget_hit or (cfg.max_cost > 0 and cfg.cost >= cfg.max_cost)


def fix_round(cfg: argparse.Namespace, run: TestRun, rnd: int,
              before: Snapshot) -> int | None:
    """One fixer call; returns an exit code to stop on, or None to keep looping."""
    print(f"[gate] round {rnd}/{cfg.rounds}: tests red (exit {run.code}) -> fixer")
    prompt = build_prompt(cfg.task, summarize_log(run.output, cfg.tail), cfg.protect)
    res = call_fixer(prompt, cfg)
    cfg.cost += res.cost
    save_log(cfg, f"fixer_{rnd}.txt", res.text)
    tampered = find_tampered(before, cfg.protect, cfg.cwd)
    if tampered:
        return report_tampered(before, tampered, cfg)
    if res.failed:
        print(f"[gate] ABORT: fixer call failed (auth/API error or timeout), "
              f"see fixer_{rnd}.txt in {cfg.log_dir}")
        return EXIT_FIXER_FAILED
    if over_budget(cfg, res):
        print(f"[gate] STOP: spent ${cfg.cost:.2f} >= --max-cost ${cfg.max_cost:.2f}. "
              f"Logs: {cfg.log_dir}")
        return EXIT_BUDGET
    return None


def report_green(cfg: argparse.Namespace, rnd: int) -> int:
    """Green on round 0 under --expect-red means the tests prove nothing."""
    if rnd == 0 and cfg.expect_red:
        print("[gate] tests are already GREEN before any fix: they do not capture "
              f"the missing behaviour. Logs: {cfg.log_dir}")
        return EXIT_NOT_RED
    print(f"[gate] PASS: test exit 0 after {rnd} fix round(s), protected files intact. "
          f"Cost ${cfg.cost:.2f}. Logs: {cfg.log_dir}")
    return EXIT_PASS


def report_bad_command(cfg: argparse.Namespace, code: int, log_name: str) -> int:
    """A crash or usage error is not a red test; a fixer cannot repair the command."""
    print(f"[gate] ABORT: test command exit {code} is not a test failure "
          f"(--red-codes {sorted(cfg.red_codes)}). Check the command / cwd. "
          f"Log: {cfg.log_dir / log_name}")
    return EXIT_BAD_SETUP


def report_tampered(before: Snapshot, tampered: list[Path],
                    cfg: argparse.Namespace) -> int:
    """Undo edits to protected files and abort; the fix cannot be trusted."""
    restore(before, tampered)
    names = ", ".join(str(f.relative_to(cfg.cwd)) for f in tampered)
    print(f"[gate] ABORT: fixer touched protected files (reverted): {names}. "
          f"Logs: {cfg.log_dir}")
    return EXIT_TAMPERED


def run_check(cfg: argparse.Namespace) -> int:
    """Single run, no fixer: report the test exit code as the verdict."""
    run = run_tests(cfg.test, cfg.cwd, cfg.test_timeout)
    save_log(cfg, "check.log", run.output)
    if run.code is None:
        print(f"[gate] TIMEOUT after {cfg.test_timeout:g}s. Log: {cfg.log_dir / 'check.log'}")
        return EXIT_TIMEOUT
    verdict = "PASS" if run.code == 0 else "FAIL"
    print(f"[gate] {verdict}: test exit {run.code}. Log: {cfg.log_dir / 'check.log'}")
    return EXIT_PASS if run.code == 0 else EXIT_STILL_RED


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """CLI arguments, plus resolved cwd, claude path and a fresh log dir."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--test", required=True, help="test command, run via the shell")
    ap.add_argument("--protect", nargs="+", default=["tests"],
                    help="paths the fixer must not change (tests, conftest.py, pytest.ini ...)")
    ap.add_argument("--task", default="", help="task / acceptance criteria for the fixer")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--max-turns", type=int, default=15)
    ap.add_argument("--tail", type=int, default=60, help="log lines sent to the fixer")
    ap.add_argument("--model", default="", help="fixer model alias, default = CLI default")
    ap.add_argument("--red-codes", default="1",
                    help="exit codes that mean 'tests failed' (pytest/dotnet: 1); others abort")
    ap.add_argument("--expect-red", action="store_true", help="fail if tests start green")
    ap.add_argument("--check", action="store_true", help="run tests once, no fixer")
    ap.add_argument("--test-timeout", type=float, default=1800,
                    help="seconds per test run before the process tree is killed")
    ap.add_argument("--fixer-timeout", type=float, default=1800,
                    help="seconds per fixer call before it is killed")
    ap.add_argument("--max-cost", type=float, default=5.0,
                    help="USD cap on fixer spend, enforced inside each call (0 = no cap)")
    ap.add_argument("--no-auto-protect", action="store_true",
                    help="do not protect root test-config files (pyproject.toml, conftest.py ...)")
    ap.add_argument("--cwd", default=".")
    cfg = ap.parse_args(argv)
    cfg.cwd = Path(cfg.cwd).resolve()
    cfg.red_codes = {int(c) for c in cfg.red_codes.split(",")}
    cfg.explicit_protect = list(cfg.protect)
    if not cfg.no_auto_protect:
        cfg.protect += [n for n in AUTO_PROTECT if n not in cfg.protect]
    cfg.claude = shutil.which("claude")
    cfg.log_dir = Path(tempfile.mkdtemp(prefix="test_gate_"))
    (cfg.log_dir / "protected").mkdir()
    cfg.cost = 0.0
    return cfg


def main(argv: list[str] | None = None) -> int:
    cfg = parse_args(argv)
    if cfg.check:
        return run_check(cfg)
    if not cfg.claude:
        print("[gate] claude CLI not found on PATH")
        return EXIT_NO_CLAUDE
    if not iter_protected(cfg.explicit_protect, cfg.cwd):
        print(f"[gate] ABORT: --protect {cfg.explicit_protect} matched no file under {cfg.cwd}; "
              "the tests would be unprotected. Wrong cwd?")
        return EXIT_BAD_SETUP
    return gate_loop(cfg)


if __name__ == "__main__":
    sys.exit(main())
