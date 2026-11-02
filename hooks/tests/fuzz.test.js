// Seeded fuzz tests for the Bash and PowerShell readers. No dependencies.
// FUZZ_SEED=<n> reproduces a run (the seed is printed on failure); FUZZ_RUNS=<n> runs longer.
const test = require('node:test');
const assert = require('node:assert');
const { checkPre } = require('../guard');

const SEED = Number(process.env.FUZZ_SEED) || Date.now() % 1e9;
const RUNS = Number(process.env.FUZZ_RUNS) || 300;

// mulberry32: small, fast, good enough to spread inputs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNOWN = /^\((git-add-all|gpg-commit|guard-config|readonly-dir|secret|logger-non-ascii|parse-error)\) /;
const POSIX = { env: { CLAUDE_PROJECT_DIR: '/repo' }, config: { readonly: ['vendor/'] }, gpgsign: () => 'false' };
const WIN = { env: { CLAUDE_PROJECT_DIR: 'C:\\repo' }, config: { readonly: ['vendor/'] }, gpgsign: () => 'false' };
const call = (tool, command, cwd) => ({ tool_name: tool, tool_input: { command }, ...(cwd ? { cwd } : {}) });
const ids = (out) => out.map((m) => m.match(/^\((.+?)\)/)[1]);

