---
{
  "title": "Inline Selection Branch Trigger Offset Drift",
  "summary": "Inline branch triggers for selected article passages could drift onto adjacent text or split KaTeX formula selections into multiple hitboxes, causing clicks to open the wrong branch and multi-line selections to highlight only one line. The fix moved selection triggers to grouped inline overlays, added compact text matching for legacy KaTeX selections, ignored hidden KaTeX MathML text, and linked hover state across all fragments of a selected passage.",
  "timestamp": "2026-05-03 21:06",
  "slug": "inline-selection-branch-trigger-offset",
  "severity": "medium",
  "owner": "Codex",
  "reported_by": "user",
  "related_issue": "unknown"
}
---

# Inline Selection Branch Trigger Offset Drift

## Root Cause
Inline trigger placement reused rendered DOM range rects directly. KaTeX output added hidden MathML text and many glyph-level rects, while legacy selected-text offsets contained whitespace and zero-width characters, so anchor matching could drift to adjacent visible text or split a single formula across multiple independent clickable regions.

## Fix
Selection anchor matching now ignores hidden KaTeX MathML text and falls back to compact text matching that removes whitespace and zero-width characters. Inline trigger rects are grouped per branch, formula selections can collapse into one bounding hitbox, and hover styling is linked across all line fragments for the same selected passage.

## Files Changed
- `apps/web/src/App.tsx`
- `apps/web/src/index.css`
- `CHANGELOG.md`

## Verification
- `npm run check --workspace @netchat/web`
- `npm run build:web`
- `git diff --check -- CHANGELOG.md apps/web/src/App.tsx apps/web/src/index.css`
- Opened `PersonalObsidianVault` / `X 上的 Jino Rohit：“Flash Attention Series.md` with `agent-browser`, clicked the softmax formula trigger, and confirmed it opened the formula branch instead of the adjacent prompt branch.
- Hovered the multi-line `Try plugging...` selected passage in the same net and confirmed all trigger fragments highlighted together, then returned to transparent when the mouse moved away.

## Follow-up
- none