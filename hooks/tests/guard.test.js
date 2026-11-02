const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPre, checkPost, underDir, BLOCK_RULES, WARN_RULES } = require('../guard');
const GUARD_ABS = require.resolve('../guard');

const GUARD = path.join(__dirname, '..', 'guard.js');
const ROOT = '/repo';
const opts = (extra = {}) => ({ env: { CLAUDE_PROJECT_DIR: ROOT }, config: {}, gpgsign: () => 'false', ...extra });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
  });
}

test('git add -A / --all / . is blocked, --dry-run and named files pass', () => {
  for (const cmd of ['git add -A', 'git add --all', 'git add .', 'cd x && git add -A && git commit']) {
    assert.strictEqual(checkPre(bash(cmd), opts()).length, 1, cmd);
  }
  for (const cmd of ['git add -A --dry-run', 'git add src/a.py', 'git add ./src', 'git add .gitignore']) {
    assert.deepStrictEqual(checkPre(bash(cmd), opts()), [], cmd);
  }
});

test('git commit is blocked only when gpgsign=true and not overridden inline', () => {
  const signing = opts({ gpgsign: () => 'true' });
  assert.match(checkPre(bash('git commit -m x'), signing)[0], /^\(gpg-commit\)/);
  assert.deepStrictEqual(checkPre(bash('git commit -m x'), opts()), []);
  assert.deepStrictEqual(checkPre(bash('git -c commit.gpgsign=false commit -m x'), signing), []);
});

test('emoji in a Python logger call is blocked, in a print or a .js file it is not', () => {
  assert.strictEqual(checkPre(write('a.py', 'logger.info("done \u2705")'), opts()).length, 1);
  assert.strictEqual(checkPre(write('a.py', 'logger.info("a \u2192 b")'), opts()).length, 1);
  assert.deepStrictEqual(checkPre(write('a.py', 'print("done \u2705")'), opts()), []);
  assert.deepStrictEqual(checkPre(write('a.js', 'logger.info("done \u2705")'), opts()), []);
});

test('underDir anchors relative dirs at the project root, by whole segments', () => {
  assert.ok(underDir('/repo/lib/x.js', 'lib/', '/repo'));
  assert.ok(underDir('/repo/vendor/deep/x.py', 'vendor', '/repo'));
  assert.ok(!underDir('/repo/src/lib/x.js', 'lib/', '/repo'));
  assert.ok(!underDir('/repo/mylib/x.js', 'lib', '/repo'));
  assert.ok(!underDir('/repo/library.js', 'lib', '/repo'));
  assert.ok(!underDir('/repo/lib', 'lib', '/repo'));
  assert.ok(underDir('/repo/third_party/a/b.js', 'third_party/a', '/repo'));
});

test('underDir handles Windows paths: backslashes, drive case, absolute dirs', () => {
  assert.ok(underDir('C:\\Repo\\Vendor\\lib.py', 'vendor/', 'c:/repo'));
  assert.ok(underDir('c:/repo/vendor/lib.py', 'C:\\Repo\\Vendor', ''));
  assert.ok(!underDir('C:\\Repo\\src\\vendor\\lib.py', 'vendor', 'C:\\Repo'));
  assert.ok(underDir('/opt/shared/x.py', '/opt/shared', '/repo'));
});

test('read-only dirs come from config and GUARDRAILS_READONLY', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  assert.match(checkPre(write('/repo/vendor/a.py', 'x = 1'), cfg)[0], /^\(readonly-dir\)/);
  assert.deepStrictEqual(checkPre(write('/repo/src/vendor/a.py', 'x = 1'), cfg), []);
  const env = opts({ env: { CLAUDE_PROJECT_DIR: ROOT, GUARDRAILS_READONLY: 'third_party/' } });
  assert.strictEqual(checkPre(write('/repo/third_party/a.js', 'x'), env).length, 1);
  assert.deepStrictEqual(checkPre(write('/repo/vendor/a.py', 'x = 1'), opts()), []);
});

