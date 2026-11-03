# Corpus

`tldr.tsv.gz` holds every example command of [tldr-pages](https://github.com/tldr-pages/tldr)
v2.3 (`tldr-pages.en.zip`), 32,692 commands, one per line as `tool<TAB>platform/page<TAB>command`.
Pages for common, linux and osx are read as Bash commands, windows pages as PowerShell.
Placeholders become their own text (`{{path/to/file}}` -> `path/to/file`, `{{[-r|--recursive]}}`
-> `-r`). Rebuild it with `python bench/corpus/build_tldr.py <tldr-pages.en.zip>`.

tldr-pages content is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
copyright the tldr-pages contributors. The commands are used unchanged apart from the
placeholder substitution above.

`tldr-labels.json` lists every command the guard blocks, each labelled by hand as a true block
or a false positive, with the reason. `bench/tests/corpus.test.js` fails when the blocked set
and the labels differ. `node bench/corpus/check_corpus.js` prints the current blocks.
