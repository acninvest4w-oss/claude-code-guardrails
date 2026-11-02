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
| `git-add-all` | block | `git add -A` / `--all` / `.` / `*` / `:/` without `-n`/`--dry-run`, checked per chained command (`;` `&&` `\|\|` `\|` `&`), with `git -C`/`-c` prefixes | stages `.env`, keys and data dumps along with the change |
| `gpg-commit` | block | `git commit` while `commit.gpgsign=true` | the signing prompt hung the agent terminal |
| `guard-config` | block | edits to `.claude/guardrails.json`, `.claude/settings*.json` or `guard.js` itself, by Edit/Write or a shell write (Bash or PowerShell) | the agent must not switch its own guard off |
| `readonly-dir` | block | edits under a `readonly` dir, by Edit/Write or a shell write; `..` and symlinks/junctions resolved both ways (see below) | cloned reference repos are for reading; patterns get copied out, not patched in place |
| `secret` | block | hardcoded keys/tokens (OpenAI, Anthropic, Gemini, GitHub, Slack, Telegram, Bearer) in an edit or a shell command that writes a file; `.env` / `.env.*` exempt | a key pasted into code ends up in git history; blocked before it touches disk |
| `logger-non-ascii` | block | non-ASCII in Python `logger.*()` | emoji in a log line crashed async tasks on a cp1252 Windows VPS, 5+ times |
| `broad-except-py` | warn | `except Exception` in Python | a blanket catch hides the error you need when something breaks |
| `empty-catch-js` | warn | empty `catch {}` in JS/TS | same failure in JS: the error just disappears |
| `telegram-parse-mode` | warn | Telegram send with `&lt;` entities but no `parse_mode=HTML` | users of a scanner bot saw raw `&lt;b&gt;`, more than once |
| `unicode-win-script` | warn | Unicode arrows/dashes in `.ps1/.bat/.cmd`; a `.ps1` whose file starts with a UTF-8 BOM or carries `#Requires -Version 6+` / `-PSEdition Core` is exempt | Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles them |

Every message starts with its rule id, so turning one off is a one-line config change.
The five block rules that look at commands apply to both the **Bash** and the
**PowerShell** tool (Claude Code on Windows), see below.

Install: copy `hooks/guard.js` to `.claude/hooks/` and merge
[`examples/settings.json`](examples/settings.json) into `.claude/settings.json`. The
PreToolUse matcher must list `PowerShell` too: a hook that matches only `Bash` never sees
the PowerShell tool, whatever the rules say.

Several machines: instead of copies that drift, keep one clone per machine at a release
tag and point the hook command at it; the tag is the version, the same tag everywhere is
in sync, and going back is checking out the old tag.

