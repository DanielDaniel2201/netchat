---
{
  "title": "Codex Runtime Idle Timeout Mismatch",
  "summary": "Codex root turns in netchat were being killed after 60 seconds of stdout/stderr silence even when the underlying `codex exec --json` run was still making legitimate progress. The fix introduced a Codex-specific inactivity timeout default of 5 minutes plus per-runtime timeout overrides, which stopped long-running prompts from being misclassified as stalled.",
  "timestamp": "2026-04-12 18:22",
  "slug": "codex-idle-timeout",
  "severity": "medium",
  "owner": "codex",
  "reported_by": "user",
  "related_issue": "3412e12"
}
---

# Codex Runtime Idle Timeout Mismatch

## Root Cause
The daemon treated any lack of child-process `stdout` or `stderr` output as inactivity and applied the shared `NETCHAT_RUNTIME_TIMEOUT_MS` fallback of 60 seconds to all runtimes. Codex non-interactive turns can legitimately spend more than 60 seconds without emitting a new JSON line, especially under heavier user-level Codex settings, so netchat killed healthy Codex runs too early.

## Fix
The daemon now resolves inactivity timeouts per runtime. Codex gets a dedicated default of 300000 ms, and the runtime layer also accepts `NETCHAT_CODEX_TIMEOUT_MS` for explicit override while preserving the existing global fallback for other runtimes.

## Files Changed
- `apps/daemon/src/runtime.ts`
- `README.md`
- `CHANGELOG.md`

## Verification
- `npm run check --workspace @netchat/daemon`
- Reproduced the original Codex root-turn prompt through `CodexCliRuntime.executeTurn()` and confirmed it completed successfully in about 4.2 minutes under the new 5-minute inactivity timeout.

## Follow-up
- Consider exposing the effective per-runtime inactivity timeout in diagnostics so future runtime-idle investigations can distinguish a silent healthy turn from a genuine stall.