test('secrets are blocked before they hit disk; .env files are exempt', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  assert.match(checkPre(write('cfg.py', `KEY = "${key}"`), opts())[0], /^\(secret\).*Anthropic/);
  assert.deepStrictEqual(checkPre(write('.env', `KEY=${key}`), opts()), []);
  assert.deepStrictEqual(checkPre(write('/repo/.env.local', `KEY=${key}`), opts()), []);
  assert.strictEqual(checkPre(write('/repo/notes.env.md', key), opts()).length, 1);
  assert.deepStrictEqual(checkPost(write('cfg.py', `KEY = "${key}"`), opts()), []);
});

test('post: broad except, empty JS catch, telegram parse_mode, unicode in .ps1', () => {
  assert.match(checkPost(write('a.py', 'try:\n  x()\nexcept Exception:\n  pass'), opts())[0], /1x/);
  assert.match(checkPost(write('a.ts', 'try { x() } catch (e) {}\ntry {} catch {  }'), opts())[0], /2x empty catch/);
  assert.deepStrictEqual(checkPost(write('a.ts', 'try { x() } catch (e) { log(e) }'), opts()), []);
  assert.strictEqual(checkPost(write('b.py', 'bot.send_message(c, "&lt;b&gt;")'), opts()).length, 1);
  assert.deepStrictEqual(checkPost(write('b.py', 'bot.send_message(c, "&lt;", parse_mode="HTML")'), opts()), []);
  assert.strictEqual(checkPost(write('run.ps1', 'Write-Host "a \u2192 b"'), opts()).length, 1);
  assert.deepStrictEqual(checkPost(bash('echo sk-' + 'a'.repeat(30)), opts()), []);
});

test('config "disable" turns rules off by id', () => {
  const off = opts({ config: { disable: ['telegram-parse-mode', 'git-add-all'] } });
  assert.deepStrictEqual(checkPost(write('b.py', 'bot.send_message(c, "&lt;b&gt;")'), off), []);
  assert.deepStrictEqual(checkPre(bash('git add -A'), off), []);
  assert.strictEqual(checkPost(write('a.py', 'except Exception:'), off).length, 1);
});

test('rule ids are unique', () => {
  const ids = BLOCK_RULES.concat(WARN_RULES).map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('MultiEdit text is checked across all edits', () => {
  const input = { tool_name: 'MultiEdit',
    tool_input: { file_path: 'a.py', edits: [{ new_string: 'x = 1' }, { new_string: 'logger.error("\u274c")' }] } };
  assert.strictEqual(checkPre(input, opts()).length, 1);
});

test('process: block exits 2 with reason on stderr, clean call exits 0 silently', () => {
  const blocked = runHook({ hook_event_name: 'PreToolUse', ...bash('git add -A') });
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED \(git-add-all\)/);
  const ok = runHook({ hook_event_name: 'PreToolUse', ...bash('ls') });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout + ok.stderr, '');
});

test('process: post warning exits 2 so the model actually sees it', () => {
  const res = runHook({ hook_event_name: 'PostToolUse', ...write('a.py', 'except Exception:') });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /WARN/);
});

test('process: reads .claude/guardrails.json from the project dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'guardrails.json'),
    JSON.stringify({ readonly: ['vendor/'], disable: ['broad-except-py'] }));
  const env = { CLAUDE_PROJECT_DIR: dir };
  const ro = runHook({ hook_event_name: 'PreToolUse', ...write(path.join(dir, 'vendor', 'a.py'), 'x') }, env);
  assert.strictEqual(ro.status, 2);
  const off = runHook({ hook_event_name: 'PostToolUse', ...write(path.join(dir, 'a.py'), 'except Exception:') }, env);
  assert.strictEqual(off.status, 0);
});

