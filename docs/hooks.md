# guard.js in depth

The [README](../README.md#2-hooks-block-what-hurts-warn-where-the-model-can-see-it) covers
what the hook blocks and how to install it. This page is the detail: how it reads shell
commands, where it stops, how it sits next to Claude Code's own permission rules, and what
it measured on a real project.

## What this is not

A seatbelt against agent mistakes, not a sandbox against an adversary.

- It reads `Edit`/`Write`/`MultiEdit` input and the Bash **command string**. Bash is
  tokenized like a shell (`''`, `""`, `$''` quotes, escapes, comments, heredoc bodies
  skipped, `if`/`{` keywords, `sudo`/`env`/`command` wrappers with their options).
  Relative paths follow the shell's real directory: `cd` (its argument globbed like any
  word, so `cd v*` lands in `vendor`), `cd -`, `pushd`/`popd`,
  `env -C`, with `( )`, `$( )`, pipelines, `&` jobs (the whole `&&`/`||` list before the
  `&`) and piped/backgrounded `{ }` groups not moving the parent. A `cd` that may be
  skipped (after `&&`/`||`, inside `if`/`for`/`while`/`case`) or fail (target not a
  directory) keeps the old directory possible too, and a write is checked against every
  possibility. A loop body (`for`/`while`/`until`, and in PowerShell a block after `foreach`,
  `for`, `while`, `do` or `ForEach-Object`) is read twice, so a `cd` at its end reaches the
  writes at its start; a `cd` that only lands after three or more passes is not followed.
  This approximates bash, it does not run it: where the outcome depends on exit statuses
  or loop counts, the guard keeps every candidate directory, and past 8 candidates it
  stops the call instead of guessing. It finds what these
  write or remove: redirects, `tee`, `touch`, `truncate`, `mkdir`, `sed -i`, `dd of=`, `rm`/`rmdir`
  (and their parent dirs: `rm -rf .claude`), `mv` sources and destinations, `cp`/`install`/
  `ln` into a dir (`cp x .claude/`, `-t`/`--target-directory`), `mkdir`, and what `ln` links
  to (a new link is a way to write its target). Globs are expanded against
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

## Tested bypasses

Bypass attempts are tested in [`hooks/tests/guard.test.js`](../hooks/tests/guard.test.js)
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

## Checked against real shells

[`hooks/tests/differential.test.js`](../hooks/tests/differential.test.js) does not trust the
guard's own model of a shell. Each case builds a throwaway project (read-only `vendor/`, a
link `alias -> vendor`, `.claude` settings), generates a command out of `cd`/`pushd`, globs,
braces, quotes, `..`, absolute paths, subshells, `if`/`for`, pipes, background jobs and some
twenty writing commands, asks the guard, then **runs it with real bash** (Git Bash on
Windows) or **pwsh** and diffs the tree. Each project sits deeper in its sandbox than any
generated command can climb (`..` steps times loop passes), with a canary at the sandbox
root that stops the run if it is ever touched. Those limit the damage; they are not a wall
the OS enforces. So the test runs commands only where that is isolated: in CI, in a container,
or with `GUARDRAILS_DIFF_EXEC=1` on a machine you can afford to lose. Anywhere else it skips. A protected file that changed while the guard said
nothing fails the test. Commands use only what the guard claims to follow: no `$vars`,
`eval`, scripts or `~`.

It found five kinds of miss, each fixed with a regression test:

| Command (shortened) | What the guard got wrong |
|---|---|
| `cd v*; touch x` | did not glob a `cd` argument |
| `mkdir vendor/x` | `mkdir` was not counted as a write |
| `cd src && make & echo > vendor/x` | took the `cd` as moving the shell; `&` backgrounds the whole `&&` list |
| `for i in 1 2; do touch x; cd vendor; done` | read a loop body once; the second pass runs in `vendor` |
| `ln -s vendor/x y && echo > y` | a link made by the command itself, written through |

Three review rounds on those fixes by a second model (Codex) found eleven more, and the test,
widened to cover them, found one that dates back to v1.0. All fixed with a regression test:

