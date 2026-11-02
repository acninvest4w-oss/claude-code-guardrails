// Claude Code guardrails: one hook script for PreToolUse and PostToolUse.
//
// PreToolUse  -> BLOCK (exit 2): the tool call is refused, stderr goes to Claude.
// PostToolUse -> WARN  (exit 2): the edit already happened, stderr goes to Claude
//                so it can fix what it just wrote.
// A warning printed with exit 0 is NOT shown to the model, which is why warnings
// live in PostToolUse instead of being printed from PreToolUse.
//
// Every rule exists because an agent did that exact thing in production.
// Bypass everything: GUARDRAILS_OFF=1. Read-only dirs: GUARDRAILS_READONLY=vendor/,third_party/
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

function readonlyDirs(env) {
  return (env.GUARDRAILS_READONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------- BLOCK rules ----------------------------

function blockBash(cmd, gpgsign) {
  const out = [];
  if (/\bgit\s+add\s+(-A\b|--all\b|\.)(?!\S)/.test(cmd) && !/--dry-run/.test(cmd)) {
    out.push('git add -A/--all/. stages everything (.env, dumps, keys). '
      + 'Add files by name, or run with --dry-run first and review.');
  }
  const signs = /\bgit\s+commit\b/.test(cmd) && !/-c\s+commit\.gpgsign/.test(cmd);
  if (signs && gpgsign() === 'true') {
    out.push('commit.gpgsign=true: the pinentry prompt hangs a non-interactive agent shell. '
      + 'Use git -c commit.gpgsign=false commit ..., or ask the user to commit.');
  }
  return out;
}

function blockEdit(path, text, env) {
  const out = [];
  const norm = path.replace(/\\/g, '/');
  const ro = readonlyDirs(env).find((d) => norm.includes(d.replace(/\\/g, '/')));
  if (ro) out.push(`${ro} is read-only (reference clones). Copy the pattern elsewhere.`);
  if (/\.py$/i.test(path)) {
    const bad = text.split('\n').filter((l) =>
      /logger\.(info|warning|error|debug|critical)\(/.test(l) && /[\x80-￿]/.test(l));
    if (bad.length) {
      out.push('non-ASCII in logger.*() crashes a cp1252 Windows console (UnicodeEncodeError '
        + 'kills the task). Use [Tag] not emoji, -> not arrows, -- not em-dash:\n  > '
        + bad.slice(0, 3).map((l) => l.trim().slice(0, 120)).join('\n  > '));
    }
  }
  return out;
}

function checkPre(input, env = process.env, gpgsign = readGpgsign) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Bash') return blockBash(ti.command || '', gpgsign);
  if (EDIT_TOOLS.includes(input.tool_name)) return blockEdit(ti.file_path || '', newText(ti), env);
  return [];
}

// ----------------------------- WARN rules -----------------------------

function warnSecrets(path, text) {
  if (/\.env(\.|$)/.test(path)) return [];
  const hits = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
  return hits.length ? [`hardcoded secret (${hits.join(', ')}): move it to .env / env vars.`] : [];
}

function warnPython(text) {
  const out = [];
  const n = (text.match(/except\s+Exception\b/g) || []).length;
  if (n) out.push(`${n}x "except Exception": catch the specific exception you expect.`);
  const telegram = /(reply_text|send_message|reply_html)\s*\(/.test(text);
  const entities = /(&lt;|&gt;|&amp;)/.test(text);
  const parseMode = /parse_mode\s*=\s*(ParseMode\.HTML|['"]HTML['"])/.test(text);
  if (telegram && entities && !parseMode) {
    out.push('Telegram send with HTML entities but no parse_mode=HTML: users see raw &lt;.');
  }
  return out;
}

function checkPost(input) {
  if (!EDIT_TOOLS.includes(input.tool_name)) return [];
  const ti = input.tool_input || {};
  const path = ti.file_path || '';
  const text = newText(ti);
  if (!text) return [];
  const out = warnSecrets(path, text);
  if (/\.py$/i.test(path)) out.push(...warnPython(text));
  if (/\.(bat|cmd|ps1)$/i.test(path) && /[←-↙—–]/.test(text)) {
    out.push('Unicode arrow/dash in a Windows script: use ASCII -> / --.');
  }
  return out;
}

// ------------------------------- main -------------------------------

function verdict(input) {
  const post = input.hook_event_name === 'PostToolUse';
  const msgs = post ? checkPost(input) : checkPre(input);
  const tag = post ? 'WARN (already written, please fix)' : 'BLOCKED';
  return msgs.map((m) => `[guardrails] ${tag}: ${m}`);
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

module.exports = { checkPre, checkPost, verdict };
