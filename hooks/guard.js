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
// MultiEdit and the Bash command string, tokenized like a shell, where it finds what
// redirects, tee, touch, truncate, sed -i, dd, rm, mv, cp, install and ln write or
// remove, following literal cd. The PowerShell tool's command is rewritten into the same
// token stream (backslash paths, backtick escapes, here-strings) and its file cmdlets
// and Set-Location/Push-Location are followed the same way. A script the agent writes and
// then runs, python -c, $variables, eval/Invoke-Expression, .NET file calls, xargs and
// find -delete are not followed.
// Hard boundaries belong in permissions.deny and Claude Code's sandbox.
const fs = require('fs');
const os = require('os');
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
const SHELLS = ['Bash', 'PowerShell'];
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

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    return p; // missing or unreadable: keep the lexical path
  }
}

// Path as segments, "." and ".." collapsed; Windows drive paths compare case-insensitively.
function toSegments(p) {
  const segs = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (s === '..') segs.pop();
    else if (s && s !== '.') segs.push(s);
  }
  return /^[a-zA-Z]:$/.test(segs[0] || '') ? segs.map((s) => s.toLowerCase()) : segs;
}

// Git Bash, MSYS and Cygwin spell C:\x as /c/x or /cygdrive/c/x. On a project with a drive
// root those name the same files, so Bash words are mapped before any path is judged
// (`driveMounts`, set per call in buildContext). PowerShell reads /c/x as \c\x on the
// current drive, so its words are left alone.
// Repeated slashes count as one (/cygdrive//c), and a bare /c is the drive's root.
const DRIVE_MOUNT = /^\/+(?:cygdrive\/+)?([a-zA-Z])(?=\/|$)/;
const unmount = (p) => p.replace(DRIVE_MOUNT, '$1:').replace(/^([a-zA-Z]:)$/, '$1/');
let driveMounts = false;
const mounted = (p) => (driveMounts ? unmount(p) : p);

function joinRoot(p, root) {
  const q = mounted(p);
  return isAbs(q) ? q : `${root || ''}/${q}`;
}

// Lexical: ".." collapsed first, then links resolved (Windows, path.resolve).
function lexicalSegments(p, root) {
  const joined = joinRoot(p, root);
  return toSegments(nodePath.isAbsolute(joined) ? realExisting(nodePath.normalize(joined)) : joined);
}

// Physical: each link is resolved before a later ".." applies to it (POSIX kernel):
// with alias -> vendor/sub, "alias/../x" is vendor/x, not <root>/x.
function physicalSegments(p, root) {
  const joined = joinRoot(p, root);
  if (!nodePath.isAbsolute(joined)) return toSegments(joined);
  const top = nodePath.parse(joined).root;
  let cur = top;
  for (const s of joined.slice(top.length).split(/[\\/]/)) {
    if (s === '..') cur = nodePath.dirname(cur);
    else if (s && s !== '.') cur = realOrSelf(nodePath.join(cur, s));
  }
  return toSegments(cur);
}

// Where a write to `p` may land; the OS decides which, so rules check both.
const landings = (p, root) => [lexicalSegments(p, root), physicalSegments(p, root)];

// True when `file` is inside read-only `dir`. A relative `dir` is anchored at the
// project root, so "lib/" matches <root>/lib/x.js but not <root>/src/lib/x.js or mylib/.
function underDir(file, dir, root) {
  const d = lexicalSegments(dir, root);
  return d.length > 0 && landings(file, root).some((f) =>
    d.length < f.length && d.every((s, i) => s === f[i]));
}

function samePath(a, b, root) {
  const y = lexicalSegments(b, root);
  return landings(a, root).some((x) => x.length === y.length && x.every((s, i) => s === y[i]));
}

// Files that switch the guard itself off; the agent may not edit them.
const GUARD_FILES = ['.claude/guardrails.json', '.claude/settings.json',
  '.claude/settings.local.json', __filename];

// --------------------------- shell parsing ---------------------------
// A small POSIX-ish lexer: quotes ('', "", $''), backslash escapes, comments, operators,
// redirects and heredocs, so a Bash command is read the way the shell will run it.
// Globs are expanded against the real directory. It does not expand $variables or
// command substitution inside double quotes, and runs nothing.

const OPERATORS = ';&|\n()`';
// Quoted or escaped * ? [ are literal to the shell: keep them apart from real globs.
const LIT = { '*': '\uE001', '?': '\uE002', '[': '\uE003', '{': '\uE004', ',': '\uE005', '}': '\uE006' };
const UNLIT = Object.fromEntries(Object.entries(LIT).map(([k, v]) => [v, k]));
const lit = (ch) => LIT[ch] || ch;
const plain = (w) => w.replace(/[\uE001-\uE006]/g, (c) => UNLIT[c]);
const ANSI_C = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', 0: '\0', '\\': '\\', "'": "'", '"': '"' };

function endWord(lx) {
  if (lx.cur === null) return;
  if (lx.pending === 'out') lx.redirs.push(lx.cur);
  else if (lx.pending === 'heredoc') lx.heredocs.push(plain(lx.cur));
  else if (lx.pending !== 'in') lx.words.push(lx.cur);
  lx.cur = null;
  lx.pending = null;
}

// Keywords whose command may not run, or may fail without stopping the line, and the
// compound commands whose bodies may run zero times or not at all.
const COND_WORDS = new Set(['if', 'elif', 'while', 'until', '!']);
const BODY_OPEN = new Set(['if', 'while', 'until', 'for', 'select', 'case']);
const BODY_CLOSE = new Set(['fi', 'done', 'esac']);
const CONDITIONAL = new Set(['&&', '||']);

