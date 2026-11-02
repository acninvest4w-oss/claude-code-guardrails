const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPLAY = path.join(__dirname, '..', 'replay.js');

// A fake project with one transcript; returns the parsed summary and the --show text.
function replay(calls) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'guardrails.json'), JSON.stringify({ readonly: ['vendor/'] }));
  const lines = calls.map(([name, input]) => JSON.stringify({ cwd: root,
    message: { content: [{ type: 'tool_use', name, input }] } }));
  const dir = path.join(root, 'transcripts');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 's.jsonl'), `${lines.join('\n')}\n{"torn`);
  const r = spawnSync(process.execPath, [REPLAY, '--show', '--root', root, dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const at = r.stdout.indexOf('{\n');
  return { stats: JSON.parse(r.stdout.slice(at)), shown: r.stdout.slice(0, at) };
}

test('replay: a call counts once, a refused call gets no post warnings, keys never shown', () => {
  const letters = `sk-${'q'.repeat(40)}`; // matches the guard's OpenAI pattern, no digit in it
  const { stats, shown } = replay([
    ['Write', { file_path: 'vendor/a.py', content: `KEY = "${letters}"\ntry:\n  x()\nexcept Exception:\n  pass` }],
    ['Write', { file_path: 'src/b.py', content: 'try:\n  x()\nexcept Exception:\n  pass' }],
    ['Bash', { command: `echo ${letters} > out.txt` }],
    ['Bash', { command: 'git status' }],
  ]);
  assert.strictEqual(stats.calls, 4);
  assert.strictEqual(stats.blockedCalls, 2); // two rules on the first call, one on the third
  assert.deepStrictEqual(stats.blockedByRule, { 'readonly-dir': 1, secret: 2 });
  assert.deepStrictEqual(stats.warningsByRule, { 'broad-except-py': 1 }); // only the allowed write
  assert.ok(!shown.includes('qqqqqqqq'), shown);
  assert.match(shown, /BLOCK Bash/);
});
