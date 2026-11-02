// Replay the tool calls of real Claude Code transcripts through guard.js, offline.
//
//   node bench/replay.js --root <project dir> [--exclude <session id>] [--show] <transcript dir|file>...
//
// Transcripts are the *.jsonl files under ~/.claude/projects/<project>/ (subagent ones included).
// Every Bash, PowerShell, Edit, Write and MultiEdit call is checked the way the PreToolUse hook would
// check it, with the project's .claude/guardrails.json, and Edit/Write/MultiEdit also through the
// PostToolUse warnings. Prints counts only. --show also prints each blocked call, for a human to
// classify as a true or a false block -- keep that output local, it is your project's history.
//
// Approximations: globs, links and cd targets resolve against the filesystem as it is now, not as it
// was then; commit.gpgsign is taken as false (no git config is read per call).
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { checkPre, checkPost, SECRET_PATTERNS } = require('../hooks/guard');

const TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit']);

function args(argv) {
  const out = { root: '', exclude: [], show: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--exclude') out.exclude.push(argv[++i]);
    else if (argv[i] === '--show') out.show = true;
    else out.inputs.push(argv[i]);
  }
  if (!out.root || !out.inputs.length) {
    console.error('usage: node bench/replay.js --root <project dir> [--exclude <session>] [--show] <dir|file>...');
    process.exit(2);
  }
  return out;
}

function transcripts(p, exclude) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith('.jsonl') && !exclude.some((x) => p.includes(x)) ? [p] : [];
  return fs.readdirSync(p).flatMap((n) => (exclude.includes(n.replace(/\.jsonl$/, '')) ? []
    : transcripts(path.join(p, n), exclude)));
}

function* toolCalls(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue; // a torn last line
    }
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type === 'tool_use' && TOOLS.has(item.name)) {
        yield { tool_name: item.name, tool_input: item.input || {}, cwd: entry.cwd };
      }
    }
  }
}

// --show output never repeats a key: every format the guard recognises, then any long
// token-like run, is replaced whole -- before the line is shortened, so no fragment survives.
function redact(s) {
  let out = s;
  for (const [name, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), `[${name} redacted]`);
  return out.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, (t) => `${t.slice(0, 4)}...[redacted]`);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
const ruleOf = (m) => m.match(/^\((.+?)\)/)[1];

function main() {
  const a = args(process.argv.slice(2));
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(a.root, '.claude', 'guardrails.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const opts = { env: { CLAUDE_PROJECT_DIR: a.root }, config, gpgsign: () => 'false' };
  const files = a.inputs.flatMap((p) => transcripts(p, a.exclude));
  const perTool = {};
  const blocked = {};
  const warned = {};
  const times = [];
  const seen = new Set();
  let unique = 0;
  let blockedCalls = 0;
  for (const file of files) {
    for (const call of toolCalls(file)) {
      perTool[call.tool_name] = (perTool[call.tool_name] || 0) + 1;
      const key = JSON.stringify([call.tool_name, call.tool_input, call.cwd]);
      if (!seen.has(key)) { seen.add(key); unique++; }
      const t0 = performance.now();
      const pre = checkPre(call, opts);
      // a refused call never runs, so it never reaches PostToolUse
      const post = !pre.length && ['Edit', 'Write', 'MultiEdit'].includes(call.tool_name) ? checkPost(call, opts) : [];
      times.push(performance.now() - t0);
      if (pre.length) blockedCalls++;
      for (const m of pre) blocked[ruleOf(m)] = (blocked[ruleOf(m)] || 0) + 1;
      for (const m of post) warned[ruleOf(m)] = (warned[ruleOf(m)] || 0) + 1;
      if (a.show && pre.length) {
        const what = redact(JSON.stringify(call.tool_input.command || call.tool_input.file_path));
        console.log(`BLOCK ${call.tool_name} ${what.slice(0, 300)}`);
        for (const m of pre) console.log(`   ${redact(m).slice(0, 160)}`);
      }
    }
  }
  times.sort((x, y) => x - y);
  const total = Object.values(perTool).reduce((s, n) => s + n, 0);
  console.log(JSON.stringify({
    transcripts: files.length, calls: total, unique, perTool,
    blockedCalls, blockedByRule: blocked,
    warningsByRule: warned,
    checkMs: { p50: +pct(times, 0.5).toFixed(2), p95: +pct(times, 0.95).toFixed(2), max: +pct(times, 1).toFixed(2) },
  }, null, 2));
}

main();