// A simple command ends at an operator. `scope` = ids of the subshells it runs in;
// `sub` = it runs in a child shell anyway (pipeline member, background job);
// `cond` = it may not run at all (after && or ||, under if ...).
function endSegment(lx, op = ';') {
  endWord(lx);
  if (lx.words.length || lx.redirs.length) {
    const first = plain(lx.words[0] || '');
    if (first === '{') lx.groups.push({ start: lx.segs.length, piped: lx.prevOp === '|', depth: lx.scopes.length });
    if (BODY_OPEN.has(first)) lx.bodies++;
    lx.segs.push({ words: lx.words, redirs: lx.redirs, scope: [...lx.scopes], after: lx.prevOp,
      sub: op === '|' || op === '&' || lx.prevOp === '|',
      cond: lx.bodies > 0 || CONDITIONAL.has(lx.prevOp) || COND_WORDS.has(first) });
    if (BODY_CLOSE.has(first)) lx.bodies = Math.max(0, lx.bodies - 1);
    if (first === '}') closeGroup(lx, op);
    lx.prevOp = op;
  }
  lx.words = [];
  lx.redirs = [];
  lx.pending = null;
}

// "{ cd x; ...; } &" or "... | { ...; }": the whole group runs in a child shell, so it
// gets its own scope -- its cds count inside it, not after it.
function closeGroup(lx, op) {
  const group = lx.groups.pop();
  if (!group || !(group.piped || op === '|' || op === '&')) return;
  const id = lx.nextScope++;
  for (let k = group.start; k < lx.segs.length; k++) {
    lx.segs[k].scope.splice(group.depth, 0, id);
    lx.segs[k].sub = false;
  }
}

// ( $( and ` open a subshell with a fresh scope id, ) and the closing ` end it;
// && and || are one operator.
function readOperator(lx, ch) {
  const two = lx.cmd.slice(lx.i, lx.i + 2);
  const op = two === '&&' || two === '||' ? two : ch;
  lx.i += op.length - 1;
  endSegment(lx, op);
  const opens = ch === '(' || (ch === '`' && !lx.tick);
  const closes = ch === ')' || (ch === '`' && lx.tick);
  if (opens) lx.scopes.push(lx.nextScope++);
  else if (closes && lx.scopes.length > 1) lx.scopes.pop();
  if (ch === '`') lx.tick = !lx.tick;
  if (ch === '\n') skipHeredocs(lx);
}

// At "<" or ">": the next word is a file read, a file written, or a heredoc delimiter.
// "2>&1" / ">&-" duplicate a descriptor and name no file.
function readRedirect(lx) {
  if (lx.cur !== null && /^\d+$/.test(lx.cur)) lx.cur = null; // fd number, not a word
  else endWord(lx);
  const ch = lx.cmd[lx.i];
  let n = 1;
  while (lx.cmd[lx.i + n] === ch) n++;
  lx.i += n - 1;
  if (ch === '<') {
    lx.pending = n === 2 ? 'heredoc' : 'in';
    if (n === 2 && lx.cmd[lx.i + 1] === '-') lx.i++;
    return;
  }
  if (lx.cmd[lx.i + 1] === '|') lx.i++;
  if (lx.cmd[lx.i + 1] === '&' && /[\d-]/.test(lx.cmd[lx.i + 2] || '')) {
    for (lx.i += 2; /[\d-]/.test(lx.cmd[lx.i + 1] || '');) lx.i++;
    return;
  }
  if (lx.cmd[lx.i + 1] === '&') lx.i++;
  lx.pending = 'out';
}

// After a newline, heredoc bodies are data, not commands: skip to each delimiter line.
function skipHeredocs(lx) {
  for (const delim of lx.heredocs) {
    while (lx.i < lx.cmd.length) {
      const next = lx.cmd.indexOf('\n', lx.i + 1);
      const end = next < 0 ? lx.cmd.length : next;
      const line = lx.cmd.slice(lx.i + 1, end).replace(/^\t+/, '');
      lx.i = end;
      if (line === delim) break;
    }
  }
  lx.heredocs = [];
}

// $'...': backslash escapes are decoded like bash: \n \t \xHH \uHHHH \UHHHHHHHH \NNN \cX ...
const ANSI_NUM = [[/^x([0-9a-fA-F]{1,2})/, 16], [/^u([0-9a-fA-F]{1,4})/, 16],
  [/^U([0-9a-fA-F]{1,8})/, 16], [/^([0-7]{1,3})/, 8]];

function readAnsiEscape(lx) {
  const rest = lx.cmd.slice(lx.i + 1);
  for (const [re, base] of ANSI_NUM) {
    const m = rest.match(re);
    if (m) {
      const ch = String.fromCodePoint(parseInt(m[1], base));
      if (ch === '\0') lx.nul = true; // bash ends the string here
      else lx.cur += lit(ch);
      lx.i += m[0].length;
      return;
    }
  }
  const c = lx.cmd[++lx.i];
  if (c === 'c' && lx.cmd[lx.i + 1]) lx.cur += String.fromCharCode(lx.cmd[++lx.i].charCodeAt(0) & 31);
  else lx.cur += c in ANSI_C ? ANSI_C[c] : `\\${lit(c || '')}`;
}

function readQuoted(lx, ch) {
  const ansi = lx.quote === "$'";
  if (ch === (ansi ? "'" : lx.quote)) {
    lx.quote = null;
    lx.nul = false;
  } else if (ansi && lx.nul) {
    if (ch === '\\') lx.i++; // skip the escaped char too, it cannot end the quote
  } else if (ansi && ch === '\\') readAnsiEscape(lx);
  else if (ch === '\\' && lx.quote === '"' && '"\\$`'.includes(lx.cmd[lx.i + 1])) lx.cur += lx.cmd[++lx.i];
  else lx.cur += lit(ch);
}

function openQuote(lx, kind) {
  lx.quote = kind;
  lx.cur = lx.cur ?? '';
}

function readBackslash(lx) {
  const next = lx.cmd[++lx.i];
  if (next !== undefined && next !== '\n') lx.cur = (lx.cur ?? '') + lit(next); // \<newline> = continuation
}

function skipComment(lx) {
  const next = lx.cmd.indexOf('\n', lx.i);
  lx.i = (next < 0 ? lx.cmd.length : next) - 1;
}