test('process: bad config file fails open with a note, GUARDRAILS_OFF and bad JSON too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'guardrails.json'), '{ not json');
  const bad = runHook({ hook_event_name: 'PreToolUse', ...bash('ls') }, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(bad.status, 0);
  assert.match(bad.stderr, /ignored/);
  const off = runHook({ hook_event_name: 'PreToolUse', ...bash('git add -A') }, { GUARDRAILS_OFF: '1' });
  assert.strictEqual(off.status, 0);
  const garbage = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(garbage.status, 0);
});

// ------------------------- red team: bypass attempts -------------------------

test('red team: git add chained, flagged, quoted or via -C still blocked', () => {
  for (const cmd of [
    'git add -A --dry-run; git add -A', 'git add -n .; git add .', 'git status && git add --all',
    'git add -Av', 'git -C sub add -A', 'git -c core.x=y add .', 'git add "."', 'git add -- .',
    'git add *', 'git add :/', 'echo hi | git add -A', 'true || git add -A', 'git add -A &',
    '(git add -A)', 'x=1\ngit add -A',
  ]) assert.strictEqual(checkPre(bash(cmd), opts()).length, 1, JSON.stringify(cmd));
  for (const cmd of [
    'git add -A --dry-run', 'git add -nA', 'git add -n .', 'git add src/.env.example', 'git add ./src',
    'git add .github/ci.yml', 'echo "git add -A is bad"', 'git log --all', 'git commit -a -m x',
  ]) assert.deepStrictEqual(checkPre(bash(cmd), opts()), [], JSON.stringify(cmd));
});

test('red team: gpg check is per command, not satisfied by another command in the chain', () => {
  const signing = opts({ gpgsign: () => 'true' });
  assert.strictEqual(checkPre(bash('git -c commit.gpgsign=false log; git commit -m x'), signing).length, 1);
  assert.deepStrictEqual(checkPre(bash('git -c commit.gpgsign=false commit -m x && git push'), signing), []);
});

test('red team: ".." traversal into a read-only dir is blocked', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  for (const p of ['/repo/src/../vendor/file.py', '/repo/./vendor/x.py', 'src/../vendor/a.py',
    '/repo/a/b/../../vendor/c.py', 'C:\\repo\\src\\..\\vendor\\x.py']) {
    const winRoot = p.startsWith('C:') ? opts({ env: { CLAUDE_PROJECT_DIR: 'C:\\repo' }, config: { readonly: ['vendor/'] } }) : cfg;
    assert.strictEqual(checkPre(write(p, 'x'), winRoot).length, 1, p);
  }
  assert.deepStrictEqual(checkPre(write('/repo/vendor/../src/a.py', 'x'), cfg), []);
});

test('red team: a symlink/junction pointing into a read-only dir is blocked', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ln-')));
  fs.mkdirSync(path.join(root, 'vendor'));
  fs.mkdirSync(path.join(root, 'src'));
  try {
    fs.symlinkSync(path.join(root, 'vendor'), path.join(root, 'src', 'alias'), 'junction');
  } catch (e) {
    t.skip(`cannot create links here: ${e.code}`);
    return;
  }
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  assert.strictEqual(checkPre(write(path.join(root, 'src', 'alias', 'new.py'), 'x'), cfg).length, 1);
  assert.strictEqual(checkPre(write(path.join(root, 'src', 'alias', 'deep', 'new.py'), 'x'), cfg).length, 1);
  assert.deepStrictEqual(checkPre(write(path.join(root, 'src', 'real.py'), 'x'), cfg), []);
});

// alias -> vendor/sub: "alias/../t.js" is <root>/t.js lexically but <root>/vendor/t.js
// to a POSIX kernel, which follows the link before applying "..". Both must be checked.
test('red team: a link followed by ".." cannot climb out of the check', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ln-')));
  fs.mkdirSync(path.join(root, 'vendor', 'sub'), { recursive: true });
  try {
    fs.symlinkSync(path.join(root, 'vendor', 'sub'), path.join(root, 'alias'), 'junction');
  } catch (e) {
    t.skip(`cannot create links here: ${e.code}`);
    return;
  }
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  // built by hand: path.join would collapse the ".." before the guard sees it
  for (const p of [`${root}/alias/../target.js`, 'alias/../target.js', `${root}${path.sep}alias${path.sep}..${path.sep}x/y.js`]) {
    assert.strictEqual(checkPre(write(p, 'x'), cfg).length, 1, p);
  }
  // physically vendor/sub -> vendor -> <root>: lands outside vendor/ either way
  assert.deepStrictEqual(checkPre(write(`${root}/alias/../../out.js`, 'x'), cfg), []);
  assert.deepStrictEqual(checkPre(write(`${root}/src/../target.js`, 'x'), cfg), []);
});

