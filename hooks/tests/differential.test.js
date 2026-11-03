// Differential tests: the real shell is the judge, not the guard's own model of it.
// Each case builds a throwaway project, asks the guard about a generated command, runs the
// command for real with bash (Git Bash on Windows) or pwsh, and diffs the tree. A protected
// file that changed while the guard said nothing is a miss and fails the test; a block with
// no protected change is counted as an over-block and only reported.
// DIFF_SEED=<n> reproduces a run, DIFF_RUNS=<n> sets the bash cases (pwsh runs a fifth),
// DIFF_BASH=<path> picks the bash. Generated commands never use $vars, eval, bash -c,
// scripts, xargs or ~: what the README lists as not followed is not tested here.
//
// IT RUNS `rm -rf *` FOR REAL. It does so only where that is isolated: in CI (a throwaway VM),
// in a container, or with GUARDRAILS_DIFF_EXEC=1 on a machine you can afford to lose.
// Elsewhere it skips. On a developer machine run it in a container:
//   docker run --rm -v "$PWD:/repo:ro" node:22 bash -c "cp -r /repo /w && cd /w && node --test hooks/tests/differential.test.js"
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkPre } = require('../guard');

const SEED = Number(process.env.DIFF_SEED) || Date.now() % 1e9;
const RUNS = Number(process.env.DIFF_RUNS) || 150;
const WIN = process.platform === 'win32';
const ISOLATED = process.env.CI === 'true' || process.env.GUARDRAILS_DIFF_EXEC === '1'
  || fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// Containment, inside the isolation above. Every generator returns its command with `passes`,
// how many times its loop wrapper runs the body (1 without one; every loop it writes declares
// it). A case climbs at most (`..` steps) * passes levels, and one that could reach the
// sandbox root is never run: another is generated instead. The project sits PAD + 3 levels
// under that root. A canary file at the root is checked after every case and stops the run
// if it ever changes, but only after that case ran: it limits a containment bug to one case.
// (Counting `..` alone was not enough: a loop wrapper doubled `cd ../..`, and an early
// version of this test deleted *.txt files in the system temp dir.)
const PAD = 8;
const PAD_DIRS = Array.from({ length: PAD }, (_, i) => `p${i}`);
const MAX_CLIMB = PAD + 2; // PAD + 3 would land on the sandbox root itself
const climb = ({ command, passes }) => (command.match(/\.\./g) || []).length * passes;
const FILES = { 'README.md': 'a\n', 'a.txt': 'a\n', 'src/x.py': 'a\n', 'vendor/a.txt': 'a\n',
  'vendor/x.py': 'a\n', 'vendor/sub/b.txt': 'a\n', '.claude/settings.json': '{}\n',
  '.claude/guardrails.json': '{}\n', '.claude/other.txt': 'a\n' };
const DIRS = ['src/sub', 'vendor/sub', 'out'];
const CANARY = 'canary-do-not-touch';
const PROTECTED = ['.claude/settings.json', '.claude/settings.local.json', '.claude/guardrails.json'];
const isProtected = (rel) => rel === 'vendor' || rel.startsWith('vendor/') || PROTECTED.includes(rel);

function sandbox() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-diff-')));
  const root = path.join(base, ...PAD_DIRS, 'w', 'w2', 'repo');
  fs.writeFileSync(path.join(base, CANARY), CANARY);
  for (const d of DIRS.concat('.claude')) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [f, body] of Object.entries(FILES)) fs.writeFileSync(path.join(root, f), body);
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'vendor'), path.join(root, 'alias'), WIN ? 'junction' : 'dir');
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
    linked = false; // no link rights here: cases naming alias are not generated
  }
  return { base, root, linked };
}