// Command line -> simple commands [{ words, redirs }], split at ; && || | & ( ) ` and newlines.
// Words keep quoted glob characters encoded (see LIT); plain() turns them back.
function parseShell(cmd) {
  const lx = { cmd, i: 0, segs: [], words: [], redirs: [], cur: null, pending: null,
    quote: null, heredocs: [], scopes: [0], nextScope: 1, groups: [], bodies: 0, nul: false,
    tick: false, prevOp: ';' };
  for (; lx.i < cmd.length; lx.i++) {
    const ch = cmd[lx.i];
    if (lx.quote) readQuoted(lx, ch);
    else if (ch === '$' && (cmd[lx.i + 1] === "'" || cmd[lx.i + 1] === '"')) openQuote(lx, cmd[++lx.i] === "'" ? "$'" : '"');
    else if (ch === "'" || ch === '"') openQuote(lx, ch);
    else if (ch === '\\') readBackslash(lx);
    else if (ch === '#' && lx.cur === null) skipComment(lx);
    else if (ch === '&' && cmd[lx.i + 1] === '>') { lx.i++; readRedirect(lx); }
    else if (ch === '>' || ch === '<') readRedirect(lx);
    else if (OPERATORS.includes(ch)) readOperator(lx, ch);
    else if (/\s/.test(ch)) endWord(lx);
    else lx.cur = (lx.cur ?? '') + ch;
  }
  endSegment(lx);
  return lx.segs;
}

// Wrapper commands and which of their options take a value ("sudo -u root git ...").
const WRAPPERS = new Map([['sudo', /^-[ugCDhprtU]$/], ['env', /^-[uCS]$/], ['command', null],
  ['builtin', null], ['exec', /^-a$/], ['nohup', null], ['time', null], ['nice', /^-n$/]]);

// Index after a wrapper's own options, up to and including its "--".
function skipWrapperOptions(words, i, valueOpt) {
  while (i < words.length && plain(words[i]).startsWith('-')) {
    const opt = plain(words[i++]);
    if (opt === '--') break;
    if (valueOpt && valueOpt.test(opt)) i++;
  }
  return i;
}

// Shell keywords that can stand before a command: "if cd x; then ...", "{ cd x; }".
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);

// Strip VAR=x prefixes, keywords and wrappers like sudo/env/command: { name: 'cp', args: [...] }.
function commandOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = plain(words[i]);
    if (/^\w+=/.test(w) || RESERVED.has(w)) i++;
    else if (WRAPPERS.has(nameOf(w))) i = skipWrapperOptions(words, i + 1, WRAPPERS.get(nameOf(w)));
    else break;
  }
  return { name: nameOf(words[i]), args: words.slice(i + 1) };
}

const nameOf = (w) => nodePath.basename(plain(w || '')).replace(/\.exe$/i, '').toLowerCase();

// The precise reading, plus every later word after a wrapper as a possible command start,
// in case a wrapper option took a value this parser does not know (env --unset FOO git).
function commandsOf(words) {
  const main = commandOf(words);
  const first = words.findIndex((w) => WRAPPERS.has(nameOf(w)));
  if (first < 0) return [main];
  const alts = [];
  for (let i = first + 1; i < words.length; i++) {
    const w = plain(words[i]);
    if (!w.startsWith('-') && !/^\w+=/.test(w)) alts.push({ name: nameOf(w), args: words.slice(i + 1) });
  }
  return [main, ...alts];
}

// Dirs a wrapper runs its command in: env -C DIR / --chdir DIR, sudo -D DIR.
function wrapperDirs(words) {
  if (!words.some((w) => WRAPPERS.has(nameOf(w)))) return [];
  const dirs = [];
  words.map(plain).forEach((w, i, all) => {
    if (['-C', '-D', '--chdir'].includes(w)) dirs.push(all[i + 1] || '');
    else if (w.startsWith('--chdir=')) dirs.push(w.slice(8));
    else if (/^-[CD]./.test(w)) dirs.push(w.slice(2));
  });
  return dirs.filter(Boolean);
}

// Options end at "--"; everything after it is an operand even if it starts with "-".
function splitArgs(args) {
  const dd = args.indexOf('--');
  const before = dd < 0 ? args : args.slice(0, dd);
  const after = dd < 0 ? [] : args.slice(dd + 1);
  const isFlag = (a) => a.startsWith('-') && a !== '-';
  return { flags: before.filter(isFlag), operands: before.filter((a) => !isFlag(a)).concat(after) };
}

// A file operation: `tree` = removes or replaces a whole tree (rm -r, mv source, cp -r),
// so it also hits protected paths *inside* it.
const writeOp = (path) => ({ path, tree: false });
const treeOp = (path) => ({ path, tree: true });

// -t DIR, -tDIR, -rt DIR, --target-directory DIR, --target-directory=DIR (before "--").
function targetDir(args) {
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const a = args[i];
    if (a === '--target-directory') return { dir: args[i + 1], skip: [i, i + 1] };
    if (a.startsWith('--target-directory=')) return { dir: a.slice(19), skip: [i] };
    const short = a.match(/^-[a-zA-Z]*t(.*)$/);
    if (short) return short[1] ? { dir: short[1], skip: [i] } : { dir: args[i + 1], skip: [i, i + 1] };
  }
  return null;
}

// cp/mv/install/ln: the destination, plus dest/<basename of each source> in case dest is a dir.
function copyOps(name, args) {
  const target = targetDir(args);
  const skip = new Set(target ? target.skip : []);
  const { operands } = splitArgs(args.filter((_, i) => !skip.has(i)));
  const dest = target ? target.dir : operands.pop();
  if (!dest) return [];
  const into = operands.map((s) => treeOp(`${dest}/${nodePath.basename(s)}`));
  return [writeOp(dest), ...into, ...(name === 'mv' ? operands.map(treeOp) : [])];
}

// sed -i: the script is -e/-f's value, or else the first operand; the rest are files.
function sedOps(args) {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return [];
  const files = [];
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-e', '-f', '--expression', '--file'].includes(a)) { i++; script = true; }
    else if (/^(-e|-f|--expression=|--file=)/.test(a)) script = true;
    else if (!a.startsWith('-')) files.push(a);
  }
  return (script ? files : files.slice(1)).map(writeOp);
}

