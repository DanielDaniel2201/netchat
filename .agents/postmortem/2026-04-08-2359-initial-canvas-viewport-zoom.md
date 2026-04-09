---
{
  "title": "Initial Canvas Viewport Zoom Fallback",
  "summary": "The local app sometimes opened the canvas at React Flow's internal default scale(1) instead of the intended initial camera, which made the whole UI look overly zoomed in on first paint. The fix switched the canvas to a controlled viewport so the computed initial zoom is always applied.",
  "timestamp": "2026-04-08 23:59",
  "slug": "initial-canvas-viewport-zoom",
  "severity": "medium",
  "owner": "Codex",
  "reported_by": "user",
  "related_issue": "commit 8eb05e1"
}
---

# Initial Canvas Viewport Zoom Fallback

## Root Cause
The web app computed the desired initial canvas camera in React state, but passed it to React Flow as `defaultViewport`, which only applies during one-time initialization. In the failing startup path, React Flow mounted with its own internal fallback viewport (`translate(0px, 0px) scale(1)`), so the canvas rendered much larger than intended.

## Fix
Switched the canvas from one-time `defaultViewport` initialization to a controlled `viewport` plus `onViewportChange`, so the computed initial camera is always synchronized into React Flow after mount and during later viewport updates.

## Files Changed
- `apps/web/src/App.tsx`
- `CHANGELOG.md`

## Verification
- Ran `npm run build:web`.
- Opened the local app with browser automation and verified the canvas viewport changed from the incorrect `scale(1)` behavior to the expected initial transform `translate(627px, 107.627px) scale(0.686567)`.
- Confirmed the first rendered message bubble width returned to a normal visible range instead of the oversized first-paint layout.

## Follow-up
- Review whether the remaining oversized typography changes from earlier styling commits should be tuned separately from viewport behavior.
