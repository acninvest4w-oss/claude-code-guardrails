const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { checkPre, checkPost } = require('../guard');

const GUARD = path.join(__dirname, '..', 'guard.js');
const NO_SIGN = () => 'false';
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
  });
}

test('git add -A / --all / . is blocked, --dry-run and named files pass', () => {
  for (const cmd of ['git add -A', 'git add --all', 'git add .', 'cd x && git add -A && git commit']) {
    assert.strictEqual(checkPre(bash(cmd), {}, NO_SIGN).length, 1, cmd);
  }
  for (const cmd of ['git add -A --dry-run', 'git add src/a.py', 'git add ./src', 'git add .gitignore']) {
    assert.deepStrictEqual(checkPre(bash(cmd), {}, NO_SIGN), [], cmd);
  }
});

test('git commit is blocked only when gpgsign=true and not overridden inline', () => {
  assert.strictEqual(checkPre(bash('git commit -m x'), {}, () => 'true').length, 1);
  assert.deepStrictEqual(checkPre(bash('git commit -m x'), {}, NO_SIGN), []);
  assert.deepStrictEqual(checkPre(bash('git -c commit.gpgsign=false commit -m x'), {}, () => 'true'), []);
});

test('emoji in a Python logger call is blocked, in a print it is not', () => {
  assert.strictEqual(checkPre(write('a.py', 'logger.info("done \u2705")'), {}).length, 1);
  assert.strictEqual(checkPre(write('a.py', 'logger.info("a \u2192 b")'), {}).length, 1);
  assert.deepStrictEqual(checkPre(write('a.py', 'print("done \u2705")'), {}), []);
  assert.deepStrictEqual(checkPre(write('a.js', 'logger.info("done \u2705")'), {}), []);
});

test('read-only dirs come from GUARDRAILS_READONLY, both slash styles', () => {
  const env = { GUARDRAILS_READONLY: 'vendor/, third_party/' };
  assert.strictEqual(checkPre(write('C:\\repo\\vendor\\lib.py', 'x = 1'), env).length, 1);
  assert.strictEqual(checkPre(write('/repo/third_party/a.js', 'x'), env).length, 1);
  assert.deepStrictEqual(checkPre(write('/repo/src/a.py', 'x = 1'), env), []);
  assert.deepStrictEqual(checkPre(write('/repo/vendor/a.py', 'x = 1'), {}), []);
});

test('post: secrets, broad except, telegram parse_mode, unicode in .ps1', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  assert.match(checkPost(write('cfg.py', `KEY = "${key}"`))[0], /Anthropic/);
  assert.deepStrictEqual(checkPost(write('.env', `KEY=${key}`)), []);
  assert.match(checkPost(write('a.py', 'try:\n  x()\nexcept Exception:\n  pass'))[0], /1x/);
  assert.strictEqual(checkPost(write('b.py', 'bot.send_message(c, "&lt;b&gt;")')).length, 1);
  assert.deepStrictEqual(checkPost(write('b.py', 'bot.send_message(c, "&lt;", parse_mode="HTML")')), []);
  assert.strictEqual(checkPost(write('run.ps1', 'Write-Host "a \u2192 b"')).length, 1);
  assert.deepStrictEqual(checkPost(bash('echo sk-' + 'a'.repeat(30))), []);
});

test('MultiEdit text is checked across all edits', () => {
  const input = { tool_name: 'MultiEdit',
    tool_input: { file_path: 'a.py', edits: [{ new_string: 'x = 1' }, { new_string: 'logger.error("\u274c")' }] } };
  assert.strictEqual(checkPre(input, {}).length, 1);
});

test('process: block exits 2 with reason on stderr, clean call exits 0 silently', () => {
  const blocked = runHook({ hook_event_name: 'PreToolUse', ...bash('git add -A') });
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED/);
  const ok = runHook({ hook_event_name: 'PreToolUse', ...bash('ls') });
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout + ok.stderr, '');
});

test('process: post warning exits 2 so the model actually sees it', () => {
  const res = runHook({ hook_event_name: 'PostToolUse', ...write('a.py', 'except Exception:') });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /WARN/);
});

test('process: GUARDRAILS_OFF and bad JSON fail open', () => {
  const off = runHook({ hook_event_name: 'PreToolUse', ...bash('git add -A') }, { GUARDRAILS_OFF: '1' });
  assert.strictEqual(off.status, 0);
  const bad = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(bad.status, 0);
});
