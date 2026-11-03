// Ask the guard about every command of a corpus (bench/corpus/tldr.tsv.gz) in a throwaway
// project with a read-only vendor/ and .claude settings. Nothing is executed.
//
//   node bench/corpus/check_corpus.js [corpus.tsv.gz]   -> prints the blocked commands as JSON
//
// The test (bench/tests/corpus.test.js) compares the same verdicts with tldr-labels.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { checkPre } = require('../../hooks/guard');

const CORPUS = path.join(__dirname, 'tldr.tsv.gz');

function readCorpus(file = CORPUS) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean)
    .map((line) => {
      const [tool, page, command] = line.split('\t');
      return { tool, page, command };
    });
}

function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-corpus-')));
  for (const d of ['vendor/lib', '.claude', 'src', 'tests', 'path/to']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['vendor/lib/a.js', '.claude/settings.json', 'src/main.py', 'README.md', '.env.example', 'path/to/file']) {
    fs.writeFileSync(path.join(root, f), 'x\n');
  }
  return root;
}

// Rule ids of the blocks for each row, [] when allowed.
function verdicts(rows) {
  const root = project();
  try {
    const opts = { env: { CLAUDE_PROJECT_DIR: root }, config: { readonly: ['vendor/'] }, gpgsign: () => 'false' };
    return rows.map((r) => checkPre({ tool_name: r.tool, tool_input: { command: r.command }, cwd: root }, opts)
      .map((m) => m.match(/^\((.+?)\)/)[1]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const rows = readCorpus(process.argv[2]);
  const ids = verdicts(rows);
  const blocked = rows.map((r, i) => ({ ...r, rules: ids[i] })).filter((r) => r.rules.length);
  process.stdout.write(`${JSON.stringify(blocked, null, 1)}\n`);
  process.stderr.write(`${rows.length} commands, ${blocked.length} blocked\n`);
}

module.exports = { readCorpus, verdicts };
