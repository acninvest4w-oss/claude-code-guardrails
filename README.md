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
3. After each fixer round, diff the snapshot. Any protected file changed, added or
   deleted -> **reverted and aborted**. A `conftest.py` with `collect_ignore` counts.
4. Repeat until green or out of rounds, then hand back to a human.

How it closes the usual ways an agent "passes" tests:

- **Edits the test** -> the hash snapshot catches it, and `--disallowedTools Edit(./tests/**)`
  refuses it up front.
- **Skips/ignores the test via config** -> list the config files in `--protect`; new
  files under protected dirs count as tampering.
- **Runs something else and reports success** -> the fixer has no shell at all
  (`--tools Read,Edit,Write,Grep,Glob`, MCP servers dropped). The gate runs the tests itself.
- **Tests were never red** -> `--expect-red` fails if they pass before any fix, because
  then they don't capture the missing behaviour.
- **Broken test command** (wrong cwd, no tests collected) -> exit codes outside
  `--red-codes` abort before burning a fixer call. So does `--protect` matching nothing.
- **Auth/API failure** -> abort after one round instead of looping on an error.

The log keeps the tail plus early `Traceback`/`FAILED` lines a plain tail would cut off,
so the fixer sees the root cause and not just the summary line.

| Exit | Meaning |
|---|---|
| 0 | tests exit 0, protected files intact |
| 1 | still red after `--rounds` (human needed) |
| 3 | fixer touched protected files (reverted) |
| 4 | `--expect-red` but already green |
| 5 | `claude` CLI not on PATH |
| 6 | fixer call failed (auth/API) |
| 7 | bad setup: test command crashed or `--protect` matched nothing |

`--check` runs the tests once with no fixer, for CI or a quick verdict.
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
| `git-add-all` | block | `git add -A` / `--all` / `.` without `--dry-run` | stages `.env`, keys and data dumps along with the change |
| `gpg-commit` | block | `git commit` while `commit.gpgsign=true` | the signing prompt hung the agent terminal |
| `readonly-dir` | block | edits under a `readonly` dir | cloned reference repos are for reading; patterns get copied out, not patched in place |
| `logger-non-ascii` | block | non-ASCII in Python `logger.*()` | emoji in a log line crashed async tasks on a cp1252 Windows VPS, 5+ times |
| `secret` | warn | hardcoded keys/tokens (OpenAI, Anthropic, Gemini, GitHub, Slack, Telegram, Bearer); `.env*` skipped | a key pasted into code ends up in git history |
| `broad-except-py` | warn | `except Exception` in Python | a blanket catch hides the error you need when something breaks |
| `empty-catch-js` | warn | empty `catch {}` in JS/TS | same failure in JS: the error just disappears |
| `telegram-parse-mode` | warn | Telegram send with `&lt;` entities but no `parse_mode=HTML` | users of a scanner bot saw raw `&lt;b&gt;`, more than once |
| `unicode-win-script` | warn | Unicode arrows/dashes in `.ps1/.bat/.cmd` | Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles them |

Every message starts with its rule id, so turning one off is a one-line config change.

Install: copy `hooks/guard.js` to `.claude/hooks/` and merge
[`examples/settings.json`](examples/settings.json) into `.claude/settings.json`.

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

Bad hook input or a broken config file fails open: a bug in the guard never blocks
your tools.

**Windows:** each hook spawns `node` in a new console, so a window flashes on every
tool call. [`hooks/hide.py`](hooks/hide.py) runs it under `pythonw` with
`CREATE_NO_WINDOW`; see [`examples/settings.windows.json`](examples/settings.windows.json).

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
python -m pytest -q gate/tests        # real pytest subprocesses, fake fixer
node --test hooks/tests/guard.test.js
```

CI runs both on Ubuntu and Windows.

## Tiếng Việt

Bộ 3 món dùng Claude Code cho việc thật mà không tin lời agent tự báo "xong": **test gate**
(chỉ exit code của test mới tính là xong, file test bị khoá theo byte), **hook** (chặn lỗi
đắt, cảnh báo qua PostToolUse exit 2 để model thực sự đọc được) và **reviewer** (subagent
chỉ đọc, ngữ cảnh mới). Phần lớn luật sinh ra từ sự cố thật trên dự án đang chạy.

## License

MIT