// Files one simple command writes or removes, by command name.
function fileOps(name, args) {
  const { operands } = splitArgs(args);
  if (['tee', 'touch', 'truncate'].includes(name)) return operands.map(writeOp);
  if (['rm', 'rmdir', 'unlink', 'shred'].includes(name)) return operands.map(treeOp);
  if (['cp', 'mv', 'install', 'ln'].includes(name)) return copyOps(name, args);
  if (name === 'sed') return sedOps(args);
  if (name === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => writeOp(a.slice(3)));
  return [];
}

const at = (dir, p) => (isAbs(p) || !dir ? p : `${dir}/${p}`);
const home = (p) => mounted(p.replace(/^~(?=$|[\\/])/, os.homedir()));

// End of a bracket expression starting at pat[i] === '[', or -1 if it never closes.
// POSIX classes like [:lower:] are skipped whole; `posix` reports that one was seen.
function bracketEnd(pat, i) {
  let j = i + 1;
  if (pat[j] === '!' || pat[j] === '^') j++;
  if (pat[j] === ']') j++;
  let posix = false;
  while (j < pat.length && pat[j] !== ']') {
    const m = pat.slice(j).match(/^\[([:=.]).*?\1\]/);
    if (m) posix = true;
    j += m ? m[0].length : 1;
  }
  return { end: j < pat.length ? j : -1, posix };
}

