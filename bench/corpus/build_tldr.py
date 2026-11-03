"""Extract every example command of tldr-pages into a labelled corpus for the guard.

Usage:  python bench/corpus/build_tldr.py <tldr-pages.en.zip> [out.tsv.gz]

The zip is the `tldr-pages.en.zip` asset of a tldr-pages release; it is read in place, never
extracted. Each output line is `tool<TAB>platform/page<TAB>command`: pages for common, linux
and osx go to the Bash tool, windows pages to the PowerShell tool. Placeholders become their
own text: `{{path/to/file}}` -> `path/to/file`, `{{[-r|--recursive]}}` -> `-r`.
"""
from __future__ import annotations

import gzip
import re
import sys
import zipfile
from pathlib import Path

TOOLS = {"common": "Bash", "linux": "Bash", "osx": "Bash", "windows": "PowerShell"}
EXAMPLE = re.compile(r"^`(.+)`$")
OPTION = re.compile(r"\{\{\[([^|\]]*)\|[^\]]*\]\}\}")  # {{[-r|--recursive]}}
PLACEHOLDER = re.compile(r"\{\{(.*?)\}\}")


def fill(command: str) -> str:
    """Replace tldr placeholders with plain words a shell would see."""
    return PLACEHOLDER.sub(lambda m: m.group(1), OPTION.sub(lambda m: m.group(1), command))


def commands(zip_path: Path) -> list[tuple[str, str, str]]:
    rows = []
    with zipfile.ZipFile(zip_path) as z:
        for name in sorted(z.namelist()):
            platform, _, page = name.partition("/")
            if platform not in TOOLS or not page.endswith(".md"):
                continue
            for line in z.read(name).decode("utf-8").splitlines():
                m = EXAMPLE.match(line.strip())
                if m:
                    rows.append((TOOLS[platform], f"{platform}/{page[:-3]}", fill(m.group(1))))
    return rows


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("tldr.tsv.gz")
    rows = commands(Path(sys.argv[1]))
    body = "".join(f"{tool}\t{page}\t{cmd}\n" for tool, page, cmd in rows if "\t" not in cmd)
    out.write_bytes(gzip.compress(body.encode("utf-8"), mtime=0))
    print(f"{len(rows)} commands -> {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
