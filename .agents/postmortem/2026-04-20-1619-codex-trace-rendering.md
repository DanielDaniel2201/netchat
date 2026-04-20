---
{
  "title": "Codex Trace Rendering Regressions After App Server Migration",
  "summary": "After the Codex runtime moved to the app-server transport, thinking/tool traces and intermediate assistant status text were misclassified during stream aggregation, which caused `Thinking & Tools` blocks to disappear after final commit, transient status text to flash inside the final-response panel, some reasoning to collapse into `[]`, and article-focus selection branches to lose their return path. The fix separated final-response streaming from persisted trace blocks, expanded Codex reasoning parsing, normalized LaTeX delimiters before markdown rendering, and restored focus-view selection-branch return state.",
  "timestamp": "2026-04-20 16:19",
  "slug": "codex-trace-rendering",
  "severity": "medium",
  "owner": "Codex",
  "reported_by": "user",
  "related_issue": "commit efd43e3"
}
---

# Codex Trace Rendering Regressions After App Server Migration

## Root Cause
The App Server migration introduced a mismatch between runtime events and UI state semantics. Codex reasoning and plan updates were not fully parsed from app-server notifications, normal streamed final-answer text was temporarily treated like a persisted trace entry, and later finalization removed those temporary blocks. In parallel, assistant markdown math relied on delimiters that the current render path did not normalize, and focus-view selection branching did not set the return-state metadata needed for the existing `Esc`/return flow.

## Fix
The shared assistant stream model was extended so intermediate assistant updates can be stored separately from final response text. The daemon now parses Codex app-server reasoning, plan, and structured message payloads more completely, while the server demotes pre-tool streamed response text into persisted assistant trace blocks only when later events prove that text was intermediate rather than final. The web UI now renders those persisted assistant updates inside `Thinking & Tools`, keeps the final-response panel reserved for the committed answer, normalizes `\(...\)` and `\[...\]` math delimiters before markdown rendering, and restores focus-view return state for article selection branches.

## Files Changed
- `packages/shared/src/index.ts`
- `apps/server/src/index.ts`
- `apps/daemon/src/runtime.ts`
- `apps/web/src/App.tsx`
- `CHANGELOG.md`

## Verification
- `npm run check`
- Inspected persisted `assistant_states` for the reproduced Codex selection-branch message in the affected net to confirm the previous failure mode and validate the state-shape fix.
- User confirmed the bug-fix task was complete after local manual validation.

## Follow-up
- Add an automated regression test around Codex streamed intermediate assistant updates versus final response promotion, so app-server event-shape changes cannot silently reintroduce this UI/state mismatch.