// Glob segment -> name test, bash style: * and ? skip dotfiles unless the pattern starts
// with "." (`dot`: PowerShell, which matches them too); an unclosed "[" is literal; a POSIX
// class ([[:lower:]]) matches any character (over-matching blocks rather than misses).
// A pattern that fails to compile matches all.
function globMatcher(pat, dot = false) {
  let src = '';
  for (let i = 0; i < pat.length; i++) {
    const br = pat[i] === '[' ? bracketEnd(pat, i) : { end: -1 };
    if (pat[i] === '*') src += '.*';
    else if (pat[i] === '?') src += '.';
    else if (br.end > 0 && br.posix) { src += '.'; i = br.end; }
    else if (br.end > 0) { src += `[${pat.slice(i + 1, br.end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = br.end; }
    else src += plain(pat[i]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  let re;
  try {
    re = new RegExp(`^${src}$`, 'i');
  } catch (e) {
    return () => true; // judged as matching everything: blocks rather than misses
  }
  return (name) => re.test(name) && (dot || pat.startsWith('.') || !name.startsWith('.'));
}

// Expansion work per hook call; past it the call is stopped (see applyRules), not skipped.
const MAX_EXPANSIONS = 2000;
const spend = (budget, n = 1) => {
  budget.left -= n;
  if (budget.left < 0) throw new Error('brace/glob expansion too large to check');
};

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    return []; // missing dir: the shell leaves the pattern as a literal word
  }
}

const GLOB_SEG = /^(.*?)([^/\\]*[*?[][^/\\]*)/;

// {1..3}, {a..c}, {01..10..2} -> the items, or null if `body` is not a sequence.
function braceSequence(body, budget) {
  const m = body.match(/^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/);
  if (!m || /\d/.test(m[1]) !== /\d/.test(m[2])) return null;
  const num = /\d/.test(m[1]);
  const [a, b] = num ? [+m[1], +m[2]] : [m[1].charCodeAt(0), m[2].charCodeAt(0)];
  const step = Math.abs(+m[3] || 1) * (a <= b ? 1 : -1);
  const width = num && /^-?0\d/.test(m[1] + ' ' + m[2]) ? Math.max(m[1].length, m[2].length) : 0;
  const items = [];
  for (let v = a; a <= b ? v <= b : v >= b; v += step) {
    spend(budget);
    items.push(num ? String(v).padStart(width, '0') : String.fromCharCode(v));
  }
  return items;
}

// Bash brace expansion of an unquoted {a,b}: ".{claude,x}" -> [".claude", ".x"].
function expandBraces(word, budget) {
  const open = word.indexOf('{');
  if (open < 0) {
    spend(budget);
    return [word];
  }
  let depth = 0;
  const commas = [];
  for (let i = open; i < word.length; i++) {
    if (word[i] === '{') depth++;
    else if (word[i] === ',' && depth === 1) commas.push(i);
    else if (word[i] === '}' && --depth === 0) {
      const head = word.slice(0, open);
      const tail = word.slice(i + 1);
      const seq = commas.length ? null : braceSequence(word.slice(open + 1, i), budget);
      if (seq) return seq.flatMap((item) => expandBraces(head + item + tail, budget));
      if (!commas.length) break; // "{x}" is literal
      const cuts = [open, ...commas, i];
      return cuts.slice(1).flatMap((c, k) => expandBraces(head + word.slice(cuts[k] + 1, c) + tail, budget));
    }
  }
  // this "{" opens no valid group: keep it, expand what follows
  return expandBraces(word.slice(open + 1), budget).map((rest) => word.slice(0, open + 1) + rest);
}

// Anchor at a dir; expand braces, then the first glob segment against the real directory
// like bash (no match -> the literal word), recursing for globs further down the path.
// A leaf path; an `ifMissing` op (a copy destination) is a whole tree when nothing is there
// yet, because the copied directory then takes its name.
function leaf(op, p) {
  const path = plain(p);
  return { path, tree: op.tree || (Boolean(op.ifMissing) && !fs.existsSync(path)) };
}

// /[c]/x or /cygdrive/?/x: a glob in the drive slot matches drive letters, which no
// native directory listing shows.
const DRIVE_GLOB = /^\/+(?:cygdrive\/+)?([^/]*[*?[][^/]*)(?=\/|$)/;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

function anchorOp(op, cwd, budget) {
  const variants = expandBraces(op.path, budget);
  if (variants.length > 1) return variants.flatMap((v) => anchorOp({ ...op, path: v }, cwd, budget));
  const drives = driveMounts && op.path.match(DRIVE_GLOB);
  if (drives) {
    const hits = LETTERS.filter(globMatcher(drives[1]));
    spend(budget, hits.length);
    const rest = op.path.slice(drives[0].length);
    if (hits.length) return hits.flatMap((l) => anchorOp({ ...op, path: `${l}:${rest || '/'}` }, cwd, budget));
  }
  const m = op.path.match(GLOB_SEG);
  if (!m) return [leaf(op, at(cwd, home(op.path)))];
  const dir = at(cwd, home(m[1] || './'));
  const names = listDir(plain(dir)).filter(globMatcher(m[2], op.dot));
  spend(budget, names.length);
  if (!names.length) return [leaf(op, at(cwd, home(op.path)))];
  const rest = op.path.slice(m[0].length);
  const encode = (n) => n.replace(/[*?[{,}]/g, lit);
  return names.flatMap((n) => anchorOp({ ...op, path: `${dir}/${encode(n)}${rest}` }, cwd, budget));
}

// One shell frame: the dirs it may be in (a set: a cd may be skipped or fail), the
// dirs before the last cd (for "cd -"), and the pushd stack.
const MAX_DIRS = 8;
const cloneFrame = (f) => ({ dirs: [...f.dirs], prev: [...f.prev], stack: f.stack.map((s) => [...s]) });

// The frame for a segment: a subshell starts as a copy of its parent at first use.
function frameFor(frames, scope) {
  let frame = frames.get(0);
  for (const id of scope.slice(1)) {
    if (!frames.has(id)) frames.set(id, cloneFrame(frame));
    frame = frames.get(id);
  }
  return frame;
}

// Where cd/pushd/popd would take the frame (before deciding if that is certain).
function dirTargets(frame, name, arg) {
  if (name === 'popd') return frame.stack.length ? frame.stack.pop() : frame.dirs;
  if (name === 'pushd' && !arg) { // swap with the top of the stack
    const top = frame.stack.length ? frame.stack.pop() : frame.dirs;
    frame.stack.push(frame.dirs);
    return top;
  }
  if (name === 'pushd') frame.stack.push(frame.dirs);
  return arg === '-' ? frame.prev : frame.dirs.map((d) => at(d, home(arg || '~')));
}

// A cd that may not run (after &&/||, inside if/for/while/case) or whose target is not
// a directory (it fails and the shell stays put) keeps the old dirs possible next to
// the new ones. Past MAX_DIRS possibilities the call is stopped, never truncated.
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function changeDir(frame, name, args, cond) {
  moveTo(frame, dirTargets(frame, name, plain(splitArgs(args).operands[0] || '')), cond);
}

function moveTo(frame, next, cond) {
  const unsure = cond || !next.every(isDir); // cd into a file or a missing dir fails
  const dirs = [...new Set(unsure ? [...frame.dirs, ...next] : next)];
  if (dirs.length > MAX_DIRS) throw new Error('too many possible working directories to check');
  frame.prev = frame.dirs;
  frame.dirs = dirs;
}

// Every file a command line touches, relative paths anchored at each dir the shell may be
// in at that point. A redirect on the cd itself opens before the cd runs.
// `ps`: PowerShell keeps one location per session, so ( ), & { } and pipelines move it
// too; every segment shares the top frame and a Set-Location that may not run is `cond`.
// Its wildcards match dot-names as well.
function shellOps(segs, startDir, ps = false) {
  const frames = new Map([[0, { dirs: [startDir], prev: [startDir], stack: [] }]]);
  const budget = { left: MAX_EXPANSIONS };
  const ops = [];
  for (const seg of segs) {
    const frame = ps ? frames.get(0) : frameFor(frames, seg.scope);
    const cmds = commandsOf(seg.words);
    const opsOf = (c) => (ps && PS_FILE_CMDS[c.name] ? psFileOps(c.name, c.args, seg.upstream)
      : fileOps(c.name, c.args));
    const local = cmds.flatMap(opsOf).concat(seg.redirs.map(writeOp))
      .filter((o) => o.path && !/^(\/dev\/|nul$)/i.test(plain(o.path)))
      .map((o) => (ps ? { ...o, dot: true } : o));
    const bases = frame.dirs.flatMap((d) => [d, ...wrapperDirs(seg.words).map((w) => at(d, home(w)))]);
    for (const base of bases) ops.push(...local.flatMap((o) => anchorOp(o, base, budget)));
    const { name, args } = cmds[0];
    if (ps && PS_LOCATION[name]) psChangeDir(frame, PS_LOCATION[name], args, seg.cond, budget);
    else if (!ps && ['cd', 'pushd', 'popd'].includes(name) && !seg.sub) changeDir(frame, name, args, seg.cond);
  }
  return ops;
}

// ------------------------- PowerShell commands -------------------------
// The PowerShell tool's command is rewritten into the POSIX lexer's terms, then parsed by
// parseShell: backslash is a path separator (-> /), backtick is the escape, '' and "" are
// quote escapes, here-string bodies are data, <# #> is a comment, and { } stand alone as
// words (PowerShell has no brace expansion). Raw text still goes to the secret check.

const SMART_QUOTES = { '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"' };
const PS_ESC = { 0: '', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

// A here-string body runs from the line after @' / @" to a line starting with '@ / "@.
function skipHereString(cmd, i, q) {
  const close = new RegExp(`\\n[ \\t]*${q}@`, 'g');
  close.lastIndex = i;
  const m = close.exec(cmd);
  return m ? m.index + m[0].length - 1 : cmd.length;
}

function psToPosix(raw) {
  const cmd = raw.replace(/[‘-„]/g, (c) => SMART_QUOTES[c] || c);
  let out = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (q === "'") {
      if (ch === "'" && next === "'") { out += "'\\''"; i++; }
      else { if (ch === "'") q = null; out += ch === '\\' ? '/' : ch; }
    } else if (q === '"') {
      if (ch === '`' && next !== undefined) {
        i++;
        out += '"$`'.includes(next) ? `\\${next}` : PS_ESC[next] ?? next;
      } else if (ch === '"' && next === '"') { out += '\\"'; i++; }
      else { if (ch === '"') q = null; out += ch === '\\' ? '/' : ch; }
    } else if (ch === '@' && (next === "'" || next === '"') && /^[ \t]*\r?\n/.test(cmd.slice(i + 2))) {
      i = skipHereString(cmd, i + 2, next);
      out += "''";
    } else if (ch === '<' && next === '#') {
      const end = cmd.indexOf('#>', i + 2);
      i = end < 0 ? cmd.length : end + 1;
      out += ' ';
    } else if (ch === '`') {
      const n = cmd[++i];
      if (n === '\r' && cmd[i + 1] === '\n') i++;
      if (n === '\n' || n === '\r') out += ' '; // line continuation: a separator, like the newline
      else if (n !== undefined) out += `\\${n}`;
    } else if (ch === "'" || ch === '"') { q = ch; out += ch; }
    else if (ch === '$' && /^\$null(?![\w:])/i.test(cmd.slice(i, i + 6))) { out += '/dev/null'; i += 4; }
    else if (ch === '\\') out += '/';
    else if (ch === '{' || ch === '}') out += ` ${ch} `;
    else out += ch;
  }
  return out;
}

