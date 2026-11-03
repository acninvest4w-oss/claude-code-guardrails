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

// Field data (bench/replay.js): most git-add-all blocks were -A with named paths.
test('git add -A with a pathspec stages only those paths and is allowed', () => {
  for (const cmd of ['git add -A src/', 'git add -A tracker.py bot.py tests/test_x.py', 'git add --all docs',
    'git add -A -- src/a.py', 'git -C sub add -A lib/', 'git add -A --chmod +x run.sh', 'git add -A --chmod=+x run.sh']) {
    assert.deepStrictEqual(checkPre(bash(cmd), opts()), [], cmd);
    assert.deepStrictEqual(checkPre({ tool_name: 'PowerShell', tool_input: { command: cmd } }, opts()), [], `ps ${cmd}`);
  }
  for (const cmd of ['git add -A', 'git add -A .', 'git add --all :/', 'git add -A src/ .', 'git add -A -- .',
    'git add -A; git commit -m x src/a.py', 'git add -A --chmod +x', 'git add --chmod +x -A',
    'git add -A --pathspec-from-file list.txt', 'git add -A --pathspec-from-file=list.txt',
    "git add -A ':(top)'", "git add -A ':(glob)**'", "git add -A ':!secrets/'", "git add ':(top)'",
    "git add -A '**'", 'git add -A ./*']) {
    assert.strictEqual(checkPre(bash(cmd), opts()).length, 1, cmd);
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

test('differential: cd expands its glob, mkdir writes, ln makes its target writable (found by running real bash)', (t) => {
  const { linked, run } = realProject(t);
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  for (const cmd of ['cd v*; touch new.txt', 'cd v*\ndd if=/dev/null of=new.txt', 'cd ve?dor && echo x > n',
    'cd {vendor,src}; touch n', 'mkdir vendor/new', 'mkdir -p ./vendor/a/b', 'cd vendor && mkdir x',
    'ln -s vendor/new.txt n && printf y > n', 'ln vendor/a.txt x; echo y > x', 'ln -s ../vendor src/v',
    'cd vendor; ln -sf ../src/a.log']) {
    assert.ok(ids(cmd).includes('readonly-dir'), cmd);
  }
  assert.ok(ids('mkdir -p .claude/settings.json').includes('guard-config'));
  assert.ok(ids('cd .claude; ln -sf ../src/a.log settings.json').includes('guard-config'));
  if (linked) assert.ok(ids('mkdir alias/new').includes('readonly-dir'));
  for (const cmd of ['cd s*; touch new.txt', "cd 'v*'; touch n", 'mkdir -p src/new out', 'cd src && mkdir x',
    'ln -s ../src/a.log src/b.log', 'ln -sf node_modules/.bin/tool tool']) {
    assert.deepStrictEqual(run(cmd), [], cmd);
  }
});

test('differential: a loop body runs again from where it left off, & backgrounds a whole list', (t) => {
  const { root, run } = realProject(t);
  const self = path.basename(root);
  const blocked = (cmd) => run(cmd).some((m) => /^\((readonly-dir|guard-config)\)/.test(m));
  for (const cmd of ['for i in 1 2; do touch new.txt; cd vendor; done', 'while true; do rm -f *.txt; cd v*; done',
    'for i in 1 2; do (touch x); cd vendor; done', 'if true; then for i in 1; do :; done; cd vendor; fi; touch y',
    `if false; then for i in 1; do :; done; cd src; fi; touch ../${self}/vendor/x`,
    '( cd src && cat a > b & echo x > src/../vendor/new.txt )', 'cd src && make & touch vendor/x',
    // Codex round 5: a ; inside a compound does not cut the backgrounded list; prefixed loops
    'cd src && { :; } & touch vendor/x', 'cd src && if true; then :; fi & touch vendor/x',
    'time for i in 1 2; do touch x; cd vendor; done', '! for i in 1 2; do touch x; cd vendor; done',
    'time -p for i in 1 2; do touch x; cd vendor; done',
    // every command inside a compound that may be skipped may itself not run (since v1.0)
    'false && { true; cd .claude; }; touch vendor/x', 'true || { ls; cd src; ls; }; touch vendor/x',
    // Codex round 6: prefixed group, case-pattern ")", quoted keywords, cd with two operands
    'cd src && ! { :; } & touch vendor/x', '(case x in x) :;; esac; cd src); touch vendor/x',
    '( case a in (a) cd src;; esac ); touch vendor/v', "false && { :; '}'; cd src; }; touch vendor/x",
    "if false; then 'fi'; cd src; fi; touch vendor/x", 'cd src .claude; touch vendor/x',
    // Codex round 7: a quoted keyword is a command, cd under env/nohup moves nothing, a lone brace variant
    "'!' cd src; touch vendor/x", "'if' cd src; touch vendor/x", 'env cd src; touch vendor/x',
    'nohup cd src; touch vendor/x', 'touch ven{d..d}or/x']) {
    assert.ok(blocked(cmd), cmd);
  }
  for (const cmd of ['for f in a b; do cd src; ls; cd ..; done; touch x.txt', 'cd vendor && ls & touch src/x',
    'for d in src out; do (cd $d && ls); done', '{ cd vendor; ls; } & touch src/x',
    'for i in 1; do touch x; cd vendor; done', 'for i in 1 2; do cd vendor; done | cat; touch x',
    'case "$x" in a|b) echo hi ;; *) echo no ;; esac > src/log', 'cd vendor src; touch x',
    'command cd src; touch x', 'time cd src; touch x']) {
    assert.deepStrictEqual(run(cmd), [], cmd);
  }
  const ps = (command) => checkPre({ tool_name: 'PowerShell', tool_input: { command }, cwd: root },
    opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } }));
  assert.ok(ps('1,2 | ForEach-Object { Set-Content new.txt x; Set-Location vendor }').length);
  assert.ok(ps('for ($i = 0; $i -lt 2; $i++) { Set-Content new.txt x; cd vendor }').length);
  assert.ok(ps('1,2 | ForEach-Object -Begin { } -Process { Set-Content x a; Set-Location vendor }').length);
  assert.deepStrictEqual(ps('foreach ($i in 1,2) { cd src; Get-ChildItem; cd .. }'), []);
  assert.deepStrictEqual(ps('if ($true) { Set-Content new.txt x }; cd vendor'), []);
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

// PowerShell tool (Claude Code on Windows): the same block rules, PowerShell syntax.
const ps = (command, cwd) => ({ tool_name: 'PowerShell', tool_input: { command }, ...(cwd ? { cwd } : {}) });
const idsOf = (out) => out.map((m) => m.match(/^\((.+?)\)/)[1]);

test('powershell: git add -A and signed commits are checked in the PowerShell tool too', () => {
  for (const cmd of ['git add -A', 'git add .', '& git add --all', "& 'C:\\Program Files\\Git\\cmd\\git.exe' add -A",
    'Set-Location sub; git add -A', 'git status && git add .', 'git add `\n  -A', 'git.exe -C E:\\repo add :/']) {
    assert.deepStrictEqual(idsOf(checkPre(ps(cmd), opts())), ['git-add-all'], cmd);
  }
  for (const cmd of ['git add -A --dry-run', 'git add src\\a.py', 'git status', 'git add -n .',
    "Write-Output 'git add -A'", '# git add -A']) {
    assert.deepStrictEqual(checkPre(ps(cmd), opts()), [], cmd);
  }
  assert.deepStrictEqual(idsOf(checkPre(ps('git commit -m x'), opts({ gpgsign: () => 'true' }))), ['gpg-commit']);
});

test('powershell: cmdlet and alias writes into read-only dirs are blocked', () => {
  const cfg = opts({ config: { readonly: ['vendor/'] } });
  for (const cmd of [
    "Set-Content vendor\\a.py 'x'", 'Set-Content -Path vendor/a.py -Value x', 'sc -Value x -LiteralPath vendor\\a.py',
    'Add-Content -Path:vendor\\a.py x', "'x' | Out-File vendor\\log.txt", "'x' | Out-File -FilePath vendor\\l.txt -Encoding utf8",
    'Remove-Item -Recurse -Force vendor', 'rm -r vendor\\sub', 'del vendor\\a.py', 'ri vendor', 'Remove-Item src\\a.py, vendor\\b.py',
    'Copy-Item src\\a.py vendor\\', 'Copy-Item -Path src\\a.py -Destination vendor', 'cpi src\\a.py -Dest vendor\\b.py',
    'Move-Item vendor\\a.py src\\', 'mi -Path vendor -Destination old', 'Rename-Item vendor\\a.py b.py',
    'New-Item -ItemType File -Path vendor -Name x.py', 'ni vendor\\new.py', 'Clear-Content vendor\\a.py',
    "'x' | Tee-Object -FilePath vendor\\t.txt", 'echo x > vendor\\a.py', 'Get-ChildItem vendor | Remove-Item',
    'Remove-Item "vendor\\a b.py"', "Remove-Item 'vendor\\it''s.py'", 'Set-Content `\n  vendor\\a.py x',
  ]) assert.deepStrictEqual(idsOf(checkPre(ps(cmd), cfg)), ['readonly-dir'], cmd);
  for (const cmd of [
    'Get-Content vendor\\a.py > out.txt', 'Copy-Item vendor\\a.py src\\', 'Copy-Item -Path vendor\\a.py -Destination src',
    'Get-ChildItem vendor -Recurse | Select-Object Name', 'Select-String -Path vendor\\*.py -Pattern x',
    "Set-Content out.txt 'vendor'", 'Set-Content -Path out.txt -Value vendor', 'Remove-Item build -Recurse -Force',
    "Write-Host 'rm -r vendor'", "Set-Content notes.md @'\nRemove-Item vendor\ngit add -A\n'@",
    '<# Remove-Item vendor #> Get-Date', "$env:FOO = 'vendor'; Get-Item $env:FOO",
  ]) assert.deepStrictEqual(checkPre(ps(cmd), cfg), [], cmd);
});

test('powershell: the agent cannot switch the guard off from PowerShell', () => {
  for (const cmd of ['Set-Content .claude\\settings.json {}', "'{}' > .claude/guardrails.json",
    'Remove-Item .claude -Recurse', 'Copy-Item C:\\tmp\\s.json .claude\\settings.json',
    'Move-Item .claude\\settings.json saved.json', `Set-Content "${GUARD_ABS}" x`,
    'Set-Content C:\\repo\\.claude\\settings.json x']) {
    const out = checkPre(ps(cmd), opts({ env: { CLAUDE_PROJECT_DIR: cmd.includes('C:\\repo') ? 'C:\\repo' : ROOT } }));
    assert.deepStrictEqual(idsOf(out), ['guard-config'], cmd);
  }
});

test('powershell: Set-Location / Push-Location move where writes land, in any scope', (t) => {
  const { root } = realProject(t);
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const run = (cmd) => checkPre(ps(cmd, root), cfg);
  for (const cmd of ['Set-Location vendor; Set-Content a.py x', "cd vendor; 'x' > a.py", 'Push-Location vendor; ni x.py',
    '(Set-Location vendor); Set-Content a.py x', '& { cd vendor }; Set-Content a.py x', 'sl -Path vendor; ni x.py',
    'Set-Location vendor | Out-Null; ni x.py', 'Test-Path x && cd vendor; ni x.py', '$(cd vendor); ni x.py',
    'if (Test-Path vendor) { Set-Location vendor }; ni x.py', 'cd src; cd -; cd vendor; ni x.py']) {
    assert.deepStrictEqual(idsOf(run(cmd)), ['readonly-dir'], cmd);
  }
  assert.deepStrictEqual(idsOf(checkPre(ps('echo x > a.py', path.join(root, 'vendor')), cfg)), ['readonly-dir']);
  // a guard file stays reachable from a branch that may not have run
  assert.deepStrictEqual(idsOf(run('if ($false) { cd src }; Set-Content .claude\\settings.json x')), ['guard-config']);
  for (const cmd of ['Push-Location vendor; Pop-Location; ni x.py', 'Set-Location vendor; Set-Location ..; ni x.py',
    'Push-Location; Set-Location src; ni x.py', 'cd vendor; cd ..\\src; ni x.py']) {
    assert.deepStrictEqual(run(cmd), [], cmd);
  }
});

test('powershell: a secret written from PowerShell is blocked, into .env or not written it is not', () => {
  const key = 'sk-ant-' + 'q'.repeat(30);
  assert.deepStrictEqual(idsOf(checkPre(ps(`Set-Content config.py "KEY='${key}'"`), opts())), ['secret']);
  assert.deepStrictEqual(idsOf(checkPre(ps(`"${key}" | Out-File app.js`), opts())), ['secret']);
  assert.deepStrictEqual(checkPre(ps(`Add-Content .env "KEY=${key}"`), opts()), []);
  assert.deepStrictEqual(checkPre(ps(`Invoke-RestMethod -Headers @{ Authorization = "Bearer ${'t'.repeat(40)}" } x`), opts()), []);
});

// Codex design review: PowerShell binding precision.
test('powershell: wildcards, literal paths, module-qualified names, streams, pipeline input', (t) => {
  const { root } = realProject(t);
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const ids = (cmd) => idsOf(checkPre(ps(cmd, root), cfg));
  for (const [cmd, id] of [["Remove-Item -Path '.claude\\*'", 'guard-config'], ["Remove-Item '.claude\\s*.json'", 'guard-config'],
    ['Microsoft.PowerShell.Management\\Set-Content vendor\\a.txt x', 'readonly-dir'], ['git add .\\', 'git-add-all'],
    ["git add -- '-n' .", 'git-add-all'], ['Get-ChildItem -Path vendor -Filter *.log | Remove-Item', 'readonly-dir'],
    ['Set-Content -LiteralPath:vendor\\a.txt,src\\b.txt -Value x', 'readonly-dir'], ['SET-CONTENT -PA vendor\\a.txt x', 'readonly-dir'],
    ['Set-Content vendor\\a.txt -Bogus y x', 'readonly-dir'], ['Remove-Item -UnknownOpt src vendor', 'readonly-dir']]) {
    assert.deepStrictEqual(ids(cmd), [id], cmd);
  }
  for (const cmd of ["Remove-Item -LiteralPath '.claude\\*'", 'Copy-Item vendor\\a.txt src\\a.txt', 'Write-Output x 2>&1',
    "Set-Content src\\note.txt 'it`s'", 'Get-ChildItem src | Remove-Item', 'Set-Content src\\a.txt x 2>$null']) {
    assert.deepStrictEqual(ids(cmd), [], cmd);
  }
  const key = 'ghp_' + 'a'.repeat(36);
  assert.deepStrictEqual(ids(`Set-Content .env '${key}'`), []);
  assert.deepStrictEqual(ids(`Invoke-RestMethod -Headers @{ Authorization = "Bearer ${key}" } x 2>$null`), []);
  assert.deepStrictEqual(ids(`@'\nTOKEN=${key}\n'@ | Set-Content cfg.txt`), ['secret']);
});

// Codex review gate, round 1 on the PowerShell side.
test('powershell: named parameters free positional slots, blocks split commands, location binds', (t) => {
  const { root } = realProject(t);
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const ids = (cmd) => idsOf(checkPre(ps(cmd, root), cfg));
  for (const [cmd, id] of [
    ['Copy-Item -Path src\\a.log .claude\\settings.json', 'guard-config'],
    ['Rename-Item -Path .claude\\old.log settings.json', 'guard-config'],
    ["try { Set-Content .claude\\settings.json '{}' } catch { }", 'guard-config'],
    ['. { Set-Content .claude\\settings.json x }', 'guard-config'],
    ['Set-Location -Path:vendor; Set-Content a.txt x', 'readonly-dir'],
    ['Push-Location -LiteralPath vendor; ni x.txt', 'readonly-dir'],
    ['Get-ChildItem vendor | ForEach-Object { Remove-Item $_ }', 'readonly-dir'],
    ['Get-ChildItem vendor | Where-Object { $_.Length -gt 0 } | Remove-Item', 'readonly-dir'],
    ['Get-ChildItem vendor | ForEach-Object { Remove-Item $_.FullName -Force }', 'readonly-dir'],
  ]) assert.deepStrictEqual(ids(cmd), [id], cmd);
  // PowerShell wildcards match dot-names: * reaches .claude (and vendor)
  assert.ok(ids("Set-Content -Path '*\\settings.json' -Value '{}'").includes('guard-config'));
  // measured on pwsh 7.6 and Windows PowerShell 5.1: an unquoted backtick-newline separates
  // arguments, it does not join "sett" and "ings.json"
  for (const cmd of ['Set-Content -Path out.txt vendor\\a.txt', 'Add-Content src\\a.log vendor',
    'Set-Content .claude/sett`\nings.json x', 'Copy-Item -Path vendor\\a.txt src', 'Get-ChildItem src | ForEach-Object { Remove-Item $_ }']) {
    assert.deepStrictEqual(ids(cmd), [], cmd);
  }
  // "$null" is PowerShell's sink only unquoted, and only in PowerShell
  const nul = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['$null'] } });
  assert.deepStrictEqual(idsOf(checkPre(bash("rm -rf '$null'"), nul)), ['readonly-dir']);
  assert.deepStrictEqual(idsOf(checkPre(ps("Remove-Item '$null'", root), nul)), ['readonly-dir']);
  assert.deepStrictEqual(checkPre(ps('Get-Date > $null; Get-Date 2>$NULL', root), nul), []);
});