// Path -> type, size, mtime and content hash, links not followed. A job a subshell left in
// the background may still be removing files while this walks: what vanished is skipped.
function snapshot(dir, rel = '', out = new Map()) {
  for (const name of gone(() => fs.readdirSync(dir)) || []) {
    const p = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    gone(() => {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.set(r, `link:${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(r, 'dir'); snapshot(p, r, out); }
      else out.set(r, `file:${st.size}:${st.mtimeMs}:${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`);
    });
  }
  return out;
}

function gone(read) {
  try {
    return read();
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    return null;
  }
}

function changed(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k));
}

function findBash() {
  if (process.env.DIFF_BASH) return process.env.DIFF_BASH;
  if (!WIN) return 'bash';
  // Git Bash, not the WSL launcher that may sit earlier on PATH
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const bash = exec && path.join(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && fs.existsSync(bash) ? bash : null;
}

const has = (exe, args) => !!exe && spawnSync(exe, args, { encoding: 'utf8' }).status === 0;
const toMsys = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');

// ---- command generators ------------------------------------------------------------------

const TARGETS = ['vendor/a.txt', 'vendor/new.txt', 'vendor/sub/b.txt', 'vendor/sub', 'vendor',
  'alias/a.txt', 'alias/new.txt', '.claude/settings.json', '.claude/guardrails.json', '.claude',
  'a.txt', 'new.txt', 'src/x.py', 'src/new.txt', 'src/sub', '.claude/other.txt', 'out/n.txt', 'out'];

// One spelling of a project path, as seen from the project root.
function spell(r, rel, abs) {
  const segs = rel.split('/');
  const k = r();
  if (k < 0.1) return `${abs}/${rel}`;
  if (k < 0.2) return `src/../${rel}`;
  if (k < 0.27) return `../repo/${rel}`;
  if (k < 0.34) return `./${rel}`;
  if (k < 0.42 && segs[0] === 'vendor') return [`v*`, `vend?r`, `{vendor,out}`, `ven{d..d}or`][Math.floor(r() * 4)] + rel.slice(6);
  if (k < 0.5) return segs.map((s) => (r() < 0.5 ? `'${s}'` : s)).join('/');
  if (k < 0.55) return `"${rel}"`;
  return rel;
}

function bashCase(r, abs) {
  const P = () => spell(r, pick(r, TARGETS), abs);
  const write = () => pick(r, [
    () => `echo x > ${P()}`, () => `echo x >> ${P()}`, () => `printf y > ${P()}`, () => `: > ${P()}`,
    () => `echo x | tee ${P()}`, () => `tee -a ${P()} < /dev/null`, () => `touch ${P()}`,
    () => `truncate -s 0 ${P()}`, () => `sed -i s/a/b/ ${P()}`, () => `dd if=/dev/null of=${P()} status=none`,
    () => `rm -f ${P()}`, () => `rm -rf ${P()}`, () => `rmdir ${P()}`, () => `unlink ${P()}`,
    () => `mv ${P()} ${P()}`, () => `cp ${P()} ${P()}`, () => `cp -r ${P()} ${P()}`, () => `cp -t ${P()} ${P()}`,
    () => `ln -s ${P()} ${P()}`, () => `ln -sf ${P()}`, () => `mkdir -p ${P()}`, () => `mkdir ${P()}`, () => `cat ${P()} > ${P()}`,
    () => `exec 3> ${P()}`, () => `rm -rf *`, () => `rm -f *.txt`,
  ])();
  const cd = () => pick(r, [() => 'cd vendor', () => 'cd src', () => 'cd ..', () => 'cd -', () => 'cd alias', () => 'cd src out', () => 'env cd vendor', () => "'!' cd src",
    () => 'cd v*', () => 'cd "src/sub"', () => 'cd nosuch', () => 'pushd vendor > /dev/null',
    () => 'popd > /dev/null', () => `cd ${abs}`, () => 'cd ../..', () => 'cd .claude'])();
  const noise = () => pick(r, ['ls > /dev/null', 'true', 'false', 'pwd > /dev/null', 'cat a.txt > /dev/null']);
  // a compound step: what `&` after it puts in the background must include the list before it
  const group = () => pick(r, [(a, b) => `{ ${a}; ${b}; }`, (a, b) => `if true; then ${a}; ${b}; fi`,
    (a, b) => `! { ${a}; ${b}; }`, (a, b) => `case x in x) ${a}; ${b};; esac`, (a, b) => `{ ${a}; '}'; ${b}; }`])(
    pick(r, [write, cd, noise])(), pick(r, [write, cd, noise])());
  const steps = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, [write, write, cd, cd, noise, group])());
  if (!steps.some((s) => /[>]|^(touch|truncate|sed|dd|rm|rmdir|unlink|mv|cp|ln|mkdir|tee|echo x \|)/.test(s))) {
    steps.push(write());
  }
  const joined = steps.reduce((acc, s, i) => (i ? acc + pick(r, ['; ', ' && ', ' || ', '\n', ' | ', ' & ']) + s : s), '');
  const [wrap, passes] = pick(r, [[(c) => c, 1], [(c) => `( ${c} )`, 1], [(c) => `{ ${c}; }`, 1],
    [(c) => `if true; then ${c}; fi`, 1], [(c) => `for i in 1 2; do ${c}; done`, 2],
    [(c) => `if false; then true; else ${c}; fi`, 1], [(c) => `echo $( ${c} )`, 1],
    [(c) => `time for i in 1 2; do ${c}; done`, 2], [(c) => `! for i in 1 2; do ${c}; done`, 2]]);
  return { command: wrap(joined), passes };
}

function psCase(r, abs) {
  const P = () => spell(r, pick(r, TARGETS), abs).replace(/'/g, '').replace(/[{}]/g, '').replace(/\//g, pick(r, ['/', '\\']));
  const write = () => pick(r, [
    () => `Set-Content ${P()} x`, () => `Add-Content ${P()} x`, () => `'x' | Out-File ${P()}`, () => `'x' > ${P()}`,
    () => `'x' >> ${P()}`, () => `New-Item ${P()} -Force`, () => `New-Item -ItemType Directory ${P()} -Force`,
    () => `Clear-Content ${P()}`, () => `Remove-Item ${P()} -Recurse -Force`, () => `Copy-Item ${P()} ${P()} -Recurse -Force`,
    () => `Move-Item ${P()} ${P()} -Force`, () => `Rename-Item ${P()} n2.txt`, () => `'x' | Tee-Object -FilePath ${P()}`,
    () => `ni ${P()} -Force`, () => `ri ${P()} -Recurse -Force`, () => `cpi ${P()} ${P()}`, () => `mkdir ${P()} -Force`,
    () => `Remove-Item * -Recurse -Force`, () => `Set-Content -LiteralPath ${P()} x`,
  ])();
  const cd = () => pick(r, ['Set-Location vendor', 'cd src', 'cd ..', 'Push-Location vendor', 'Pop-Location',
    `Set-Location ${abs}`, 'Set-Location nosuch -ErrorAction SilentlyContinue', 'cd alias', 'cd .claude']);
  const steps = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, [write, write, cd])());
  if (steps.every((s) => /^(Set-Location|cd|Push-|Pop-)/.test(s))) steps.push(write());
  const joined = steps.reduce((acc, s, i) => (i ? acc + pick(r, ['; ', '\n', ' && ', ' || ']) + s : s), '');
  const [wrap, passes] = pick(r, [[(c) => c, 1], [(c) => `& { ${c} }`, 1], [(c) => `if ($true) { ${c} }`, 1],
    [(c) => `try { ${c} } catch { $null = $_ }`, 1], [(c) => `1 | ForEach-Object { ${c} }`, 1],
    [(c) => `1,2 | ForEach-Object -Begin { } -Process { ${c} }`, 2], [(c) => `foreach ($i in 1,2) { ${c} }`, 2]]);
  return { command: wrap(joined), passes };
}

// ---- the judge -----------------------------------------------------------------------------

function runCase({ tool, exe, argsFor, gen }, seed) {
  const box = sandbox();
  try {
    const abs = tool === 'Bash' && WIN ? toMsys(box.root) : box.root.replace(/\\/g, '/');
    let made;
    const r = rng(seed);
    do made = gen(r, abs); while (climb(made) > MAX_CLIMB || (!box.linked && /alias/.test(made.command)));
    const { command } = made;
    const verdict = checkPre({ tool_name: tool, tool_input: { command }, cwd: box.root },
      { env: { CLAUDE_PROJECT_DIR: box.root }, config: { readonly: ['vendor/'] }, gpgsign: () => 'false' });
    const before = snapshot(box.base);
    const env = { ...process.env, HOME: path.join(box.root, '..'), CDPATH: '' };
    delete env.OLDPWD;
    spawnSync(exe, argsFor(command), { cwd: box.root, env, input: '', timeout: 15000, stdio: ['pipe', 'ignore', 'ignore'] });
    assertContained(box, command);
    const inRepo = `${[...PAD_DIRS, 'w', 'w2', 'repo'].join('/')}/`;
    const hit = changed(before, snapshot(box.base))
      .filter((k) => k.startsWith(inRepo)).map((k) => k.slice(inRepo.length))
      .filter(isProtected);
    return { command, blocked: verdict.length > 0, hit };
  } finally {
    removeBox(box.base);
  }
}

// The canary at the sandbox root is untouched, or the run stops here: a case that reached it
// could have reached past the sandbox too.
function assertContained(box, command) {
  let body = null;
  try {
    body = fs.readFileSync(path.join(box.base, CANARY), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (body !== CANARY) {
    process.stderr.write(`STOPPED: a case reached the sandbox root: ${JSON.stringify(command)}
`);
    process.exit(99);
  }
}

// A job a subshell left in the background may still hold the dir on Windows for a moment;
// past the retries the dir stays in the temp folder rather than failing the case.
const leftover = [];

function removeBox(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) throw e;
    leftover.push(dir);
  }
}

// One more try at the end of the run, once the background jobs have let go.
test.after(() => {
  for (const dir of leftover.splice(0)) removeBox(dir);
});

function differential(name, shell, runs) {
  test(`differential: ${name}`, (t) => {
    if (!ISOLATED) return t.skip('runs rm -rf for real: only in CI, a container or with GUARDRAILS_DIFF_EXEC=1');
    if (!shell.exe) return t.skip(`${name} not found`);
    const misses = [];
    let blocked = 0;
    let overBlocked = 0;
    for (let i = 0; i < runs; i++) {
      const res = runCase(shell, SEED + i * 7919);
      if (res.hit.length && !res.blocked) misses.push(`case ${i}: ${JSON.stringify(res.command)} changed ${res.hit.join(', ')}`);
      if (res.blocked) blocked++;
      if (res.blocked && !res.hit.length) overBlocked++;
    }
    t.diagnostic(`${runs} cases, ${blocked} blocked, ${overBlocked} of them with no protected change; seed ${SEED}`);
    assert.deepStrictEqual(misses, [], `guard let these through; reproduce: DIFF_SEED=${SEED}`);
  });
}

const BASH = findBash();
differential('bash', { tool: 'Bash', exe: has(BASH, ['-c', 'true']) ? BASH : null, argsFor: (c) => ['-c', `${c}\nwait`],
  gen: bashCase }, RUNS);
differential('pwsh', { tool: 'PowerShell', exe: has('pwsh', ['-NoProfile', '-Command', '1']) ? 'pwsh' : null,
  argsFor: (c) => ['-NoProfile', '-NonInteractive', '-Command', c], gen: psCase }, Math.max(1, Math.round(RUNS / 5)));

module.exports = { isProtected, snapshot, changed };