// Each { } block boundary starts a new command: "try { Set-Content x } catch { }" is
// "try", "Set-Content x", "catch". A command in any block may not run (if/else/loop
// bodies, scriptblocks maybe never invoked), nor one after && / || or in a pipeline / job,
// so a Set-Location there keeps the old location possible (`cond`). `upstream` = operands
// of the commands piping into it (Get-ChildItem vendor | Remove-Item); a segment's
// redirects go with its last command.
function psFlow(segs) {
  const out = [];
  let depth = 0;
  let upstream = [];
  for (const seg of segs) {
    const piped = seg.after === '|' ? upstream : [];
    const cond = () => depth > 0 || CONDITIONAL.has(seg.after) || seg.sub;
    const parts = [];
    let cur = [];
    for (const w of seg.words) {
      if (w !== '{' && w !== '}') { cur.push(w); continue; }
      if (cur.length) parts.push({ words: cur, cond: cond() });
      cur = [];
      depth = w === '{' ? depth + 1 : Math.max(0, depth - 1);
    }
    if (cur.length || seg.redirs.length) parts.push({ words: cur, cond: cond() });
    parts.forEach((p, i) => out.push({ ...seg, ...p, redirs: i === parts.length - 1 ? seg.redirs : [], upstream: piped }));
    upstream = piped.concat(psSources(seg.words.filter((w) => w !== '{' && w !== '}')));
  }
  return out;
}