// Codex review gate, round 2.
test('powershell: pipeline sources, non-path values, wildcard locations', (t) => {
  const { root } = realProject(t);
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const ids = (cmd) => idsOf(checkPre(ps(cmd, root), cfg));
  for (const [cmd, want] of [
    ['Get-ChildItem | Remove-Item -Recurse -Force', ['guard-config', 'readonly-dir']],
    ['Get-ChildItem -Recurse -Filter settings.json | Remove-Item', ['guard-config', 'readonly-dir']],
    ['gci -r | Remove-Item', ['guard-config', 'readonly-dir']],
    ['Get-ChildItem .claude | Remove-Item', ['guard-config']],
    ['Get-Item -LiteralPath:vendor/a.txt | Remove-Item', ['readonly-dir']],
    ["'src/a.log','vendor/a.txt' | Remove-Item", ['readonly-dir']],
    ["Set-Location -Path 'vend*'; Set-Content a.txt x", ['readonly-dir']],
    ["Remove-Item -Path 'VEND*' -Recurse -Force", ['readonly-dir']],
  ]) assert.deepStrictEqual(ids(cmd), want, cmd);
  for (const cmd of ["Set-Content -Encoding utf8 out.txt 'vendor/a.txt'", 'Get-ChildItem -Filter *.log | Remove-Item',
    'Get-ChildItem .claude -Filter *.log | Remove-Item', 'Get-ChildItem src -Recurse -Include *.log | Remove-Item',
    "Set-Location -LiteralPath 'vend*'; Set-Content a.txt x", 'Out-File -Encoding utf8 out.txt vendor']) {
    assert.deepStrictEqual(ids(cmd), [], cmd);
  }
});