test('red team: the agent cannot edit the guard, its config or hook settings', () => {
  for (const p of ['/repo/.claude/guardrails.json', '/repo/.claude/settings.json',
    '/repo/.claude/settings.local.json', '.claude/../.claude/guardrails.json', GUARD_ABS]) {
    assert.match(checkPre(write(p, '{}'), opts())[0] || '', /^\(guard-config\)/, p);
  }
  assert.deepStrictEqual(checkPre(write('/repo/.claude/agents/x.md', 'x'), opts()), []);
  assert.deepStrictEqual(checkPre(write('/repo/sub/.claude/guardrails.json', '{}'), opts()), []);
});

test('red team: shell writes into read-only dirs or guard files are blocked too', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  for (const cmd of [
    'echo x > vendor/a.py', 'echo x >>vendor/a.py', 'cat a 2> vendor/log', 'ls && echo x>"vendor/q.py"',
    'echo x | tee -a vendor/a.py', "sed -i 's/a/b/' vendor/a.py", 'sed -i.bak -e s/a/b/ vendor/a.py',
    'cp src/a.py vendor/', 'mv a.py ./vendor/b.py', 'rm -rf vendor', 'rm -rf vendor/sub', 'touch vendor/x',
    'dd if=a of=vendor/b', 'FOO=1 sudo /bin/cp a vendor/b', 'echo x > src/../vendor/a.py',
  ]) assert.match(checkPre(bash(cmd), cfg)[0] || '', /^\(readonly-dir\)/, cmd);
  for (const cmd of [
    'cat vendor/a.py > out.txt', 'cp vendor/a.py src/', 'grep -r x vendor 2>/dev/null', 'sed s/a/b/ vendor/a.py',
    'ls vendor 2>&1 | head', 'echo "a > b"', 'rm -rf build',
  ]) assert.deepStrictEqual(checkPre(bash(cmd), cfg), [], cmd);
  for (const cmd of ['echo {} > .claude/guardrails.json', "sed -i 's/x//' .claude/settings.json",
    `cp /tmp/x "${GUARD_ABS}"`]) {
    assert.match(checkPre(bash(cmd), opts())[0] || '', /^\(guard-config\)/, cmd);
  }
});

test('red team: a secret written through the shell is blocked, a .env target or no write is not', () => {
  const key = 'sk-ant-' + 'z'.repeat(30);
  assert.match(checkPre(bash(`echo KEY=${key} > config.py`), opts())[0] || '', /^\(secret\)/);
  assert.match(checkPre(bash(`printf "${key}" | tee app.js`), opts())[0] || '', /^\(secret\)/);
  assert.deepStrictEqual(checkPre(bash(`echo KEY=${key} >> .env`), opts()), []);
  assert.deepStrictEqual(checkPre(bash('echo ok > out.txt'), opts()), []);
});

// Codex review round 1: shell semantics the first parser missed.
test('red team: relative shell targets follow cd and the tool cwd', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  const inDir = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
  assert.match(checkPre(bash('cd vendor && echo changed > a.py'), cfg)[0] || '', /^\(readonly-dir\)/);
  assert.match(checkPre(bash("cd .claude && printf '{}' > settings.json"), opts())[0] || '', /^\(guard-config\)/);
  assert.match(checkPre(inDir('echo x > a.py', '/repo/vendor'), cfg)[0] || '', /^\(readonly-dir\)/);
  assert.deepStrictEqual(checkPre(bash('cd vendor && cat a.py > /tmp/out.txt'), cfg), []);
});

test('red team: mv sources, rm of a parent dir and cp into a dir are checked', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  for (const cmd of ['mv vendor/a.py scratch.py', 'rm -rf .']) {
    assert.ok(checkPre(bash(cmd), cfg).some((m) => m.startsWith('(readonly-dir)')), cmd);
  }
  for (const cmd of ['mv .claude/settings.json saved.json', 'rm -rf .claude',
    'cp /tmp/settings.json .claude/', 'cp -t .claude /tmp/settings.json', 'cp -r /tmp/.claude .']) {
    assert.match(checkPre(bash(cmd), opts())[0] || '', /^\(guard-config\)/, cmd);
  }
  for (const cmd of ['rm -rf build', 'mv src/a.py src/b.py', 'cp a.txt .', 'cp -r src dist', 'rm -rf build/*',
    'rm -f *.log', 'mv tmp/*.json data/', 'rm -rf .pytest_cache', 'cp .env.example .env', 'tar czf b.tgz vendor']) {
    assert.deepStrictEqual(checkPre(bash(cmd), cfg), [], cmd);
  }
});

