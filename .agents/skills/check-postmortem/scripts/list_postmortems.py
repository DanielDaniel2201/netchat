#!/usr/bin/env python3
"""List postmortem summaries from .agents/postmortem."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
FIELD_RE = {
    "title": re.compile(r'"title"\s*:\s*"((?:\\.|[^"\\])*)"'),
    "summary": re.compile(r'"summary"\s*:\s*"((?:\\.|[^"\\])*)"'),
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def postmortem_dir(root: Path) -> Path:
    return root / ".agents" / "postmortem"


def extract_frontmatter(text: str, source: Path) -> dict[str, str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError(f"Missing frontmatter: {source}")

    raw = match.group(1).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
        for key, pattern in FIELD_RE.items():
            field_match = pattern.search(raw)
            if field_match:
                data[key] = json.loads(f'"{field_match.group(1)}"')

    title = data.get("title")
    summary = data.get("summary")
    if not isinstance(title, str) or not isinstance(summary, str):
        raise ValueError(f"Frontmatter title/summary missing in: {source}")

    return {"title": title, "summary": summary}


def relative_display_path(root: Path, path: Path) -> str:
    return "./" + path.relative_to(root).as_posix()


def collect_items(root: Path) -> list[dict[str, str]]:
    base = postmortem_dir(root)
    if not base.exists():
        return []

    items: list[dict[str, str]] = []
    for file_path in sorted(base.glob("*.md")):
        parsed = extract_frontmatter(file_path.read_text(encoding="utf-8"), file_path)
        items.append(
            {
                "file_path": relative_display_path(root, file_path),
                "title": parsed["title"],
                "summary": parsed["summary"],
            }
        )
    return items


def main() -> int:
    root = repo_root()
    try:
        items = collect_items(root)
    except Exception as exc:  # pragma: no cover - CLI failure path
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(items, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