// Codex review gate, round 3.
test('powershell: provider-qualified paths, copies into a missing dir, -WhatIf previews', (t) => {
  const { root } = realProject(t);
  fs.mkdirSync(path.join(root, 'template'));
  fs.writeFileSync(path.join(root, 'template', 'settings.json'), '{}');
  const cfg = opts({ env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] } });
  const ids = (cmd, cwd = root) => idsOf(checkPre(ps(cmd, cwd), cfg));
  const vendorFile = path.join(root, 'vendor', 'a.txt');
  assert.deepStrictEqual(ids(`Set-Content -LiteralPath 'FileSystem::${vendorFile}' -Value x`), ['readonly-dir']);
  assert.deepStrictEqual(ids(`Remove-Item Microsoft.PowerShell.Core\\FileSystem::${vendorFile}`), ['readonly-dir']);
  assert.deepStrictEqual(ids(`Set-Location FileSystem::${path.join(root, 'vendor')}; ni x.txt`), ['readonly-dir']);
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fresh-')));
  fs.mkdirSync(path.join(fresh, 'template'));
  fs.writeFileSync(path.join(fresh, 'template', 'settings.json'), '{}');
  const freshCfg = opts({ env: { CLAUDE_PROJECT_DIR: fresh }, config: {} });
  assert.deepStrictEqual(idsOf(checkPre(ps('Copy-Item template -Destination .claude -Recurse', fresh), freshCfg)), ['guard-config']);
  for (const cmd of ['Remove-Item vendor -Recurse -WhatIf', 'Set-Content .claude\\settings.json x -WhatIf',
    'Copy-Item src\\a.log vendor -wi', 'Copy-Item template dist -Recurse', 'Copy-Item src\\a.log .']) {
    assert.deepStrictEqual(ids(cmd), [], cmd);
  }
  assert.deepStrictEqual(ids('Remove-Item vendor -Recurse -WhatIf:$false'), ['readonly-dir']);
});

