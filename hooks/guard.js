// Claude Code guardrails: one hook script for PreToolUse and PostToolUse.
//
// PreToolUse  -> BLOCK (exit 2): the tool call is refused, stderr goes to Claude.
// PostToolUse -> WARN  (exit 2): the edit already happened, stderr goes to Claude
//                so it can fix what it just wrote.
// A warning printed with exit 0 is NOT shown to the model, which is why warnings
// live in PostToolUse instead of being printed from PreToolUse.
//
// Config: <project>/.claude/guardrails.json
//   { "disable": ["telegram-parse-mode"], "readonly": ["vendor/", "third_party/"] }
// Env:    GUARDRAILS_OFF=1 bypasses everything; GUARDRAILS_READONLY=a/,b/ adds read-only dirs.
//         Both are read from the environment Claude Code was started with; an
//         `export` inside the agent's Bash tool does not reach this process.
//
// Scope: this is a seatbelt against agent mistakes, not a sandbox. It sees Edit/Write/
// MultiEdit and the Bash command string; a shell redirect (echo > file) is not parsed.
// Hard boundaries belong in permissions.deny and Claude Code's sandbox.
const fs = require('fs');
const nodePath = require('path');
const { execSync } = require('child_process');

const SECRET_PATTERNS = [
  ['OpenAI', /sk-[a-zA-Z0-9]{20,}/],
  ['Anthropic', /sk-ant-[a-zA-Z0-9_-]{20,}/],
  ['Gemini', /AIza[a-zA-Z0-9_-]{30,}/],
  ['GitHub PAT', /ghp_[a-zA-Z0-9]{30,}/],
  ['Slack bot', /xoxb-[a-zA-Z0-9-]{30,}/],
  ['Telegram bot', /\b[0-9]{9,12}:[A-Za-z0-9_-]{30,}\b/],
  ['Bearer token', /Bearer\s+[a-zA-Z0-9_\-.]{30,}/],
];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const PY = /\.py$/i;
const JS = /\.(m|c)?(j|t)sx?$/i;

// ------------------------------ helpers ------------------------------