| Command (shortened) | What the guard got wrong |
|---|---|
| `cd src && { :; } & touch vendor/x` | a `;` inside a compound cut the backgrounded list short |
| `time for ...; done`, `! for ...; done` | a prefixed loop was not read as a loop |
| `ForEach-Object -Begin { } -Process { ... }` | the `-Process` block after `-Begin` was not read as a loop body |
| `cd .claude; ln -sf ../src/settings.json` | one-operand `ln` links into the current dir under the source's name |
| `false && { true; cd .claude; }; touch vendor/x` | a command inside a compound that may be skipped counted as certain (since v1.0) |
| `cd src && ! { :; } & touch vendor/x` | a brace group after `!` was not read as a group |
| `(case x in x) :;; esac; cd src); touch vendor/x` | the `)` ending a case pattern closed the subshell |
| `false && { :; '}'; cd src; }; touch vendor/x` | a quoted `'}'` (or `'fi'`) closed the compound |
| `cd src out; touch vendor/x` | `cd` with two operands fails in bash; the guard moved to the first |
| `'!' cd src; touch vendor/x` | a quoted keyword was dropped as a keyword; bash runs a program called `!` |
| `env cd src; touch vendor/x` | a `cd` under `env`/`nohup`/`sudo` runs in a new process (and fails); it moved the guard's shell |
| `touch ven{d..d}or/x` | a brace that expands to a single word was not expanded |

Reading the parser for the loop fix also turned up a keyword after `then`/`do`/`else`
(`then for ...`) that did not open a body. After all fixes: **13,800 cases** (12,000 bash on
Linux, 1,500 Git Bash and 300 pwsh on Windows), **no protected change let through**. CI
runs a fresh seed on every push, on Ubuntu and Windows.

Two choices that block on purpose: making a link to a protected path is blocked by itself
(the link is a way to write it later), and a `for` over two or more words reads its body
twice even when the second pass would not write (`for x in one` reads it once).

On the field replay these fixes add one block: a `mkdir -p "$P"` run from inside a read-only
dir, where `$P` held an absolute path the guard does not expand.