```bash
git clone https://github.com/acninvest4w-oss/claude-code-guardrails C:/tools/claude-code-guardrails
git -C C:/tools/claude-code-guardrails checkout v1.1.0      # update: fetch --tags, checkout the new tag
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

### What this is not

A seatbelt against agent mistakes, not a sandbox against an adversary.

- It reads `Edit`/`Write`/`MultiEdit` input and the Bash **command string**. Bash is
  tokenized like a shell (`''`, `""`, `$''` quotes, escapes, comments, heredoc bodies
  skipped, `if`/`{` keywords, `sudo`/`env`/`command` wrappers with their options).
  Relative paths follow the shell's real directory: literal `cd`, `cd -`, `pushd`/`popd`,
  `env -C`, with `( )`, `$( )`, pipelines, `&` jobs and piped/backgrounded `{ }` groups not
  moving the parent. A `cd` that may be skipped (after `&&`/`||`, inside `if`/`for`/
  `while`/`case`) or fail (target not a directory) keeps the old directory possible too,
  and a write is checked against every possibility. This approximates bash, it does not
  run it: where the outcome depends on exit statuses or loop counts, the guard keeps
  every candidate directory, and past 8 candidates it stops the call instead of guessing. It finds what these
  write or remove: redirects, `tee`, `touch`, `truncate`, `sed -i`, `dd of=`, `rm`/`rmdir`
  (and their parent dirs: `rm -rf .claude`), `mv` sources and destinations, `cp`/`install`/
  `ln` into a dir (`cp x .claude/`, `-t`/`--target-directory`). Globs are expanded against
  the real directory like bash does (`rm *.log` is fine, `rm -rf *` at the root is not,
  a quoted `'*'` is a literal name), braces `{a,b}` and `{1..3}` too; past 2000 expanded
  names the call is stopped rather than checked partially. It does not follow a script the agent writes and then
  runs, `python -c`, `$variables` (`cd $DIR`), `eval`, `bash <<EOF`, `xargs` or `find -delete`.
  For hard file boundaries use `permissions.deny` (e.g. `Edit(./vendor/**)`)
  and Claude Code's sandbox; this hook adds the *explanation* the model needs to stop retrying.
- The **PowerShell** tool's command is rewritten into the same tokens before parsing:
  `\` is a path separator, the backtick is the escape and the line continuation, `''`/`""`
  escape quotes, here-string bodies and `<# #>` comments are data, smart quotes are quotes.
  It finds what `Set-Content`/`Add-Content`/`Clear-Content`/`Out-File`/`Tee-Object`/
  `Export-Csv`/`Set-Item`, `New-Item` (with `-Name`), `Remove-Item`, `Copy-Item` (destination
  only: copying *out* of a read-only dir is fine), `Move-Item` and `Rename-Item` write or
  remove, under their default aliases (`sc`, `ni`, `ri`, `del`, `cpi`, `mi`, `ren`, ...), plus
  redirects. Parameters bind like PowerShell does: any case, unique prefixes (`-Dest`),
  `-Path:x`, comma lists, positionals filling the slots not given by name
  (`Copy-Item -Path a .claude\settings.json` writes the second one); `-Path` globs even when
  quoted and matches dot-names, `-LiteralPath` never; `FileSystem::` prefixes are
  stripped; a copy into a destination that does not exist yet counts as creating that whole
  tree; `-WhatIf` previews are let through. An unknown parameter is taken as a
  switch, so its value is checked as a path too. Commands inside `{ }` blocks (`try`, `if`,
  `ForEach-Object`, `. { }`) are checked like any other, and a cmdlet fed by a pipeline
  with no path, or with `$_`, is judged by the paths upstream
  (`Get-ChildItem vendor | ForEach-Object { Remove-Item $_ }`): a listing cmdlet hands
  down what it lists (its paths or the current location, narrowed by `-Filter`/`-Include`
  unless `-Recurse`). The guard does not walk a tree, so `Get-ChildItem -Recurse -Include
  *.tmp | Remove-Item` at the project root is stopped (it reaches `.claude`); give it the
  subdirectory (`Get-ChildItem build -Recurse ...`). The location is per session in PowerShell, so
  `Set-Location`/`Push-Location`/`Pop-Location` move it even inside `( )`, `$( )`,
  `& { }` and pipelines; inside any `{ }` block, after `&&`/`||` or in a pipeline the old
  location stays possible too. Not followed: `$variables` and splatting, `Invoke-Expression`,
  `.NET` calls (`[IO.File]::WriteAllText`), `Start-Process`, jobs and remoting, and aliases
  or functions defined outside the command.
- Paths are judged both ways an OS may resolve them: `..` first, then links (Windows,
  `path.resolve`), and links first, then `..` (a POSIX kernel: with `alias -> vendor/sub`,
  `alias/../x` is `vendor/x`). If either lands in a protected place, the call is blocked.
  On a project with a drive root, Git Bash/MSYS/Cygwin spellings (`/c/repo/x`,
  `/cygdrive/c/repo/x`) in Bash commands and in `readonly` entries are the same `C:\repo\x`;
  in PowerShell `/c/x` stays `\c\x` on the current drive, as PowerShell reads it.
- A Bash command that carries a token *and* writes a file is blocked, e.g.
  `curl -H "Authorization: Bearer ..." > out.json`. Put the token in an env var.
- `GUARDRAILS_OFF` / `GUARDRAILS_READONLY` come from the environment Claude Code was
  started with. An `export` inside the agent's Bash tool does not reach the hook.
- Fail-open on unreadable input is deliberate: a guard that blocked every tool call
  whenever something looked odd would be switched off by its user within a day.

Bypass attempts are tested in [`hooks/tests/guard.test.js`](hooks/tests/guard.test.js)
("red team"): `..` traversal, junction/symlink into a read-only dir, a link followed by
`..`, shell writes (`echo > vendor/x`, `cd vendor && ...`, `sed -i 's|a|b|'`, `mv` out,
`rm -rf .claude`, `cp x .claude/`, quoted paths with spaces, `cd /tmp > file`,
`(cd /tmp); ...`, `pushd`/`popd`, `$'...'`, a glob through a symlink), `git add -A
--dry-run; git add -A`, `"git" add -A`, `command -- git add -A`, `git add -- . -n`, a
`.env` symlink into source, edits to the guard's own config. The PowerShell side gets the
same treatment (`& 'C:\...\git.exe' add -A`, `Set-Content E:\repo\.claude\settings.json`,
`(Set-Location vendor); ...`, `& { cd vendor }; ...`, quoted globs, alias spellings,
module-qualified cmdlets). A sweep of everyday commands (`rm -f *.log`,
`cp .env.example .env`, heredocs, `2>&1`, `Copy-Item vendor\a src\`, here-strings,
`2>$null`) checks that none are blocked.

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
python e2e/smoke.py --model haiku     # real claude CLI, a few cents
```

CI runs the unit tests on Ubuntu and Windows on every push. The end-to-end smoke test
([`e2e/smoke.py`](e2e/smoke.py)) runs the real CLI: hooks wired into a throwaway project
with Claude asked to break each rule (verdicts read from the filesystem and git index,
not from the model's reply), then the gate fixing a real bug with the test file checked
byte-for-byte. It runs on demand via the `e2e` workflow with an `ANTHROPIC_API_KEY` secret.

## Tiếng Việt

Bộ 3 món dùng Claude Code cho việc thật mà không tin lời agent tự báo "xong": **test gate**
(chỉ exit code của test mới tính là xong, file test bị khoá theo byte), **hook** (chặn lỗi
đắt, cảnh báo qua PostToolUse exit 2 để model thực sự đọc được) và **reviewer** (subagent
chỉ đọc, ngữ cảnh mới). Phần lớn luật sinh ra từ sự cố thật trên dự án đang chạy.

## License

MIT