function readGpgsign() {
  try {
    return execSync('git config commit.gpgsign', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch (e) {
    return ''; // unset -> git defaults to false
  }
}

function newText(ti) {
  return ti.new_string || ti.content
    || (ti.edits || []).map((e) => e.new_string || '').join('\n');
}

function loadConfig(root) {
  if (!root) return {};
  const file = nodePath.join(root, '.claude', 'guardrails.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[guardrails] ${file} ignored: ${e.message}`);
    return {};
  }
}

const isAbs = (p) => nodePath.isAbsolute(p) || /^[a-zA-Z]:/.test(p);

// Resolve symlinks/junctions on the longest prefix that exists, keep the rest as is,
// so a new file written through a linked dir is judged by where it really lands.
function realExisting(p) {
  const rest = [];
  let cur = p;
  while (!fs.existsSync(cur)) {
    const up = nodePath.dirname(cur);
    if (up === cur) return p;
    rest.unshift(nodePath.basename(cur));
    cur = up;
  }
  try {
    return nodePath.join(fs.realpathSync.native(cur), ...rest);
  } catch (e) {
    return p; // unreadable ancestor: fall back to the lexical path
  }
}

// Absolute, real path as segments: "..", "." and links resolved;
// Windows drive paths compare case-insensitively.
function fullSegments(p, root) {
  const joined = isAbs(p) ? p : `${root || ''}/${p}`;
  const local = nodePath.isAbsolute(joined) ? realExisting(nodePath.normalize(joined)) : joined;
  const segs = [];
  for (const s of local.replace(/\\/g, '/').split('/')) {
    if (s === '..') segs.pop();
    else if (s && s !== '.') segs.push(s);
  }
  return /^[a-zA-Z]:$/.test(segs[0] || '') ? segs.map((s) => s.toLowerCase()) : segs;
}

// True when `file` is inside read-only `dir`. A relative `dir` is anchored at the
// project root, so "lib/" matches <root>/lib/x.js but not <root>/src/lib/x.js or mylib/.
function underDir(file, dir, root) {
  const d = fullSegments(dir, root);
  const f = fullSegments(file, root);
  return d.length > 0 && d.length < f.length && d.every((s, i) => s === f[i]);
}

function samePath(a, b, root) {
  const x = fullSegments(a, root);
  const y = fullSegments(b, root);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

// Files that switch the guard itself off; the agent may not edit them.
const GUARD_FILES = ['.claude/guardrails.json', '.claude/settings.json',
  '.claude/settings.local.json', __filename];

// One shell command split into the commands it chains: ; && || | & and newlines.
const subCommands = (cmd) => cmd.split(/&&|\|\||[;|&\n]/).map((s) => s.trim()).filter(Boolean);

// `git [-C dir] [-c k=v] add <args>` with -A/--all/./*/:/ and no --dry-run/-n.
function addsEverything(seg) {
  const m = seg.match(/(?:^|[\s(`])git((?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*)\s+add\b(.*)$/);
  if (!m) return false;
  const args = m[2].trim().split(/\s+/).map((a) => a.replace(/^["'(]+|["')`]+$/g, ''));
  if (args.some((a) => a === '--dry-run' || a === '-n' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return false;
  return args.some((a) => ['--all', '.', './', '*', ':/', ':'].includes(a) || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a));
}

// ------------------------------- rules -------------------------------
// Each rule: id (used in messages and in "disable"), when it applies, check -> message | null.

const BLOCK_RULES = [
  { id: 'git-add-all', tool: 'Bash',
    check: (c) => subCommands(c.cmd).some(addsEverything)
      && 'git add -A/--all/./* stages everything (.env, dumps, keys). '
        + 'Add files by name, or run git add -n ... first and review.' },
  { id: 'gpg-commit', tool: 'Bash',
    check: (c) => subCommands(c.cmd).some((s) => /\bgit\b.*\scommit\b/.test(s)
        && !/-c\s+commit\.gpgsign/.test(s))
      && c.gpgsign() === 'true'
      && 'commit.gpgsign=true: the pinentry prompt hangs a non-interactive agent shell. '
        + 'Use git -c commit.gpgsign=false commit ..., or ask the user to commit.' },
  { id: 'guard-config', tool: 'edit',
    check: (c) => GUARD_FILES.some((g) => samePath(c.path, g, c.root))
      && 'guardrail config and hook settings are edited by the user, not the agent. '
        + 'Say what should change and why.' },
  { id: 'readonly-dir', tool: 'edit',
    check: (c) => {
      const hit = c.readonly.find((d) => underDir(c.path, d, c.root));
      return hit && `${hit} is read-only (config "readonly"). Copy the pattern elsewhere.`;
    } },
  { id: 'secret', tool: 'edit',
    check: (c) => {
      if (/(^|[\\/])\.env(\.[\w-]+)?$/.test(c.path)) return null;
      const hits = SECRET_PATTERNS.filter(([, re]) => re.test(c.text)).map(([n]) => n);
      return hits.length > 0 && `hardcoded secret (${hits.join(', ')}): not written. `
        + 'Read it from an env var / .env instead.';
    } },
  { id: 'logger-non-ascii', tool: 'edit', file: PY,
    check: (c) => {
      const bad = c.text.split('\n').filter((l) =>
        /logger\.(info|warning|error|debug|critical)\(/.test(l) && /[\x80-￿]/.test(l));
      return bad.length > 0 && 'non-ASCII in logger.*() crashes a cp1252 Windows console '
        + '(UnicodeEncodeError kills the task). Use [Tag] not emoji, -> not arrows:\n  > '
        + bad.slice(0, 3).map((l) => l.trim().slice(0, 120)).join('\n  > ');
    } },
];

const WARN_RULES = [
  { id: 'broad-except-py', tool: 'edit', file: PY,
    check: (c) => {
      const n = (c.text.match(/except\s+Exception\b/g) || []).length;
      return n > 0 && `${n}x "except Exception": catch the specific exception you expect.`;
    } },
  { id: 'empty-catch-js', tool: 'edit', file: JS,
    check: (c) => {
      const n = (c.text.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || []).length;
      return n > 0 && `${n}x empty catch {}: the error disappears. Handle it, log it, or rethrow.`;
    } },
  { id: 'telegram-parse-mode', tool: 'edit', file: PY,
    check: (c) => /(reply_text|send_message|reply_html)\s*\(/.test(c.text)
      && /(&lt;|&gt;|&amp;)/.test(c.text)
      && !/parse_mode\s*=\s*(ParseMode\.HTML|['"]HTML['"])/.test(c.text)
      && 'Telegram send with HTML entities but no parse_mode=HTML: users see raw &lt;.' },
  { id: 'unicode-win-script', tool: 'edit', file: /\.(bat|cmd|ps1)$/i,
    check: (c) => /[←-↙—–]/.test(c.text)
      && 'Unicode arrow/dash in a Windows script: use ASCII -> / --.' },
];

// ------------------------------- engine -------------------------------

function buildContext(input, env, gpgsign, config) {
  const ti = input.tool_input || {};
  const root = env.CLAUDE_PROJECT_DIR || input.cwd || '';
  const fromEnv = (env.GUARDRAILS_READONLY || '').split(',');
  const readonly = fromEnv.concat(config.readonly || []).map((s) => s.trim()).filter(Boolean);
  const isEdit = EDIT_TOOLS.includes(input.tool_name);
  return { tool: isEdit ? 'edit' : input.tool_name, cmd: ti.command || '',
    path: ti.file_path || '', text: isEdit ? newText(ti) : '', root, readonly, gpgsign };
}

function applyRules(rules, input, opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || loadConfig(env.CLAUDE_PROJECT_DIR || input.cwd);
  const c = buildContext(input, env, opts.gpgsign || readGpgsign, config);
  const off = new Set(config.disable || []);
  return rules
    .filter((r) => !off.has(r.id) && r.tool === c.tool && (!r.file || r.file.test(c.path)))
    .map((r) => [r.id, r.check(c)])
    .filter(([, msg]) => msg)
    .map(([id, msg]) => `(${id}) ${msg}`);
}

const checkPre = (input, opts) => applyRules(BLOCK_RULES, input, opts);
const checkPost = (input, opts) => applyRules(WARN_RULES, input, opts);

function verdict(input, opts) {
  const post = input.hook_event_name === 'PostToolUse';
  const msgs = post ? checkPost(input, opts) : checkPre(input, opts);
  const tag = post ? 'WARN (already written, please fix)' : 'BLOCKED';
  return msgs.map((m) => `[guardrails] ${tag} ${m}`);
}

function main() {
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    if (process.env.GUARDRAILS_OFF) return;
    let input;
    try {
      input = JSON.parse(data);
    } catch (e) {
      console.error('[guardrails] bad hook input, skipped: ' + e.message); // fail open
      return;
    }
    const lines = verdict(input);
    if (!lines.length) return;
    console.error(lines.join('\n'));
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { checkPre, checkPost, verdict, underDir, BLOCK_RULES, WARN_RULES };
