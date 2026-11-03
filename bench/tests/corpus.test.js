// False positives on a public corpus: every example command of tldr-pages (32k+, CC BY 4.0)
// goes through the guard in a project with a read-only vendor/. Nothing is executed. The
// blocked set must equal bench/corpus/tldr-labels.json exactly: a new block fails until a
// human labels it (true block or false positive), and a labelled block that stops blocking
// fails too, so the file and the published numbers stay true. A label with a `when` is a
// block that depends on where the project sits on disk: it may or may not show up.
const test = require('node:test');
const assert = require('node:assert');
const { readCorpus, verdicts } = require('../corpus/check_corpus');
const LABELS = require('../corpus/tldr-labels.json');

const key = (r) => `${r.tool}\t${r.page}\t${r.command}\t${[...r.rules].sort().join(',')}`;

test('tldr-pages corpus: blocks are exactly the labelled ones', (t) => {
  const rows = readCorpus();
  const ids = verdicts(rows);
  const blocked = rows.map((r, i) => ({ ...r, rules: ids[i] })).filter((r) => r.rules.length);
  const got = new Set(blocked.map(key));
  const allowed = new Set(LABELS.blocked.map(key));
  const want = new Set(LABELS.blocked.filter((l) => !l.when).map(key));
  const falseBlocks = LABELS.blocked.filter((l) => l.label === 'false').length;
  t.diagnostic(`${rows.length} commands, ${blocked.length} blocked, ${falseBlocks} labelled false `
    + `(${((100 * falseBlocks) / rows.length).toFixed(3)}%)`);
  assert.deepStrictEqual([...got].filter((k) => !allowed.has(k)), [], 'new blocks: label each one in tldr-labels.json');
  assert.deepStrictEqual([...want].filter((k) => !got.has(k)), [], 'labelled blocks no longer blocked: update tldr-labels.json');
});
