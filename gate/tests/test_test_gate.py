"""Tests for test_gate.py: real pytest subprocesses in a throwaway project, fake fixer."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_gate as gate  # noqa: E402

BUGGY = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
TEST = "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "calc.py").write_text(BUGGY)
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_calc.py").write_text(TEST)
    return tmp_path


def make_cfg(project: Path, **over: object) -> object:
    cmd = f'"{sys.executable}" -B -m pytest -q -p no:cacheprovider --rootdir . tests'
    argv = ["--test", cmd, "--cwd", str(project), "--rounds", "2"]
    cfg = gate.parse_args(argv)
    cfg.claude = "claude"
    for key, val in over.items():
        setattr(cfg, key, val)
    return cfg


def fake_fixer(action, failed: bool = False):
    def _fix(prompt: str, cfg) -> gate.FixerResult:
        action(cfg.cwd, prompt)
        return gate.FixerResult(failed, "summary", 0.01)
    return _fix


def test_fixer_repairs_source_passes(project, monkeypatch):
    seen = []
    def fix(cwd, prompt):
        seen.append(prompt)
        (cwd / "calc.py").write_text(FIXED)
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(fix))
    assert gate.gate_loop(make_cfg(project, expect_red=True)) == gate.EXIT_PASS
    assert len(seen) == 1 and "assert" in seen[0] and "tests" in seen[0]


def test_fixer_editing_test_is_reverted_and_aborts(project, monkeypatch):
    def cheat(cwd, prompt):
        (cwd / "tests" / "test_calc.py").write_text("def test_add():\n    assert True\n")
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(cheat))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert (project / "tests" / "test_calc.py").read_text() == TEST


def test_fixer_adding_conftest_skip_is_caught(project, monkeypatch):
    def cheat(cwd, prompt):
        (cwd / "tests" / "conftest.py").write_text("collect_ignore = ['test_calc.py']\n")
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(cheat))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert not (project / "tests" / "conftest.py").exists()


def test_still_red_after_rounds(project, monkeypatch):
    calls = []
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(lambda cwd, p: calls.append(1)))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_STILL_RED
    assert len(calls) == 2


def test_expect_red_rejects_tests_already_green(project, monkeypatch):
    (project / "calc.py").write_text(FIXED)
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(lambda cwd, p: None))
    assert gate.gate_loop(make_cfg(project, expect_red=True)) == gate.EXIT_NOT_RED


def test_cache_dirs_are_not_tampering(project, tmp_path_factory):
    before = gate.snapshot(["tests"], project, tmp_path_factory.mktemp("bak"))
    (project / "tests" / "__pycache__").mkdir()
    (project / "tests" / "__pycache__" / "x.pyc").write_bytes(b"\0")
    assert gate.find_tampered(before, ["tests"], project) == []


def test_binary_fixture_is_hashed_and_restored_from_disk(project, tmp_path_factory, monkeypatch):
    blob = bytes(range(256)) * 4096  # 1 MiB binary fixture
    (project / "tests" / "data.bin").write_bytes(blob)
    before = gate.snapshot(["tests"], project, tmp_path_factory.mktemp("bak"))
    assert all(isinstance(h, str) and len(h) == 64 for h in before.hashes.values())

    def cheat(cwd, prompt):
        (cwd / "tests" / "data.bin").write_bytes(b"short")
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(cheat))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert (project / "tests" / "data.bin").read_bytes() == blob


def test_check_mode_uses_exit_code(project):
    assert gate.run_check(make_cfg(project)) == gate.EXIT_STILL_RED
    (project / "calc.py").write_text(FIXED)
    assert gate.run_check(make_cfg(project)) == gate.EXIT_PASS


def test_summarize_keeps_early_failure_beyond_tail():
    lines = ["Traceback: root cause"] + [f"noise {i}" for i in range(100)]
    out = gate.summarize_log("\n".join(lines), tail=10)
    assert "root cause" in out and "noise 99" in out and "noise 50" not in out


def test_fixer_api_failure_aborts_without_burning_rounds(project, monkeypatch):
    calls = []
    monkeypatch.setattr(gate, "call_fixer",
                        fake_fixer(lambda cwd, p: calls.append(1), failed=True))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_FIXER_FAILED
    assert len(calls) == 1


def test_broken_test_command_aborts_without_fixer(project, monkeypatch):
    calls = []
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(lambda cwd, p: calls.append(1)))
    cfg = make_cfg(project)
    cfg.test = f'"{sys.executable}" -B -m pytest -q -p no:cacheprovider no_such_dir'
    assert gate.gate_loop(cfg) == gate.EXIT_BAD_SETUP
    assert calls == []


def test_protect_matching_nothing_aborts_before_running(tmp_path, monkeypatch):
    monkeypatch.setattr(gate, "gate_loop", lambda cfg: pytest.fail("must not run"))
    argv = ["--test", "exit 1", "--cwd", str(tmp_path), "--protect", "tests", "conftest.py"]
    monkeypatch.setattr(gate.shutil, "which", lambda name: "claude")
    assert gate.main(argv) == gate.EXIT_BAD_SETUP


def test_parse_fixer_auth_error_is_fatal():
    raw = ('{"type":"result","subtype":"success","is_error":true,'
           '"result":"Failed to authenticate. API Error: 401","total_cost_usd":0}')
    res = gate.parse_fixer(raw, "")
    assert res.failed and "401" in res.text


def test_parse_fixer_max_turns_is_not_fatal():
    raw = '{"subtype":"error_max_turns","is_error":true,"total_cost_usd":0.12}'
    res = gate.parse_fixer(raw, "")
    assert not res.failed and res.cost == 0.12


def test_parse_fixer_garbage_is_fatal():
    assert gate.parse_fixer("not json", "boom").failed


def test_deny_rules_cover_dir_and_file():
    rules = gate.deny_rules(["tests", "conftest.py"])
    assert "Edit(./tests/**)" in rules and "Write(./conftest.py)" in rules


def test_hung_test_command_is_killed_with_its_children(project, monkeypatch):
    # The shell starts python, which starts a grandchild that holds the pipes open:
    # a plain subprocess.run(timeout=) would block on it forever.
    hang = ("import subprocess, sys, time; "
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']); "
            "time.sleep(120)")
    calls = []
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(lambda cwd, p: calls.append(1)))
    cfg = make_cfg(project, test=f'"{sys.executable}" -c "{hang}"', test_timeout=2)
    started = time.monotonic()
    assert gate.gate_loop(cfg) == gate.EXIT_TIMEOUT
    assert time.monotonic() - started < 30
    assert calls == []


def test_fixer_timeout_aborts_as_failed_call(project, monkeypatch):
    monkeypatch.setattr(gate, "run_proc", lambda *a, **k: gate.ProcResult(None, b"", b""))
    res = gate.call_fixer("prompt", make_cfg(project, fixer_timeout=5))
    assert res.failed and "timed out" in res.text


def test_max_cost_stops_between_rounds(project, monkeypatch):
    calls = []
    def spend(prompt, cfg):
        calls.append(1)
        return gate.FixerResult(False, "summary", 0.6)
    monkeypatch.setattr(gate, "call_fixer", spend)
    assert gate.gate_loop(make_cfg(project, rounds=5, max_cost=1.0)) == gate.EXIT_BUDGET
    assert len(calls) == 2


def test_check_mode_reports_timeout(project):
    cfg = make_cfg(project, test=f'"{sys.executable}" -c "import time; time.sleep(60)"',
                   test_timeout=1)
    assert gate.run_check(cfg) == gate.EXIT_TIMEOUT


def test_new_root_conftest_is_caught_without_listing_it(project, monkeypatch):
    def hide_tests(cwd, prompt):
        (cwd / "conftest.py").write_text('collect_ignore = ["tests"]\n')
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(hide_tests))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert not (project / "conftest.py").exists()


def test_root_test_config_is_protected_unless_opted_out(project, monkeypatch):
    (project / "pyproject.toml").write_text("[tool.pytest.ini_options]\n")
    def fix_and_skip(cwd, prompt):
        (cwd / "calc.py").write_text(FIXED)
        (cwd / "pyproject.toml").write_text('[tool.pytest.ini_options]\naddopts = "-k nothing"\n')
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(fix_and_skip))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert (project / "pyproject.toml").read_text() == "[tool.pytest.ini_options]\n"
    cfg = gate.parse_args(["--test", "x", "--cwd", str(project), "--no-auto-protect"])
    assert cfg.protect == ["tests"]


def test_parse_fixer_budget_stop_is_not_an_api_failure():
    raw = ('{"subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.4,'
           '"errors":["Reached maximum budget ($0.30)"]}')
    res = gate.parse_fixer(raw, "")
    assert not res.failed and res.budget_hit and res.cost == 0.4


def test_fixer_gets_the_remaining_budget(project, monkeypatch):
    seen = []
    def fake_run(cmd, cwd, timeout, **kw):
        seen.append(cmd)
        return gate.ProcResult(0, b'{"subtype":"success","total_cost_usd":0}', b"")
    monkeypatch.setattr(gate, "run_proc", fake_run)
    gate.call_fixer("p", make_cfg(project, max_cost=2.0, cost=1.25))
    gate.call_fixer("p", make_cfg(project, max_cost=0))
    assert seen[0][seen[0].index("--max-budget-usd") + 1] == "0.75"
    assert "--max-budget-usd" not in seen[1]


def test_budget_hit_inside_a_round_stops_at_once(project, monkeypatch):
    calls = []
    def spend(prompt, cfg):
        calls.append(1)
        return gate.FixerResult(False, "summary", 0.3, budget_hit=True)
    monkeypatch.setattr(gate, "call_fixer", spend)
    assert gate.gate_loop(make_cfg(project, rounds=5, max_cost=1.0)) == gate.EXIT_BUDGET
    assert len(calls) == 1


# Codex review round 1: ways to a fake green.
IMPORT_TAMPER = (
    "from pathlib import Path\n"
    "Path('tests/test_calc.py').write_text('def test_add():\\n    assert True\\n')\n"
    "def add(a, b):\n    return a - b\n")


def test_tests_rewritten_during_the_test_run_are_caught(project, monkeypatch):
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(
        lambda cwd, p: (cwd / "calc.py").write_text(IMPORT_TAMPER)))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert (project / "tests" / "test_calc.py").read_text() == TEST


def test_shadowing_the_test_runner_is_caught(project, monkeypatch):
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(
        lambda cwd, p: (cwd / "pytest.py").write_text("raise SystemExit(0)\n")))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert not (project / "pytest.py").exists()


def test_exit_0_without_passing_tests_in_the_output_is_not_green(project, monkeypatch):
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(
        lambda cwd, p: (cwd / "calc.py").write_text("import os\nos._exit(0)\n")))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_NO_EVIDENCE


def test_pass_pattern_defaults_by_runner_and_can_be_disabled(project):
    base = ["--cwd", str(project)]
    assert gate.parse_args(["--test", "python -m pytest -q", *base]).pass_pattern
    assert gate.parse_args(["--test", "npx jest", *base]).pass_pattern
    assert not gate.parse_args(["--test", "make test", *base]).pass_pattern
    assert not gate.parse_args(["--test", "pytest", "--pass-pattern", "", *base]).pass_pattern


def test_a_fix_that_reaches_the_budget_is_still_verified(project, monkeypatch):
    def fix_at_cap(prompt, cfg):
        (cfg.cwd / "calc.py").write_text(FIXED)
        return gate.FixerResult(False, "summary", 1.0, budget_hit=True)
    monkeypatch.setattr(gate, "call_fixer", fix_at_cap)
    assert gate.gate_loop(make_cfg(project, max_cost=1.0)) == gate.EXIT_PASS


def test_detached_survivor_holding_the_pipe_cannot_stall_the_gate(project):
    # spawn.py starts a child in its own session/group and exits at once, so the child
    # is outside the tree the gate kills, yet it still holds the output pipe.
    (project / "spawn.py").write_text(
        "import os, subprocess, sys\n"
        "kw = {'creationflags': 0x00000200} if os.name == 'nt' else {'start_new_session': True}\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(25)'], **kw)\n")
    py = f'"{sys.executable}"'
    cfg = make_cfg(project, test=f'{py} spawn.py && {py} -c "import time; time.sleep(60)"',
                   test_timeout=2)
    started = time.monotonic()
    assert gate.run_check(cfg) == gate.EXIT_TIMEOUT
    assert time.monotonic() - started < 20


# Codex review round 2.
def test_check_mode_also_catches_and_reverts_protected_changes(project):
    (project / "calc.py").write_text(
        "from pathlib import Path\nPath('tests/added.txt').write_text('x')\n" + FIXED)
    assert gate.run_check(make_cfg(project)) == gate.EXIT_TAMPERED
    assert not (project / "tests" / "added.txt").exists()


def test_unittest_package_shadow_is_protected(project, monkeypatch):
    def shadow(cwd, prompt):
        (cwd / "unittest").mkdir()
        (cwd / "unittest" / "__init__.py").write_text("raise SystemExit(0)\n")
    monkeypatch.setattr(gate, "call_fixer", fake_fixer(shadow))
    assert gate.gate_loop(make_cfg(project)) == gate.EXIT_TAMPERED
    assert not (project / "unittest" / "__init__.py").exists()


def test_quiet_pytest_and_unittest_count_as_evidence(project):
    (project / "calc.py").write_text(FIXED)
    qq = f'"{sys.executable}" -B -m pytest -qq -p no:cacheprovider tests'
    cfg = make_cfg(project, test=qq)
    cfg.pass_pattern = gate.parse_args(["--test", qq, "--cwd", str(project)]).pass_pattern
    assert gate.run_check(cfg) == gate.EXIT_PASS
    ut = gate.parse_args(["--test", "python -m unittest discover", "--cwd", str(project)])
    assert ut.pass_pattern and "unittest" in ut.protect


# Codex review round 3.
def test_all_skipped_quiet_run_is_not_evidence(project):
    (project / "calc.py").write_text(
        "import pytest\n\ndef add(a, b):\n    pytest.skip('temporarily unavailable')\n")
    qq = f'"{sys.executable}" -B -m pytest -qq -p no:cacheprovider tests'
    cfg = make_cfg(project, test=qq)
    cfg.pass_pattern = gate.parse_args(["--test", qq, "--cwd", str(project)]).pass_pattern
    assert gate.run_check(cfg) == gate.EXIT_NO_EVIDENCE
    q = make_cfg(project)
    assert gate.run_check(q) == gate.EXIT_NO_EVIDENCE  # "1 skipped" has no "passed" either


# Codex review round 4.
def test_unittest_evidence_needs_a_test_that_ran(project):
    assert gate.unittest_passed("Ran 2 tests in 0.001s\n\nOK (skipped=1)")
    assert not gate.unittest_passed("Ran 1 test in 0.001s\n\nOK (skipped=1)")
    assert not gate.unittest_passed("Ran 2 tests\n\nOK (skipped=1, expected failures=1)")
    assert not gate.unittest_passed("Ran 0 tests in 0.000s\n\nNO TESTS RAN")
    (project / "calc.py").write_text("import unittest\nraise unittest.SkipTest('unavailable')\n")
    (project / "tests" / "__init__.py").write_text("")
    cmd = f'"{sys.executable}" -B -m unittest discover -s tests -t .'
    cfg = make_cfg(project, test=cmd)
    cfg.pass_pattern = gate.parse_args(["--test", cmd, "--cwd", str(project)]).pass_pattern
    assert gate.run_check(cfg) == gate.EXIT_NO_EVIDENCE