// Paths a pipeline stage hands down. A listing cmdlet hands down what it lists: its own
// paths, else the location; with -Filter/-Include only the matching names, with -Recurse
// the whole tree. Anything else ('a','b' | ..., Where-Object ...) hands down its words.
const PS_LISTERS = new Set(['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'resolve-path', 'rvpa']);

function psSources(words) {
  const c = commandsOf(words)[0];
  if (!PS_LISTERS.has(c.name)) return psArgs(words.filter((w) => !plain(w).startsWith('-'))).flat();
  const b = psBind(c.args);
  const paths = b.path.concat(b.pos[0] || []).map(psGlob).concat(b.literal);
  const filters = b.filter.concat(b.pos[1] || []).map(psGlob);
  const dirs = paths.length ? paths : ['.'];
  if (b.recurse || !filters.length) return dirs;
  return dirs.flatMap((d) => filters.map((f) => `${d}/${f}`));
}

const parsePowerShell = (cmd) => psFlow(parseShell(psToPosix(cmd)));

const PS_LOCATION = { 'set-location': 'cd', sl: 'cd', cd: 'cd', chdir: 'cd', 'push-location': 'pushd',
  pushd: 'pushd', pushl: 'pushd', 'pop-location': 'popd', popd: 'popd', popl: 'popd' };

// The target binds like any cmdlet path (-Path:x, -LiteralPath x, positional); a -Path
// wildcard resolves against the real directory like anywhere else. Push-Location with no
// path only saves the location (bash pushd would swap).
function psChangeDir(frame, name, args, cond, budget) {
  const b = psBind(args);
  const to = b.path.concat(b.pos[0] || []).map(psGlob).concat(b.literal)[0];
  if (name === 'pushd' && to === undefined) frame.stack.push(frame.dirs);
  else if (name === 'popd' || to === undefined || !GLOB_SEG.test(to)) {
    changeDir(frame, name, to === undefined ? [] : ['--', to], cond);
  } else {
    if (name === 'pushd') frame.stack.push(frame.dirs);
    const next = frame.dirs.flatMap((d) => anchorOp({ path: to, tree: false, dot: true }, d, budget).map((o) => o.path));
    moveTo(frame, next, cond);
  }
}

// Cmdlets (and their default aliases) that write or remove files, by how they bind paths.
const PS_KINDS = {
  content: ['set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'tee-object', 'tee',
    'export-csv', 'epcsv', 'export-clixml', 'set-item', 'si', 'clear-item', 'cli'],
  new: ['new-item', 'ni', 'mkdir', 'md'],
  remove: ['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'],
  copy: ['copy-item', 'cpi', 'copy', 'cp'],
  move: ['move-item', 'mi', 'move', 'mv'],
  rename: ['rename-item', 'rni', 'ren'],
};
const PS_FILE_CMDS = Object.fromEntries(Object.entries(PS_KINDS).flatMap(([k, names]) => names.map((n) => [n, k])));

// Parameter roles. A written name binds to a role if it is a prefix (>= 2 chars) of one of
// its names; anything unknown is taken as a switch, so its value is left as a positional
// path candidate -- an unknown parameter over-matches instead of hiding a path. `other`
// takes a value that is never a path and fills no positional slot (-Encoding utf8).
const PS_PARAMS = [
  ['literal', ['literalpath', 'pspath', 'lp']],
  ['path', ['path', 'filepath', 'fullname']],
  ['dest', ['destination']],
  ['newname', ['newname']],
  ['whatif', ['whatif', 'wi']],
  ['name', ['name']],
  ['filter', ['filter', 'include']],
  ['recurse', ['recurse']],
  ['value', ['value']],
  ['other', ['encoding', 'itemtype', 'type', 'exclude', 'credential', 'stream', 'delimiter', 'width',
    'inputobject', 'target', 'stackname', 'erroraction', 'ea', 'warningaction', 'wa',
    'errorvariable', 'ev', 'warningvariable', 'wv', 'outvariable', 'ov', 'outbuffer', 'ob',
    'informationaction', 'infa', 'informationvariable', 'iv', 'pipelinevariable', 'pv', 'usequotes',
    'quotefields', 'header', 'depth']],
];

function psRole(param) {
  const p = param.toLowerCase();
  if (p === 'r') return 'recurse'; // gci -r
  if (p.length < 2) return 'switch';
  const hit = PS_PARAMS.find(([, names]) => names.some((n) => n.startsWith(p)));
  return hit ? hit[0] : 'switch';
}

// FileSystem::C:\x and Microsoft.PowerShell.Core\FileSystem::C:\x are plain paths
// (the backslash is already a / here).
const PS_PROVIDER = /^(microsoft\.powershell\.core\/)?filesystem::/i;

// "a.txt, b.txt" arrives as words "a.txt," "b.txt": glue unquoted commas back into one
// argument, then split it into its items.
function psArgs(words) {
  const glued = [];
  for (const w of words) {
    if (glued.length && (glued[glued.length - 1].endsWith(',') || w.startsWith(','))) glued[glued.length - 1] += w;
    else glued.push(w);
  }
  return glued.map((w) => w.split(',').filter(Boolean).map((x) => x.replace(PS_PROVIDER, '')));
}

// -> { path: [], literal: [], dest: [], ..., recurse: bool, pos: [[...], ...] }
function psBind(words) {
  const b = { path: [], literal: [], dest: [], newname: [], name: [], filter: [], value: [], other: [],
    recurse: false, whatif: false, pos: [] };
  const args = psArgs(words);
  for (let i = 0; i < args.length; i++) {
    const w = args[i].join(',');
    const m = plain(w).match(/^-([A-Za-z][\w-]*)(:)?/);
    if (!m) { b.pos.push(args[i]); continue; }
    const role = psRole(m[1]);
    if (role === 'switch') continue;
    if (role === 'recurse') { b.recurse = true; continue; }
    if (role === 'whatif') { b.whatif = !(m[2] && /^\$false$/i.test(w.slice(m[0].length))); continue; }
    b[role].push(...(m[2] ? w.slice(m[0].length).split(',').filter(Boolean) : args[++i] || []));
  }
  return b;
}

// Wildcards in -Path apply even when quoted; -LiteralPath and destinations are literal.
const psGlob = (w) => w.replace(/[-]/g, (c) => UNLIT[c]);

// Positional slots per kind, in order; positionals fill the ones not given by name
// (Copy-Item -Path a b: b is the Destination). Out-File / Export-Csv's second slot is not a
// path either, so it counts as `value`.
const PS_SLOTS = { content: ['path', 'value'], new: ['path'], remove: ['path'], copy: ['path', 'dest'],
  move: ['path', 'dest'], rename: ['path', 'newname'] };

// $_ / $PSItem (or $_.FullName) as a path = the object coming down the pipeline.
const fromPipe = (w) => /^\$(_|psitem)(\.|$)/i.test(plain(w));

// Files a PowerShell file cmdlet writes or removes. More positionals than free slots means
// a parameter was misread, so every positional then counts as a target too.
function psFileOps(name, args, upstream = []) {
  const kind = PS_FILE_CMDS[name];
  const b = psBind(args);
  if (b.whatif) return []; // -WhatIf only reports what it would do
  const free = PS_SLOTS[kind].filter((s) => (s === 'path' ? !b.path.length && !b.literal.length : !b[s].length));
  b.pos.slice(0, free.length).forEach((items, i) => b[free[i]].push(...items));
  const extra = b.pos.length > free.length ? b.pos.flat().map(psGlob) : [];
  const targets = b.path.map(psGlob).concat(b.literal);
  const own = targets.filter((t) => !fromPipe(t));
  const given = own.length < targets.length || !own.length ? own.concat(upstream) : own;
  if (kind === 'content') return given.concat(extra).map(writeOp);
  if (kind === 'remove') return given.concat(extra).map(treeOp);
  if (kind === 'new') {
    if (!b.name.length) return given.concat(extra).map(writeOp);
    return b.name.flatMap((n) => (own.length ? own : ['.']).map((d) => writeOp(`${d}/${n}`))).concat(extra.map(writeOp));
  }
  if (kind === 'rename') {
    const to = b.newname[0];
    return given.flatMap((s) => [treeOp(s), ...(to ? [writeOp(`${nodePath.posix.dirname(plain(s))}/${to}`)] : [])])
      .concat(extra.map(treeOp));
  }
  const dests = b.dest.length ? b.dest : ['.'];
  const into = dests.flatMap((d) => given.map((s) => treeOp(`${d}/${nodePath.posix.basename(plain(s))}`)));
  return [...dests.map((d) => ({ ...writeOp(d), ifMissing: true })), ...into, ...(kind === 'move' ? given.map(treeOp) : []), ...extra.map(writeOp)];
}

// `git [-C dir] [-c k=v] <sub> <args>` -> { sub, args, config } for each reading of the
// command that is git (plain words).
const gitCalls = (seg) => commandsOf(seg.words).filter((c) => c.name === 'git').map(gitCall);

function gitCall({ args: raw }) {
  const args = raw.map(plain);
  const config = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-c') config.push(args[i + 1] || '');
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  }
  return { sub: args[i] || '', args: args.slice(i + 1), config };
}

const EVERYTHING = ['.', './', '*', ':/', ':', ':/*'];

// git add -A/--all, or a pathspec like . * :/ .. , without -n/--dry-run before "--".
const addsEverything = (seg) => gitCalls(seg).some(addsAll);

function addsAll(git) {
  if (git.sub !== 'add') return false;
  const { flags, operands } = splitArgs(git.args);
  if (flags.some((a) => a === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) return false;
  return flags.some((a) => a === '--all' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a))
    || operands.some((p) => EVERYTHING.includes(p) || /^(\.\.?[\\/]?)+$/.test(p));
}

const commitsSigned = (seg) => gitCalls(seg).some((git) => git.sub === 'commit'
  && !git.config.some((c) => /^commit\.gpgsign=false$/i.test(c)));

// An op lands on or inside `target`; a tree op also hits when it contains `target`.
const hits = (op, target, root) => samePath(op.path, target, root)
  || underDir(op.path, target, root) || (op.tree && underDir(target, op.path, root));

// .env exemption only when the write lands in an env file both ways (a .env symlink
// into src/ does not count).
const ENV_NAME = /^\.env(\.[\w-]+)?$/i;
const isEnvFile = (p, root) => landings(p, root).every((s) => ENV_NAME.test(s[s.length - 1] || ''));

// ------------------------------- rules -------------------------------
// Each rule: id (used in messages and in "disable"), when it applies, check -> message | null.

const BLOCK_RULES = [
  { id: 'git-add-all', tool: SHELLS,
    check: (c) => c.segs.some(addsEverything)
      && 'git add -A/--all/./* stages everything (.env, dumps, keys). '
        + 'Add files by name, or run git add -n ... first and review.' },
  { id: 'gpg-commit', tool: SHELLS,
    check: (c) => c.segs.some(commitsSigned) && c.gpgsign() === 'true'
      && 'commit.gpgsign=true: the pinentry prompt hangs a non-interactive agent shell. '
        + 'Use git -c commit.gpgsign=false commit ..., or ask the user to commit.' },
  { id: 'guard-config', tool: ['edit', ...SHELLS],
    check: (c) => c.ops.some((o) => GUARD_FILES.some((g) => hits(o, g, c.root)))
      && 'guardrail config and hook settings are edited by the user, not the agent. '
        + 'Say what should change and why.' },
  { id: 'readonly-dir', tool: ['edit', ...SHELLS],
    check: (c) => {
      const hit = c.readonly.find((d) => c.ops.some((o) => hits(o, d, c.root)));
      return hit && `${hit} is read-only (config "readonly"). Copy the pattern elsewhere.`;
    } },
  { id: 'secret', tool: ['edit', ...SHELLS],
    check: (c) => {
      if (c.ops.every((o) => isEnvFile(o.path, c.root))) return null; // no op = nothing written
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
    check: (c) => /[←-↙—–]/.test(c.text) && !readAsUtf8(c.ops[0].path)
      && 'Unicode arrow/dash in a Windows script: use ASCII -> / --. In a .ps1 the alternatives '
        + 'are a UTF-8 BOM, or #Requires -Version 7 when it never runs on Windows PowerShell 5.1.' },
];

// A .ps1 that PowerShell 5.1 reads as UTF-8 (BOM at byte 0) or that only runs on
// PowerShell 6+, judged from the whole file as written; unreadable or huge = no. A
// #Requires line inside a here-string or a <# #> comment is text, not a directive.
const REQUIRES_CORE = /^#requires\s[^\n]*-(version\s+([6-9]|\d{2,})|psedition\s+core)\b/im;
const PS_INERT = /@(['"])[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*\1@|<#[\s\S]*?#>/g;

function readAsUtf8(file) {
  if (!/\.ps1$/i.test(file)) return false;
  try {
    if (fs.statSync(file).size > 1 << 20) return false;
    const text = fs.readFileSync(file, 'utf8');
    return text.charCodeAt(0) === 0xFEFF || REQUIRES_CORE.test(text.replace(PS_INERT, ''));
  } catch (e) {
    return false;
  }
}

// ------------------------------- engine -------------------------------

function buildContext(input, env, gpgsign, config) {
  const ti = input.tool_input || {};
  const root = env.CLAUDE_PROJECT_DIR || input.cwd || '';
  const ps = input.tool_name === 'PowerShell';
  const driveRoot = /^[a-zA-Z]:/.test(root);
  driveMounts = driveRoot && !ps;
  // a config entry is the user's: /c/tools means C:\tools on a Windows project, any tool
  const fromEnv = (env.GUARDRAILS_READONLY || '').split(',');
  const readonly = fromEnv.concat(config.readonly || []).map((s) => s.trim()).filter(Boolean)
    .map((s) => (driveRoot ? unmount(s) : s));
  const isEdit = EDIT_TOOLS.includes(input.tool_name);
  const cmd = ti.command || '';
  const path = ti.file_path || '';
  const segs = input.tool_name === 'Bash' ? parseShell(cmd) : ps ? parsePowerShell(cmd) : [];
  const ops = isEdit ? [writeOp(at(root, path))] : shellOps(segs, input.cwd || root, ps);
  return { tool: isEdit ? 'edit' : input.tool_name, cmd, path, segs, ops,
    text: isEdit ? newText(ti) : cmd, root, readonly, gpgsign };
}

// A rule that throws on valid input reports instead of crashing the hook: a crash exits
// 1, which Claude Code treats as non-blocking, so a crafted command would slip through.
function runCheck(rule, c) {
  try {
    return rule.check(c);
  } catch (e) {
    return `could not check this call (${e.message}); stopped to be safe. Simplify it or ask the user.`;
  }
}

function applyRules(rules, input, opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || loadConfig(env.CLAUDE_PROJECT_DIR || input.cwd);
  let c;
  try {
    c = buildContext(input, env, opts.gpgsign || readGpgsign, config);
  } catch (e) {
    driveMounts = false;
    return [`(parse-error) could not read this call (${e.message}); stopped to be safe.`];
  }
  const off = new Set(config.disable || []);
  try {
    return rules
      .filter((r) => !off.has(r.id) && [].concat(r.tool).includes(c.tool)
        && (!r.file || r.file.test(c.path)))
      .map((r) => [r.id, runCheck(r, c)])
      .filter(([, msg]) => msg)
      .map(([id, msg]) => `(${id}) ${msg}`);
  } finally {
    driveMounts = false; // one call's reading, not the next one's
  }
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

module.exports = { checkPre, checkPost, verdict, underDir, parseShell, BLOCK_RULES, WARN_RULES };