test('red team: quoting, escapes, comments and heredocs are parsed like a shell', () => {
  const spaced = opts({ config: { readonly: ['vendor data/'] } });
  assert.match(checkPre(bash('touch "vendor data/a.py"'), spaced)[0] || '', /^\(readonly-dir\)/);
  assert.match(checkPre(bash('touch vendor\\ data/a.py'), spaced)[0] || '', /^\(readonly-dir\)/);
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  assert.match(checkPre(bash("sed -i 's|a|b|' vendor/x.py"), cfg)[0] || '', /^\(readonly-dir\)/);
  assert.match(checkPre(bash('echo $(rm -rf vendor)'), cfg)[0] || '', /^\(readonly-dir\)/);
  for (const cmd of ["echo 'x > vendor/a.py'", 'echo x # > vendor/a.py', "sed -i -e '/vendor/p' src/a.txt",
    "cat > notes.md <<'EOF'\nrm -rf vendor\ngit add -A\nEOF\necho done"]) {
    assert.deepStrictEqual(checkPre(bash(cmd), cfg), [], cmd);
  }
});

test('red team: git add parsing knows quoted names and "--"', () => {
  for (const cmd of ['"git" add -A', 'git add -- . -n', "'git' -C sub add .", 'git add ..']) {
    assert.strictEqual(checkPre(bash(cmd), opts()).length, 1, cmd);
  }
  assert.deepStrictEqual(checkPre(bash('git add -n -- .'), opts()), []);
});

test('red team: the .env exemption follows where the write really lands', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-env-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'config.txt'), '');
  try {
    fs.symlinkSync(path.join(root, 'src', 'config.txt'), path.join(root, '.env'));
  } catch (e) {
    t.skip(`cannot create links here: ${e.code}`);
    return;
  }
  const key = 'sk-' + 'a'.repeat(30);
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root } });
  assert.match(checkPre(write(path.join(root, '.env'), key), cfg)[0] || '', /^\(secret\)/);
  assert.match(checkPre({ tool_name: 'Bash', tool_input: { command: `printf ${key} > .env` }, cwd: root }, cfg)[0] || '',
    /^\(secret\)/);
});

// Codex review round 2.
function realProject(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-glob-')));
  for (const d of ['vendor', '.claude', 'src']) fs.mkdirSync(path.join(root, d));
  for (const f of ['vendor/a.txt', 'vendor/x.log', '.claude/settings.json', '.claude/old.log', 'src/a.log']) {
    fs.writeFileSync(path.join(root, f), '');
  }
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'vendor'), path.join(root, 'alias'), 'junction');
  } catch (e) {
    linked = false;
    t.diagnostic(`no links here: ${e.code}`);
  }
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const run = (command) => checkPre({ tool_name: 'Bash', tool_input: { command }, cwd: root }, cfg);
  return { root, linked, run };
}

test('red team: globs are expanded against the real directory, quoted ones are literal', (t) => {
  const { linked, run } = realProject(t);
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  for (const cmd of ['rm -rf *', 'rm -f vendor/*.log', 'rm -rf v*', 'touch vend?r/new']) {
    assert.ok(ids(cmd).includes('readonly-dir'), cmd);
  }
  assert.ok(ids('rm -rf .claude/*').includes('guard-config'));
  if (linked) assert.ok(ids('mv alias*/a.txt /tmp/').includes('readonly-dir'));
  for (const cmd of ['rm -f .claude/*.log', 'rm -f *.log', 'rm -f src/*.log', "touch '*'",
    "printf note > '*'", 'touch \\*', 'rm -f *.nomatch']) {
    assert.deepStrictEqual(run(cmd), [], cmd);
  }
});