About half the blocks in those runs touched nothing protected. That is not a false-block
rate: the generator is built to be awkward (a `cd` that may fail, a write after it, globs
that match nothing), and on those the guard keeps every possible directory and blocks. The
field rate is the [measurement below](#measured-on-a-real-project).

## Layers: permission rules and the sandbox hold the line, the hook explains

The hook is a seatbelt. Where Claude Code can enforce a boundary itself, let it, and keep
the hook for what rules cannot express and for the message that stops the model retrying.
The example settings ship both layers:

- **File boundaries -> `permissions.deny` `Edit(...)` rules.** An `Edit` deny covers every
  built-in tool that edits files (Write and MultiEdit included; `Write(...)` path rules
  never match), and Bash redirects / `tee` / `sed` that Claude Code recognises
  ([permissions](https://code.claude.com/docs/en/permissions.md#read-and-edit)). In project
  settings `/x` is the project root and `//c/x` an absolute path, also on Windows
  ([anchoring](https://code.claude.com/docs/en/permissions.md#where-a-pattern-anchors)).
  The examples deny `/.claude/settings*.json`, `/.claude/guardrails.json`,
  `/.claude/hooks/**` and the example read-only `/vendor/**`; add `//c/tools/claude-code-guardrails/**`
  (your clone) when the hook runs from a clone. Managed settings make a deny impossible
  to override from any project.
- **Shell writes -> the sandbox, where there is one.** It confines Bash and PowerShell
  commands and their children at the OS level and refuses writes to `.claude` settings,
  hooks and agents even inside writable directories
  ([sandboxing](https://code.claude.com/docs/en/sandboxing.md#settings-file-protection)).
  It runs on macOS, Linux and WSL2 only: **on native Windows commands run unsandboxed**,
  so there the hook is the only check on what a shell command writes.
- **Command rules (`Bash(...)`, `PowerShell(...)`) are tripwires, not boundaries.** They
  match text, so `git -C . push` or `bash -c '...'` slip past them, by the docs' own
  account ([what a Bash rule doesn't match](https://code.claude.com/docs/en/permissions.md#what-a-bash-rule-doesnt-match)).
  The examples add none: `git add -A` stays with the hook, which reads chains, `cd`, `-C`
  and pathspecs. If you add one on Windows with Git Bash, add the matching `PowerShell(...)`
  rule too: **any Bash deny turns the PowerShell tool off for the session, silently**
  ([tools reference](https://code.claude.com/docs/en/tools-reference.md#bash-deny-rules-also-turn-off-the-powershell-tool)).
- **The hook** keeps everything above as a second check and adds what no rule expresses.
  Order matters: a hook that exits 2 stops a Bash or PowerShell call before permission
  rules are evaluated ([permissions](https://code.claude.com/docs/en/permissions.md)), but
  an `Edit(...)` deny refuses a Write or Edit on its path before PreToolUse hooks run
  (seen with Claude Code 2.1.88): there the rule is the check, the model reads the rule's
  "denied by your permission settings", and the hook is the backstop if the rule is
  removed. What the hook adds: PowerShell cmdlet writes, `cd`/`Set-Location` tracking,
  links and `..`, secrets in content, the per-language warnings, and the reason the model
  reads.

## Measured on a real project

Replayed offline with [`bench/replay.js`](../bench/replay.js) against the transcripts of one
active Windows monorepo (318 sessions): **8,917 tool calls** (3,777 Bash, 2,151 PowerShell,
2,359 Edit, 630 Write). Every block was classified by hand; only counts are published.

| | v1.1.1 | v1.2.0 |
|---|---|---|
| calls blocked | 78 | 39 |
| false blocks | 41 (0.46%) | **2 (0.02%)** |
| true blocks | 37 | 37 |

The 39 false blocks fixed in v1.2.0 were all `git add -A <paths>`: with a pathspec `-A`
stages only those paths, and it is allowed now. The 2 left: a token-shaped test fixture
written to a scratch log (`secret`), and one long `cd a && ... && cd b && ... && cd ..`
read-only chain whose possible directories passed the cap of 8 (`parse-error`). The 37 true
blocks: non-ASCII in `logger.*()` in code that runs on a cp1252 Windows host (34), edits
of `.claude/settings.json` (2), a bare `git add -A` (1). Warnings are advisory and were
counted (for calls the hook let through), not classified: `broad-except-py` 156,
`unicode-win-script` 42, `empty-catch-js` 6.

### On a public corpus

The numbers above come from one person's transcripts, classified by that person. To give
anyone a number they can rerun, [`bench/tests/corpus.test.js`](../bench/tests/corpus.test.js)
puts all 32,692 example commands of tldr-pages v2.3 (31,410 as Bash, 1,282 as PowerShell)
through the guard in a project with a read-only `vendor/`, without executing them. 4 are
blocked, all labelled true in [`tldr-labels.json`](../bench/corpus/tldr-labels.json):
`git add -A` (twice), `git add .`, and `rmdir *` (it removes `vendor/` whenever that is
empty). 0 false blocks. On a GitHub Windows runner two more block, both labelled true:
`del /?` and `del /a ...` are cmd syntax, and read as PowerShell they name `\?` and `\a` at the
drive root, which there is `D:\a`, the project's own parent. The labels are part of the
test: a new block fails CI until someone labels it, so a parser change cannot quietly raise
the false-block rate.

The corpus measures false blocks on everyday syntax, not misses: its placeholders
(`path/to/file`) rarely name a protected path. Misses are what the
[differential test](#checked-against-real-shells) is for.

Cost per hook call, measured with [`bench/latency.js`](../bench/latency.js) on Windows 11
(i7-14700F, Node 24), process start included:

| command | p50 | p95 |
|---|---|---|
| `node guard.js` | 44-52 ms | 58-77 ms |
| `pythonw hide.py node guard.js` (no console flash) | 80-89 ms | 91-128 ms |

The check itself is 0.2 ms (p50) in process; the rest is starting the processes.
