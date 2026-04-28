---
{
  "title": "Focus View Truncated Root Branch After Mid-Branch User Bubble",
  "summary": "Focusing a normal user bubble inside the root branch only rendered messages up to that bubble, hiding later root-branch replies. The fix teaches Focus View to keep the full root branch visible for non-article root targets instead of reusing the article-path truncation logic.",
  "timestamp": "2026-04-28 13:28",
  "slug": "focus-root-user-bubble-truncation",
  "severity": "medium",
  "owner": "Codex",
  "reported_by": "user",
  "related_issue": "unknown"
}
---

# Focus View Truncated Root Branch After Mid-Branch User Bubble

## Root Cause
`buildFocusViewMessages` treated any focus target inside `rootBranchId` as a path-reading case unless it matched the special article fast-path. When the focused bubble was a normal root-branch user message, Focus View reused the path builder that stops at the target message, so later root-branch bubbles were incorrectly omitted.

## Fix
Added a non-article root-branch fast-path in `buildFocusViewMessages` so focusing a normal user or assistant bubble on the root branch now returns the full root branch message list instead of truncating the branch at the focused message.

## Files Changed
- `apps/web/src/App.tsx`

## Verification
- `npm run build:web`
- Reproduced the bug in reasoning against the Focus View message-selection logic and confirmed the updated root-branch fast-path now keeps subsequent root messages visible when the centered focus target is a normal user bubble.

## Follow-up
- none
