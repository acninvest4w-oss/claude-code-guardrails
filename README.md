# claude-code-guardrails

**The agent says "done". The exit code decides.**

Three small, tested pieces for running Claude Code on real work without trusting its
self-report:

| Piece | What it does | Size |
|---|---|---|
| [`gate/test_gate.py`](gate/test_gate.py) | Loops a headless Claude fixer until your test command exits 0, with the tests locked byte-for-byte so it can't win by editing them | 1 file, stdlib only |
| [`hooks/guard.js`](hooks/guard.js) | One PreToolUse/PostToolUse hook: blocks the mistakes that cost real time, warns on the rest *in a way the model actually sees* | 1 file, no deps |
| [`agents/reviewer.md`](agents/reviewer.md) | Read-only subagent with a fresh context that reviews a change against the acceptance criteria | 1 file |

Most rules exist because an agent did exactly that thing on a live project.

## Evidence

- **Real traffic.** Replayed against 8,917 tool calls from 318 sessions of an active
  Windows monorepo, the hook blocked 39: 37 right, **2 wrong (0.02%)**.
  [Breakdown](docs/hooks.md#measured-on-a-real-project).
- **A public corpus anyone can rerun.** All 32,692 example commands of
  [tldr-pages](https://github.com/tldr-pages/tldr) go through the hook in CI: 4 blocked
  (`git add -A` twice, `git add .`, `rmdir *` next to a read-only dir), **0 false**. Every
  block is labelled by hand; a new one fails CI until it is.
  [Corpus](bench/corpus/README.md).
- **Real CLI.** [`e2e/smoke.py`](e2e/smoke.py) asks Claude to break each rule in a throwaway
  project: 13 hook checks over Bash and PowerShell, 3 gate checks. A refusal counts only
  from the hook's own log or the CLI's tool result, never from what the model says.
  Runs in the open: [Ubuntu 12/12, Windows 16/16, CLI 2.1.317](https://github.com/acninvest4w-oss/claude-code-guardrails/actions/runs/41595632590).
- **Attacked on purpose.** 11 rounds of adversarial review by a second model: each bypass
  it found is fixed with a regression test or listed under the limits. A seeded fuzz suite
  checks properties for both shells. CI runs it all on Ubuntu and Windows.
- **Real shells as the judge.** Generated commands run for real in bash and pwsh, and the
  tree is diffed: a protected file that changed while the hook said nothing fails the test.
  Seventeen kinds of miss found that way and by red-team review are fixed; 13,800 cases
  since, none let through.
  [How](docs/hooks.md#checked-against-real-shells).
- **Cheap.** About 50 ms per tool call (about 85 ms with the Windows no-flash wrapper),
  almost all of it starting processes; the check itself is 0.2 ms.

## Quick start

```bash
git clone --branch v1.3.0 https://github.com/acninvest4w-oss/claude-code-guardrails ~/claude-code-guardrails
cd /path/to/your/project
mkdir -p .claude/hooks .claude/agents
cp ~/claude-code-guardrails/hooks/guard.js .claude/hooks/
cp ~/claude-code-guardrails/agents/reviewer.md .claude/agents/
```

Merge [`examples/settings.json`](examples/settings.json) into `.claude/settings.json`
(Windows: [`examples/settings.windows.json`](examples/settings.windows.json), no console
flash). Then run the gate on a failing test:

```bash
python ~/claude-code-guardrails/gate/test_gate.py --test "python -m pytest -q tests" \
  --protect tests --task "what the fix must do" --expect-red
```

What the model reads when the hook steps in (from a real E2E run):

```
[guardrails] BLOCKED (readonly-dir) vendor/ is read-only (config "readonly"). Copy the pattern elsewhere.
[guardrails] BLOCKED (git-add-all) git add -A/--all/./* stages everything (.env, dumps, keys). Add files by name, or run git add -n ... first and review.
[guardrails] WARN (already written, please fix) (broad-except-py) 1x "except Exception": catch the specific exception you expect.
```

---

## 1. Test gate: only the exit code says done

```bash
python gate/test_gate.py \
  --test "python -m pytest -q tests" \
  --protect tests conftest.py pytest.ini \
  --task "US-42: refunds over 30 days are rejected" \
  --expect-red
```

What happens:

1. Snapshot every protected file: a sha256 in memory, the original copied to a temp dir
   on disk. Large fixtures (images, dumps) never sit in RAM.
2. Run the tests. Exit 0 -> done. Red -> send the task + a trimmed failure log to
   `claude -p`.
3. After each fixer round *and after each test run*, diff the snapshot. Any protected
   file changed, added or deleted -> **reverted and aborted**. A `conftest.py` with
   `collect_ignore` counts, and so does source code that rewrites a test when imported.
4. Repeat until green or out of rounds, then hand back to a human.

How it closes the usual ways an agent "passes" tests:

- **Edits the test** -> the hash snapshot catches it, and `--disallowedTools Edit(./tests/**)`
  refuses it up front.
- **Skips/ignores the test via config** -> root test config (`conftest.py`, `pytest.ini`,
  `pyproject.toml`, `setup.cfg`, `tox.ini`, `package.json`, jest/vitest config) is protected
  automatically, *even before it exists*, so a new root `conftest.py` with `collect_ignore`
  is caught. New files under protected dirs count too. Nested config elsewhere: add it to
  `--protect`. If the fix really needs a new dependency, `--no-auto-protect`.
- **Shadows the test runner** -> a root `pytest.py`, `pytest/`, `unittest.py`, `unittest/` or
  `sitecustomize.py` would be imported instead of the real runner; they are auto-protected
  the same way.
- **Makes the run exit 0 without running tests** (`os._exit(0)` at import, an empty
  selection) -> `--pass-pattern` must appear in the output. `auto` picks the runner's own
  summary with at least one passed test: pytest `N passed` (under `-qq`, a progress line
  with a `.`; an all-skipped `s [100%]` does not count), jest/vitest `N passed`, unittest
  `Ran N tests` minus skipped and expected failures. Pass a regex for other runners, `''`
  for none.
- **Runs something else and reports success** -> the fixer has no shell at all
  (`--tools Read,Edit,Write,Grep,Glob`, MCP servers dropped). The gate runs the tests itself.
- **Tests were never red** -> `--expect-red` fails if they pass before any fix, because
  then they don't capture the missing behaviour.
- **Broken test command** (wrong cwd, no tests collected) -> exit codes outside
  `--red-codes` abort before burning a fixer call. So does `--protect` matching nothing.
- **Auth/API failure** -> abort after one round instead of looping on an error.
- **Something hangs** -> `--test-timeout` / `--fixer-timeout` (default 30 min each) kill
  the whole process tree, not just the shell. Collecting output after the kill is bounded
  too, so a detached survivor still holding the pipe can't stall the gate.
- **Runaway spend** -> `--max-cost` (USD, default 5, `0` = no cap). The remaining budget
  is passed to each fixer call as `--max-budget-usd`, so the CLI stops itself mid-round;
  the overshoot is at most one API call, not a whole round. A fix made in the round that
  hits the cap is still tested before the gate gives up.

The log keeps the tail plus early `Traceback`/`FAILED` lines a plain tail would cut off,
so the fixer sees the root cause and not just the summary line.

| Exit | Meaning |
|---|---|
| 0 | tests exit 0, protected files intact |
| 1 | still red after `--rounds` (human needed) |
| 3 | protected files changed by the fixer or by code under test (reverted) |
| 4 | `--expect-red` but already green |
| 5 | `claude` CLI not on PATH |
| 6 | fixer call failed (auth/API) or timed out |
| 7 | bad setup: test command crashed or `--protect` matched nothing |
| 8 | test command timed out (process tree killed) |
| 9 | `--max-cost` reached and still red |
| 10 | exit 0 but `--pass-pattern` not in the output (no test really ran) |

**The limit:** the fixer's code runs inside your test process. The gate rules out tampering
with tests, test config and the runner, and a run with no tests in it. It cannot rule out
source that fakes the run itself (prints a fake summary) or special-cases test inputs: that
is a code review question, which is what the reviewer below is for.

`--check` runs the tests once with no fixer, for CI or a quick verdict. It still snapshots
and re-checks the protected files and the pass pattern.
Full logs go to a temp dir; the console only gets ASCII status lines.

## 2. Hooks: block what hurts, warn where the model can see it

**The gotcha this fixes:** a hook that prints a warning to stderr and exits 0 is
invisible to the model. The docs: *"Claude never sees stderr from a hook that exits 0."*
The setup this repo was extracted from warned into the void that way until this split.

So `guard.js` splits by event:

- **PreToolUse, exit 2 -> BLOCKED.** The call never runs; Claude gets the reason.
- **PostToolUse, exit 2 -> WARN.** The edit already happened; Claude gets the reason
  and fixes what it just wrote.

| Rule id | Type | What | Why it exists |
|---|---|---|---|
| `git-add-all` | block | `git add -A` / `--all` with no pathspec, or a whole-tree pathspec (`.` `*` `:/`), without `-n`/`--dry-run`; checked per chained command (`;` `&&` `\|\|` `\|` `&`), with `git -C`/`-c` prefixes | stages `.env`, keys and data dumps along with the change |
| `gpg-commit` | block | `git commit` while `commit.gpgsign=true` | the signing prompt hung the agent terminal |
| `guard-config` | block | edits to `.claude/guardrails.json`, `.claude/settings*.json` or `guard.js` itself, by Edit/Write or a shell write (Bash or PowerShell) | the agent must not switch its own guard off |
| `readonly-dir` | block | edits under a `readonly` dir, by Edit/Write or a shell write; `..` and symlinks/junctions resolved both ways ([details](docs/hooks.md)) | cloned reference repos are for reading; patterns get copied out, not patched in place |
| `secret` | block | hardcoded keys/tokens (OpenAI, Anthropic, Gemini, GitHub, Slack, Telegram, Bearer) in an edit or a shell command that writes a file; `.env` / `.env.*` exempt | a key pasted into code ends up in git history; blocked before it touches disk |
| `logger-non-ascii` | block | non-ASCII in Python `logger.*()` | emoji in a log line crashed async tasks on a cp1252 Windows VPS, 5+ times |
| `broad-except-py` | warn | `except Exception` in Python | a blanket catch hides the error you need when something breaks |
| `empty-catch-js` | warn | empty `catch {}` in JS/TS | same failure in JS: the error just disappears |
| `telegram-parse-mode` | warn | Telegram send with `&lt;` entities but no `parse_mode=HTML` | users of a scanner bot saw raw `&lt;b&gt;`, more than once |
| `unicode-win-script` | warn | Unicode arrows/dashes in `.ps1/.bat/.cmd`; a `.ps1` whose file starts with a UTF-8 BOM or carries `#Requires -Version 6+` / `-PSEdition Core` is exempt | Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles them |

Every message starts with its rule id, so turning one off is a one-line config change.
The five block rules that look at commands apply to both the **Bash** and the
**PowerShell** tool (Claude Code on Windows); how each is read: [docs/hooks.md](docs/hooks.md).

Install: copy `hooks/guard.js` to `.claude/hooks/` and merge
[`examples/settings.json`](examples/settings.json) into `.claude/settings.json`. The
PreToolUse matcher must list `PowerShell` too: a hook that matches only `Bash` never sees
the PowerShell tool, whatever the rules say.

Several machines: instead of copies that drift, keep one clone per machine at a release
tag and point the hook command at it; the tag is the version, the same tag everywhere is
in sync, and going back is checking out the old tag.

```bash
git clone https://github.com/acninvest4w-oss/claude-code-guardrails C:/tools/claude-code-guardrails
git -C C:/tools/claude-code-guardrails checkout v1.3.0      # update: fetch --tags, checkout the new tag
git -C C:/tools/claude-code-guardrails describe --tags      # what this machine runs
```

Pin a tag rather than pulling `main` on a schedule: the hook runs on every tool call, so an
auto-pull hands whoever can push to the repo code execution on every machine. Add the clone
to `readonly` (absolute paths work) so the agent cannot edit the guard's files there;
`guard-config` already covers `guard.js` itself, but not `hide.py` or a `git checkout`.

Configure per project in `.claude/guardrails.json` (optional, no code edits):

```json
{
  "disable": ["telegram-parse-mode", "logger-non-ascii"],
  "readonly": ["vendor/", "third_party/sdk"]
}
```

`readonly` entries are anchored at the project root (`$CLAUDE_PROJECT_DIR`) and match
whole path segments: `lib/` protects `<root>/lib/**`, not `src/lib/` or `mylib/`.
Absolute paths work too.

```bash
GUARDRAILS_OFF=1                          # bypass everything for one session
GUARDRAILS_READONLY=vendor/,third_party/  # extra read-only dirs, same matching
```

Adding a rule is one object in `BLOCK_RULES` or `WARN_RULES`: an `id`, the tool it
applies to, an optional file regex, and a `check` that returns a message or nothing.

Bad hook input (not JSON) or a broken config file fails open: the guard never locks you
out of your tools. A rule that throws on valid input does the opposite and stops that
call with the error, because a crash exits 1, which Claude Code treats as "go ahead".

**Windows:** each hook spawns `node` in a new console, so a window flashes on every
tool call. [`hooks/hide.py`](hooks/hide.py) runs it under `pythonw` with
`CREATE_NO_WINDOW`; see [`examples/settings.windows.json`](examples/settings.windows.json).

### Limits, in short

A seatbelt against agent mistakes, not a sandbox against an adversary.

- It reads the command string. Bash and PowerShell are tokenized like their shells,
  `cd`/`Set-Location` is followed, globs and braces are expanded against the real
  directory, and `..` and links are resolved both ways an OS may resolve them.
- Not followed: a script the agent writes and then runs, `python -c`, `$variables`,
  `eval`/`Invoke-Expression`, `xargs`, `find -delete`, .NET calls.
- Where it cannot tell (more than 8 possible directories, more than 2000 expanded names)
  it stops the call instead of guessing.
- A loop body is read twice, for its first pass and one more: a `cd` that only lands
  somewhere after three or more passes is not followed.
- For hard file boundaries, use `permissions.deny` `Edit(...)` rules and Claude Code's
  sandbox; the example settings ship both layers. An `Edit(...)` deny refuses a Write
  before the hook runs, so there the rule is the check and the hook the backstop.

The detail is in [docs/hooks.md](docs/hooks.md): how each shell is read, the bypasses under
test, how the hook sits next to permission rules and the sandbox, and the measurements.

## 3. Reviewer: builder is not reviewer

The agent that wrote the code is the worst one to review it. `reviewer.md` is a subagent
with only `Read, Grep, Glob`: it can't edit, run, or "quickly fix" anything. It checks,
in order: every acceptance criterion has code **and** a test that exercises it; correctness;
test honesty (skipped, weakened, or mocking away the thing under test); swallowed errors;
secrets and shell/SQL injection. Every finding must cite a `file:line` it read, with a
concrete failure scenario; unsure findings are marked `PLAUSIBLE`.

Install: copy to `~/.claude/agents/` (all projects) or `.claude/agents/` (one project).
Use it after the gate is green, before the commit.

## Suggested loop

```
write failing test -> test_gate.py --expect-red -> green -> reviewer -> fix P1s -> commit
                              ^ hooks guard every tool call along the way ^
```

## Development

```bash
python -m pytest -q gate/tests e2e/test_smoke_checks.py   # real pytest subprocesses, fake fixer
node --test hooks/tests/guard.test.js hooks/tests/fuzz.test.js bench/tests/replay.test.js
FUZZ_RUNS=5000 node --test hooks/tests/fuzz.test.js   # longer; FUZZ_SEED=<n> replays a failure
# real bash/pwsh, runs rm -rf: skips outside CI or a container; DIFF_SEED=<n> replays
docker run --rm -v "$PWD:/repo:ro" node:22 bash -c "cp -r /repo /w && cd /w && DIFF_RUNS=1000 node --test hooks/tests/differential.test.js"
python e2e/smoke.py --model haiku     # real claude CLI, a few cents
node bench/replay.js --root <project> ~/.claude/projects/<project-dir>   # your own false-block rate
node bench/latency.js -- node hooks/guard.js                             # your own hook cost
node bench/corpus/check_corpus.js > blocked.json                         # tldr-pages corpus: what blocks
```

The fuzz suite generates commands for both shells from a seed and checks properties rather
than cases: random text never crashes the guard; quoted text, comments, heredoc and
here-string bodies never block; benign commands chained or wrapped around a protected write
never hide it; every spelling of a protected path (quotes, escapes, `..`, `//`, case on
Windows, `\`, `/c/`, `FileSystem::`) blocks; verdicts do not depend on earlier calls.
CI runs the unit tests, the fuzz suite and the real-shell differential test on Ubuntu and
Windows on every push. The end-to-end smoke test
([`e2e/smoke.py`](e2e/smoke.py)) runs the real CLI: hooks wired into a throwaway project
with Claude asked to break each rule (verdicts read from the filesystem, the git index,
the hook's own log and the CLI's tool results, not from the model's reply; a step refused
by an `Edit(...)` deny counts only with the CLI's "denied" result for that call), then
the gate fixing a real bug with the test file checked byte-for-byte. It runs on demand via the `e2e` workflow (an `ANTHROPIC_API_KEY` secret,
the CLI version pinned in the workflow), on Ubuntu (12 checks) and Windows (16, with the
PowerShell tool), and prints the CLI version it ran.

## Tiếng Việt

Bộ 3 món dùng Claude Code cho việc thật mà không tin lời agent tự báo "xong": **test gate**
(chỉ exit code của test mới tính là xong, file test bị khoá theo byte), **hook** (chặn lỗi
đắt, cảnh báo qua PostToolUse exit 2 để model thực sự đọc được) và **reviewer** (subagent
chỉ đọc, ngữ cảnh mới). Phần lớn luật sinh ra từ sự cố thật trên dự án đang chạy. Đo lại
trên 8.917 lệnh tool thật: hook chặn nhầm 2 lần (0,02%).

## License

MIT