// Runs `body(r, i)` RUNS times with a per-case generator; a failure names the seed and case.
function fuzz(name, body) {
  test(`fuzz: ${name}`, () => {
    for (let i = 0; i < RUNS; i++) {
      const r = rng(SEED + i * 7919);
      try {
        body(r, i);
      } catch (e) {
        e.message = `${e.message}\n  reproduce: FUZZ_SEED=${SEED} (case ${i})`;
        throw e;
      }
    }
  });
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const some = (r, list, max) => Array.from({ length: Math.floor(r() * (max + 1)) }, () => pick(r, list));

// Protected writes, each with the rule that must fire.
const BASH_WRITES = [
  ['echo x > .claude/settings.json', 'guard-config'], ['printf x >> vendor/a.txt', 'readonly-dir'],
  ['rm -rf vendor', 'readonly-dir'], ['cp a.txt .claude/settings.json', 'guard-config'],
  ['sed -i s/a/b/ vendor/x.py', 'readonly-dir'], ['tee vendor/y.txt', 'readonly-dir'],
  ['git add -A', 'git-add-all'], ['touch vendor/z', 'readonly-dir'], ['mv vendor/a b', 'readonly-dir'],
  ['git add .', 'git-add-all'], ['rm -f .claude/guardrails.json', 'guard-config'],
];
const PS_WRITES = [
  ['Set-Content .claude\\settings.json x', 'guard-config'], ['Remove-Item vendor -Recurse', 'readonly-dir'],
  ['Copy-Item a.txt .claude\\settings.json', 'guard-config'], ['git add -A', 'git-add-all'],
  ['Out-File -FilePath vendor\\a.txt', 'readonly-dir'], ['New-Item vendor\\n.txt', 'readonly-dir'],
  ['Move-Item vendor\\a.txt b.txt', 'readonly-dir'], ['Add-Content vendor\\a.txt x', 'readonly-dir'],
  ['ni -Path vendor -Name x.txt', 'readonly-dir'], ['Set-Content -LiteralPath .claude/guardrails.json {}', 'guard-config'],
];
const BASH_NOISE = ['ls', 'git status', 'echo hi', 'cat README.md', 'true', 'pwd', 'grep -r x src', 'node -v',
  'echo "a b"', 'wc -l *.md', 'git log --oneline -3', "printf '%s\\n' x", 'ls -la src 2>/dev/null'];
const PS_NOISE = ['Get-ChildItem', 'git status', 'Write-Output hi', 'Get-Content README.md', '$x = 1',
  'Test-Path a', 'Get-Date', 'Get-ChildItem src -Filter *.js | Select-Object Name', "Write-Host 'a b'",
  'git log --oneline -3', '$null = 1', 'Get-Content a.txt 2>$null'];

// F1 -- random text: never throws, only known rule ids, both shells.
const ALPHABET = 'abcdeghilmnorstuvxyz ABCLMSRZ;&|<>()\'"`$\\{}#@,*?[]~-=/.\n\t:0129';
const TOKENS = ['git', 'add', '-A', 'cd', 'rm', '-rf', '.claude', 'vendor', 'Set-Content', 'Remove-Item',
  "@'", "'@", '<#', '#>', '$(', '&&', '||', '<<', 'EOF', 'Push-Location', 'Set-Location', '-Path:', '{', '}',
  '/c/', '/cygdrive/', 'FileSystem::', '-WhatIf', '$null', '..', '*'];
const noise = (r) => Array.from({ length: Math.floor(r() * 24) }, () => (r() < 0.6
  ? ALPHABET[Math.floor(r() * ALPHABET.length)] : ` ${pick(r, TOKENS)} `)).join('');

fuzz('random text never throws and only names known rules', (r) => {
  const text = noise(r);
  for (const [tool, opts] of [['Bash', POSIX], ['PowerShell', POSIX], ['Bash', WIN], ['PowerShell', WIN]]) {
    const out = checkPre(call(tool, text), opts);
    assert.ok(Array.isArray(out), JSON.stringify(text));
    for (const m of out) assert.match(m, KNOWN, `${tool} ${JSON.stringify(text)}`);
  }
});

// F2 -- data stays data: a protected write that is only text never blocks.
fuzz('quoted text, comments, heredoc and here-string bodies never block', (r) => {
  const [w] = pick(r, BASH_WRITES);
  for (const cmd of [`echo '${w}'`, `echo "${w}"`, `# ${w}`, `${pick(r, BASH_NOISE)} # ${w}`,
    `cat <<'EOF'\n${w}\nEOF`, `cat <<EOF > notes.md\n${w}\nEOF`]) {
    assert.deepStrictEqual(checkPre(call('Bash', cmd), POSIX), [], JSON.stringify(cmd));
  }
  const [p] = pick(r, PS_WRITES);
  for (const cmd of [`Write-Output '${p}'`, `# ${p}`, `<# ${p} #> Get-Date`, `${pick(r, PS_NOISE)} # ${p}`,
    `$doc = @'\n${p}\n'@`, `Write-Host "${p.replace(/\$/g, '`$')}"`]) {
    assert.deepStrictEqual(checkPre(call('PowerShell', cmd), POSIX), [], JSON.stringify(cmd));
  }
});

// F3 -- noise around a protected write never hides it.
const BASH_JOIN = ['; ', ' && ', ' || ', '\n', ' | '];
const PS_JOIN = ['; ', ' && ', ' || ', '\n'];
const BASH_WRAP = [(w) => w, (w) => `( ${w} )`, (w) => `{ ${w}; }`, (w) => `echo $( ${w} )`,
  (w) => `if true; then ${w}; fi`, (w) => `for i in 1; do ${w}; done`];
const PS_WRAP = [(w) => w, (w) => `& { ${w} }`, (w) => `try { ${w} } catch { $_ }`, (w) => `if ($true) { ${w} }`,
  (w) => `. { ${w} }`, (w) => `Get-Date | ForEach-Object { ${w} }`];

fuzz('benign commands around a protected write never hide it', (r) => {
  const [w, id] = pick(r, BASH_WRITES);
  const before = some(r, BASH_NOISE, 3).map((n) => n + pick(r, BASH_JOIN)).join('');
  const after = some(r, BASH_NOISE, 3).map((n) => pick(r, BASH_JOIN) + n).join('');
  const cmd = before + pick(r, BASH_WRAP)(w) + after;
  assert.ok(ids(checkPre(call('Bash', cmd), POSIX)).includes(id), JSON.stringify(cmd));

  const [p, pid] = pick(r, PS_WRITES);
  const psBefore = some(r, PS_NOISE, 3).map((n) => n + pick(r, PS_JOIN)).join('');
  const psAfter = some(r, PS_NOISE, 3).map((n) => pick(r, PS_JOIN) + n).join('');
  const psCmd = psBefore + pick(r, PS_WRAP)(p) + psAfter;
  assert.ok(ids(checkPre(call('PowerShell', psCmd), POSIX)).includes(pid), JSON.stringify(psCmd));
});

// F4 -- every spelling of a protected path lands on it.
const flipCase = (r, s) => s.split('').map((c) => (r() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');

function bashSegment(r, seg) {
  const k = r();
  if (k < 0.25) return `'${seg}'`;
  if (k < 0.5) return `"${seg}"`;
  if (k < 0.65) return seg.split('').map((c) => (r() < 0.3 ? `\\${c}` : c)).join('');
  return seg;
}

function spelling(r, segs, sep, quote) {
  const parts = [];
  if (r() < 0.3) parts.push('.');
  for (const s of segs) {
    if (r() < 0.2) parts.push('src', '..');
    if (r() < 0.15) parts.push('.');
    parts.push(quote(s));
  }
  const glue = () => (r() < 0.15 ? sep + sep : sep);
  return parts.reduce((acc, p, i) => (i ? acc + glue() + p : p), '');
}

fuzz('equivalent spellings of a protected path all block', (r) => {
  const target = pick(r, [['.claude', 'settings.json'], ['.claude', 'guardrails.json'], ['vendor', 'a.txt']]);
  const want = target[0] === 'vendor' ? 'readonly-dir' : 'guard-config';
  const bashPath = spelling(r, target, '/', (s) => bashSegment(r, s));
  const writer = pick(r, ['echo x >', 'printf x >>', 'touch', 'tee', 'rm -f', 'cp a.txt']);
  const bashCmd = `${writer} ${bashPath}`;
  assert.ok(ids(checkPre(call('Bash', bashCmd, '/repo'), POSIX)).includes(want), JSON.stringify(bashCmd));
  // Windows: drive paths compare case-insensitively, \ and / both separate, Git Bash /c/ mounts
  const winBash = `${writer} ${pick(r, ['', '/c/repo/', 'C:/repo/', '/cygdrive/c/repo/'])}${spelling(r, target.map((s) => flipCase(r, s)), '/', (s) => s)}`;
  assert.ok(ids(checkPre(call('Bash', winBash, 'C:\\repo'), WIN)).includes(want), JSON.stringify(winBash));
  const psPath = spelling(r, target.map((s) => flipCase(r, s)), pick(r, ['\\', '/']),
    (s) => (r() < 0.3 ? `'${s}'` : s));
  const psWriter = pick(r, ['Set-Content', 'Add-Content', 'Remove-Item', 'New-Item', 'Clear-Content',
    "'x' | Out-File", 'Set-Content -Path', 'Set-Content -LiteralPath']);
  const prefix = pick(r, ['', 'C:\\repo\\', 'FileSystem::C:\\repo\\']);
  const psCmd = `${psWriter} ${prefix}${psPath}${psWriter.startsWith("'") ? '' : ' x'}`;
  assert.ok(ids(checkPre(call('PowerShell', psCmd, 'C:\\repo'), WIN)).includes(want), JSON.stringify(psCmd));
});

// F5 -- the same input always gets the same verdict (no state leaks between calls).
fuzz('verdicts are deterministic across calls and tools', (r) => {
  const text = noise(r);
  const first = [checkPre(call('Bash', text), WIN), checkPre(call('PowerShell', text), POSIX)];
  checkPre(call('Bash', `${noise(r)} /c/repo/x`), WIN); // a call in between must not leak state
  assert.deepStrictEqual([checkPre(call('Bash', text), WIN), checkPre(call('PowerShell', text), POSIX)], first);
});
