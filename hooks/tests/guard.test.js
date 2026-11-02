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

test('red team: the agent cannot edit the guard, its config or hook settings', () => {
  for (const p of ['/repo/.claude/guardrails.json', '/repo/.claude/settings.json',
    '/repo/.claude/settings.local.json', '.claude/../.claude/guardrails.json', GUARD_ABS]) {
    assert.match(checkPre(write(p, '{}'), opts())[0] || '', /^\(guard-config\)/, p);
  }
  assert.deepStrictEqual(checkPre(write('/repo/.claude/agents/x.md', 'x'), opts()), []);
  assert.deepStrictEqual(checkPre(write('/repo/sub/.claude/guardrails.json', '{}'), opts()), []);
});

test('red team: the secret check also covers Edit and MultiEdit text', () => {
  const key = 'ghp_' + 'b'.repeat(36);
  const edit = { tool_name: 'Edit', tool_input: { file_path: 'a.js', old_string: 'x', new_string: `t="${key}"` } };
  const multi = { tool_name: 'MultiEdit', tool_input: { file_path: 'a.js', edits: [{ new_string: 'ok' }, { new_string: key }] } };
  assert.match(checkPre(edit, opts())[0], /GitHub PAT/);
  assert.match(checkPre(multi, opts())[0], /GitHub PAT/);
});