// Git Bash / Cygwin spell C:\repo as /c/repo or /cygdrive/c/repo.
test('red team: Git Bash drive paths reach the same checks on a Windows project', () => {
  const win = (extra = {}) => opts({ env: { CLAUDE_PROJECT_DIR: 'C:\\repo' }, ...extra });
  const run = (command, cfg = win()) => idsOf(checkPre({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\repo' }, cfg));
  for (const cmd of ['echo x > /c/repo/.claude/settings.json', 'echo x > /C/repo/.claude/settings.json',
    'echo x > /cygdrive/c/repo/.claude/guardrails.json', 'cd /c/repo/.claude && echo x > settings.json',
    'rm -rf /c/repo/.claude', 'cp /tmp/settings.json /c/repo/.claude/',
    'echo x > /cygdrive//c/repo/.claude/settings.json', 'echo x > //c/repo/.claude/settings.json',
    'echo x > /cygdrive/[c]/repo/.claude/settings.json', 'echo x > /[bc]/repo/.claude/settings.json',
    'echo x > /?/repo/.claude/settings.json', 'cd /c && echo x > repo/.claude/settings.json']) {
    assert.deepStrictEqual(run(cmd), ['guard-config'], cmd);
  }
  const ro = win({ config: { readonly: ['vendor/', '/c/tools/guard/'] } });
  assert.deepStrictEqual(run('echo x > /c/repo/vendor/a.py', ro), ['readonly-dir']);
  assert.deepStrictEqual(run('touch C:/tools/guard/hide.py', ro), ['readonly-dir']);
  assert.deepStrictEqual(idsOf(checkPre(write('C:\\tools\\guard\\hide.py', 'x'), ro)), ['readonly-dir']);
  assert.deepStrictEqual(idsOf(checkPre(write('/c/repo/.claude/settings.json', '{}'), win())), ['guard-config']);
  for (const cmd of ['echo x > /tmp/out.txt', 'ls /dev/null > /d/data/out.txt', 'echo x > /c/repo/src/a.py',
    'cat /c/repo/.claude/settings.json > /tmp/s.json']) {
    assert.deepStrictEqual(run(cmd, ro), [], cmd);
  }
  // on a POSIX project /c/... is just a directory called c
  assert.deepStrictEqual(checkPre(bash('echo x > /c/repo/.claude/settings.json'), opts()), []);
  // in PowerShell /c/repo is \c\repo on the current drive, not C:\repo
  assert.deepStrictEqual(checkPre(ps('Set-Content /c/repo/.claude/settings.json x', 'C:\\repo'), win()), []);
  // ... but a config entry is the user's and means the drive for every tool
  assert.deepStrictEqual(idsOf(checkPre(ps('Set-Content C:\\tools\\guard\\hide.py x', 'C:\\repo'), ro)), ['readonly-dir']);
});

test('red team: Git Bash drive paths glob and cd against the real directory (Windows)', (t) => {
  if (process.platform !== 'win32') {
    t.skip('needs a drive-letter filesystem');
    return;
  }
  const { root, run } = realProject(t);
  const msys = root.replace(/^([A-Za-z]):[\\/]/, '/$1/').replace(/\\/g, '/');
  const ids = (cmd) => run(cmd).map((m) => m.match(/^\((.+?)\)/)[1]);
  assert.ok(ids(`rm -f ${msys}/.claude/*`).includes('guard-config'));
  assert.ok(ids(`rm -f /cygdrive${msys}/.claude/*`).includes('guard-config'));
  // a cd into a real dir is certain, so the old dir is not kept as a possibility
  assert.deepStrictEqual(run(`cd ${msys}/src && rm -rf *`), []);
  assert.deepStrictEqual(run(`cd ${msys}/src && echo x > settings.json`), []);
});

test('unicode-win-script: #Requires inside a here-string or block comment is not a directive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-req-'));
  const arrow = 'Write-Host "a → b"';
  for (const [name, text] of [['here.ps1', `$doc = @'\n#Requires -Version 7\n'@\n${arrow}`],
    ['block.ps1', `<#\n#Requires -Version 7\n#>\n${arrow}`]]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    assert.strictEqual(checkPost(write(p, text), opts()).length, 1, name);
  }
});