test('red team: cwd follows the shell exactly -- subshells, pipelines, pushd/popd, cd -', () => {
  const guarded = (cmd) => checkPre(bash(cmd), opts()).some((m) => m.startsWith('(guard-config)'));
  for (const cmd of ['cd /tmp > .claude/settings.json', '(cd /tmp); printf x > .claude/settings.json',
    'pushd /tmp; popd; printf x > .claude/settings.json', 'cd /tmp; cd -; printf x > .claude/settings.json',
    'echo $(cd /tmp) > .claude/settings.json', 'cd /tmp | true; printf x > .claude/settings.json',
    'if cd .claude; then printf x > settings.json; fi', '{ cd .claude; printf x > settings.json; }']) {
    assert.ok(guarded(cmd), cmd);
  }
});

test('red team: a cd that may be skipped or fail keeps the old dir possible', (t) => {
  const { root, run } = realProject(t);
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  for (const cmd of ['(cd /tmp); (printf x > .claude/settings.json)', '{ cd /tmp; true; } & wait; printf x > .claude/settings.json',
    '{ cd /tmp; true; } | cat; printf x > .claude/settings.json', `pushd ${root}/src; pushd; printf x > .claude/settings.json`,
    'cd /definitely-missing-guard-dir; printf x > .claude/settings.json', 'false && cd src; printf x > .claude/settings.json',
    'cd src || exit 1; printf x > ../.claude/settings.json', 'env -C .claude tee settings.json </dev/null',
    'env --chdir=.claude tee settings.json']) {
    assert.ok(ids(cmd).includes('guard-config'), cmd);
  }
  // a cd into a dir that exists, not in a condition, is certain: no false hits from the old dir
  for (const cmd of ['cd vendor; cd ../src && echo x > a.py', '(cd vendor && ls) > out.txt',
    'cd src && echo x > settings.json', 'cd src; rm -rf *']) {
    assert.deepStrictEqual(run(cmd), [], cmd);
  }
});

test('red team: ANSI-C unicode/octal, env long options, POSIX classes, quoted commas', (t) => {
  const { run } = realProject(t);
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  for (const cmd of ["printf x > $'\\u002eclaude/settings.json'", "printf x > $'\\056claude/settings.json'",
    "printf x > $'\\U0000002eclaude/settings.json'", 'rm -f .claude/[[:lower:]]*.json', 'rm -f .claude/[!x]*.json']) {
    assert.ok(ids(cmd).includes('guard-config'), cmd);
  }
  assert.ok(ids('env --unset FOO git add -A').includes('git-add-all'));
  assert.ok(ids('sudo --user root git add .').includes('git-add-all'));
  assert.ok(!ids('rm -rf .{claude","x}').includes('guard-config'));
  assert.ok(!ids("rm -rf .{claude',x'}").includes('guard-config'));
});

// Codex review round 4.
test('red team: cd into a file, conditional bodies, group-local cd, too many dirs', (t) => {
  const { root, run } = realProject(t);
  fs.writeFileSync(path.join(root, 'README.md'), '');
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  for (const cmd of ['cd README.md; printf x > .claude/settings.json',
    'if false; then cd /tmp; fi; printf x > .claude/settings.json',
    'for d in a; do cd /tmp; done; printf x > .claude/settings.json',
    'while false; do cd src; done; printf x > .claude/settings.json']) {
    assert.ok(ids(cmd).includes('guard-config'), cmd);
  }
  assert.ok(ids('{ cd vendor; touch new.txt; } | cat').includes('readonly-dir'));
  assert.ok(ids('{ cd vendor; touch new.txt; } &').includes('readonly-dir'));
  const many = Array.from({ length: 9 }, (_, k) => `false && cd /guard-d${k};`).join(' ');
  assert.ok(ids(`${many} true && cd .claude; printf x > settings.json`).includes('parse-error'));
});

