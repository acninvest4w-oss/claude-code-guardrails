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

// Absolute path as segments; Windows drive paths compare case-insensitively.
function fullSegments(p, root) {
  const joined = isAbs(p) ? p : `${root || ''}/${p}`;
  const segs = joined.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  return /^[a-zA-Z]:$/.test(segs[0] || '') ? segs.map((s) => s.toLowerCase()) : segs;
}

// True when `file` is inside read-only `dir`. A relative `dir` is anchored at the
// project root, so "lib/" matches <root>/lib/x.js but not <root>/src/lib/x.js or mylib/.
function underDir(file, dir, root) {
  const d = fullSegments(dir, root);
  const f = fullSegments(file, root);
  return d.length > 0 && d.length < f.length && d.every((s, i) => s === f[i]);
}

// ------------------------------- rules -------------------------------
// Each rule: id (used in messages and in "disable"), when it applies, check -> message | null.

const BLOCK_RULES = [
  { id: 'git-add-all', tool: 'Bash',
    check: (c) => /\bgit\s+add\s+(-A\b|--all\b|\.)(?!\S)/.test(c.cmd) && !/--dry-run/.test(c.cmd)
      && 'git add -A/--all/. stages everything (.env, dumps, keys). '
        + 'Add files by name, or run with --dry-run first and review.' },
  { id: 'gpg-commit', tool: 'Bash',
    check: (c) => /\bgit\s+commit\b/.test(c.cmd) && !/-c\s+commit\.gpgsign/.test(c.cmd)
      && c.gpgsign() === 'true'
      && 'commit.gpgsign=true: the pinentry prompt hangs a non-interactive agent shell. '
        + 'Use git -c commit.gpgsign=false commit ..., or ask the user to commit.' },
  { id: 'readonly-dir', tool: 'edit',
    check: (c) => {
      const hit = c.readonly.find((d) => underDir(c.path, d, c.root));
      return hit && `${hit} is read-only (config "readonly"). Copy the pattern elsewhere.`;
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
  { id: 'secret', tool: 'edit',
    check: (c) => {
      if (/\.env(\.|$)/.test(c.path)) return null;
      const hits = SECRET_PATTERNS.filter(([, re]) => re.test(c.text)).map(([n]) => n);
      return hits.length > 0 && `hardcoded secret (${hits.join(', ')}): move it to .env / env vars.`;
    } },
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