test('powershell: post rules stay edit-only, process exit codes match Bash', () => {
  assert.deepStrictEqual(checkPost(ps('Write-Host "a \u2192 b"'), opts()), []);
  const res = runHook({ hook_event_name: 'PreToolUse', ...ps('git add -A') });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /BLOCKED \(git-add-all\)/);
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', ...ps('Get-ChildItem') }).status, 0);
});

test('unicode-win-script: a .ps1 with a BOM or #Requires pwsh 6+ is exempt, .bat/.cmd are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ps1-'));
  const file = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  const arrow = 'Write-Host "a \u2192 b"';
  assert.match(checkPost(write(file('plain.ps1', arrow), arrow), opts())[0] || '', /BOM.*#Requires/);
  for (const [name, text] of [['bom.ps1', `\uFEFF${arrow}`], ['req7.ps1', `#Requires -Version 7.2\n${arrow}`],
    ['core.ps1', `#requires -PSEdition Core\n${arrow}`], ['req6.ps1', `# x\n#Requires -Version 6\n${arrow}`]]) {
    assert.deepStrictEqual(checkPost(write(file(name, text), text), opts()), [], name);
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, name), old_string: 'x', new_string: arrow } };
    assert.deepStrictEqual(checkPost(edit, opts()), [], `${name} (Edit)`);
  }
  for (const [name, text] of [['req5.ps1', `#Requires -Version 5.1\n${arrow}`], ['bom.cmd', '\uFEFFecho \u2192'],
    ['note.ps1', `# needs #Requires -Version 7 some day\n${arrow}`]]) {
    assert.strictEqual(checkPost(write(file(name, text), text), opts()).length, 1, name);
  }
});