test('red team: NUL in $\'...\', absolute wrapper paths, brace sequences', (t) => {
  const { root, run } = realProject(t);
  for (const d of ['vendor1', 'vendor2']) fs.mkdirSync(path.join(root, d));
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  assert.ok(ids("printf x > $'.claude/settings.json\\000ignored'").includes('guard-config'));
  assert.ok(ids("printf x > $'.claude/settings.json\\x00ignored\\''").includes('guard-config'));
  assert.ok(ids('/usr/bin/env tee .claude/settings.json </dev/null').includes('guard-config'));
  assert.ok(ids('/usr/bin/env -C .claude tee settings.json').includes('guard-config'));
  assert.ok(ids('/usr/bin/sudo git add -A').includes('git-add-all'));
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor1/'] } });
  const seq = (cmd) => checkPre({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: root }, cfg);
  assert.ok(seq('touch vendor{1..2}/new.txt').length > 0);
  assert.ok(seq('touch vendor{0..9..1}/new.txt').length > 0);
  assert.deepStrictEqual(seq('touch out{1..3}.txt vendor{2..2}/x'), []);
});

test('red team: runaway brace/glob expansion stops the call quickly', () => {
  const started = Date.now();
  const out = checkPre(bash(`touch ${'{a,b}'.repeat(25)}`), opts());
  assert.match(out[0] || '', /^\(parse-error\).*too large/);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test('red team: target-directory spellings, ANSI-C quotes, wrapper options', () => {
  const guarded = (cmd) => checkPre(bash(cmd), opts()).some((m) => m.startsWith('(guard-config)'));
  for (const cmd of ['cp --target-directory .claude /tmp/settings.json', 'cp -t.claude /tmp/settings.json',
    'cp -rt .claude /tmp/settings.json', "printf x > $'.claude/settings.json'",
    "printf x > $'.claude/settings\\x2ejson'", "printf x > $\".claude/settings.json\""]) {
    assert.ok(guarded(cmd), cmd);
  }
  for (const cmd of ['command -- git add -A', 'env -- git add -A', 'sudo -u root git add -A',
    'env -i FOO=1 git add -A', 'nice -n 5 git add .', 'if git add -A; then :; fi']) {
    assert.strictEqual(checkPre(bash(cmd), opts()).length, 1, cmd);
  }
});

test('red team: brace expansion is applied, quoted braces are literal', () => {
  const guarded = (cmd) => checkPre(bash(cmd), opts()).some((m) => m.startsWith('(guard-config)'));
  for (const cmd of ['rm -rf .{claude,x}', 'printf x > .claude/{settings,y}.json', 'rm -rf {a,{b,.claude}}',
    'touch {z,.claude/settings.json}']) {
    assert.ok(guarded(cmd), cmd);
  }
  // bash: {x}{.claude/settings.json,z} -> "{x}.claude/settings.json", a different dir
  for (const cmd of ["rm -rf '.{claude,x}'", 'rm -rf .\\{claude,x}', 'touch {a,b}.txt', 'rm -rf {x}',
    'touch {x}{.claude/settings.json,z}']) {
    assert.ok(!guarded(cmd), cmd);
  }
});

test('red team: a check that throws stops the call instead of crashing the hook', () => {
  const out = checkPre(bash("touch '['; touch '[a'; printf x > .claude/settings.json"), opts());
  assert.ok(out.some((m) => m.startsWith('(guard-config)')), JSON.stringify(out));
  const res = runHook({ hook_event_name: 'PreToolUse', ...bash("touch '['; printf x > .claude/settings.json") });
  assert.strictEqual(res.status, 2, res.stderr);
  assert.deepStrictEqual(checkPre(bash('touch [ [a'), opts()), []);
  BLOCK_RULES.push({ id: 'boom', tool: 'Bash', check: () => { throw new Error('bug'); } });
  try {
    assert.match(checkPre(bash('ls'), opts())[0] || '', /^\(boom\) could not check this call \(bug\)/);
  } finally {
    BLOCK_RULES.pop();
  }
});

test('red team: the secret check also covers Edit and MultiEdit text', () => {
  const key = 'ghp_' + 'b'.repeat(36);
  const edit = { tool_name: 'Edit', tool_input: { file_path: 'a.js', old_string: 'x', new_string: `t="${key}"` } };
  const multi = { tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: [{ new_string: 'ok' }, { new_string: key }] } };
  assert.match(checkPre(edit, opts())[0], /GitHub PAT/);
  assert.match(checkPre(multi, opts())[0], /GitHub PAT/);
});
