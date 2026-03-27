# True Branching From Anywhere

## Problem Summary

`netchat` currently renders message-level branching in the UI, but mid-message branching is not reflected as a clean message-level fork in Claude Code's underlying session storage.

Today, branching from an earlier assistant bubble works like this:

1. read the clicked message's `sessionId`
2. call Claude Code with `--resume <sessionId> --fork-session`
3. append an anchor prompt telling Claude to ignore later turns and continue from the earlier message

This means the new branch session can physically inherit turns that happened after the visible branch point. In practice, Claude often behaves as if it understands the requested branch point, but that behavior depends on prompt-following, not on a clean underlying session topology.

## Example Failure Mode

Visible graph:

```text
user1 -> claude1 -> user2 -> claude2
                  \
                   -> user3 -> claude3
```

Desired branch semantics:

```text
claude3 sees only:
user1 -> claude1 -> user3
```

Observed current behavior:

```text
claude3 may actually be generated from:
user1 -> claude1 -> user2 -> claude2 -> branch-anchor-prompt -> user3
```

Claude may still answer as if `user2` and `claude2` are outside the branch, but they remain present in the raw session transcript.

## Design Goal

Support a branch that is as close as possible to:

- "start a new Claude Code branch from the exact message the user clicked"
- while still sending the request through Claude Code
- without mutating Claude's local transcript files
- and without depending on undocumented Claude Code import or checkpoint APIs

## Non-Goals

- Do not attempt to patch or rewrite Claude's local `.jsonl` transcript files.
- Do not rely on undocumented resume-from-message or import-session capabilities.
- Do not claim byte-for-byte equivalence with an internal Claude checkpoint that is not publicly exposed.

## Proposed Strategy

## Hybrid branch strategy

Use two branch creation strategies:

### 1. Native fork

Use the current `--resume ... --fork-session` approach only when branching from the tail assistant message of a branch.

Why:

- tail branching already matches Claude Code's natural session semantics
- it is cheap
- it preserves existing behavior where it is already correct enough

### 2. Prefix replay

Use a new `prefix_replay` strategy when branching from a non-tail assistant message.

Why:

- mid-message branching is where the current semantic mismatch appears
- prefix replay creates a clean new session without carrying later sibling-path turns into the new branch context

## Prefix Replay: Core Idea

Instead of asking Claude Code to fork an existing session tail, create a brand-new Claude Code session whose initial prompt contains only:

1. the visible conversation prefix up to the clicked assistant message
2. a clear statement that this prefix is the complete branch history
3. the user's new branch prompt

That first request creates a fresh branch session. After that, the branch continues normally with `--resume <branchSessionId>`.

## Why This Is The Most Practical Direction

This approach:

- still uses Claude Code for execution
- avoids transcript mutation
- avoids undocumented import behavior
- removes the known sibling-path contamination at branch creation time
- aligns the UI topology more closely with the runtime context topology

It is not a native internal checkpoint fork, but it is a clean, product-grade approximation of "branch from anywhere".

## Required Data Model Changes

Current message records are not strong enough to identify the exact Claude transcript event that a UI bubble came from.

Add transcript-level identifiers to persisted messages.

## Message fields to add

- `claudeMessageUuid: string | null`
- `claudeParentUuid: string | null`
- `claudeSessionId: string | null`
- `claudePromptId: string | null`
- `transcriptTimestamp: string | null`

## Branch fields to add

- `strategy: "native_fork" | "prefix_replay"`
- `sourceClaudeMessageUuid: string | null`
- `replayHash: string | null`
- `replaySourceSessionId: string | null`

## Why these fields matter

They let `netchat` answer:

- which transcript event produced this assistant bubble?
- where exactly should a replay prefix end?
- which branch strategy created this branch?
- can identical replay prefixes be recognized and reused?

Without this metadata, branch-point identification must rely on content matching or timestamps, which is fragile.

## Transcript Indexing

Add a transcript indexing layer in the daemon.

Suggested new modules:

- `apps/daemon/src/transcript-index.ts`
- `apps/daemon/src/prefix-replay.ts`

## Responsibilities of transcript indexing

- locate the transcript file for a given `sessionId`
- parse transcript events into a normalized structure
- identify user, assistant, tool-use, and tool-result segments
- map Claude transcript events back to persisted `netchat` messages
- extract the prefix ending at a selected assistant event

## Prefix Extraction Rules

Given a clicked assistant message `M`:

1. resolve `M.claudeMessageUuid`
2. load the transcript for `M.claudeSessionId`
3. find the exact assistant event for `M`
4. include only the visible branch history from the transcript start through `M`
5. exclude every later event after `M`

For the example:

```text
user1 -> claude1 -> user2 -> claude2
```

If the user branches from `claude1`, the replay prefix must end after `claude1`.

The new branch must not receive:

- `user2`
- `claude2`

## Replay Prompt Format

The replay prompt should be deterministic and stable so the same branch point produces the same prefix text every time.

Suggested shape:

```text
You are continuing a branched conversation.

The transcript below is the complete visible conversation history for this branch.
Anything not included below is intentionally outside this branch and must not be assumed.

Transcript:
[1] User:
...

[2] Assistant:
...

Branch point:
The branch begins immediately after transcript item [2].

New user message:
...
```

## Prompt construction rules

- deterministic formatting
- fixed heading text
- fixed numbering
- no timestamps
- no machine IDs
- no branch IDs
- no workspace-specific metadata unless strictly necessary

This keeps replay prompts stable and makes prompt-prefix reuse more likely if Claude Code benefits from upstream prompt caching.

## Tool History Handling

This is the hardest fidelity problem.

Claude transcripts can contain:

- user text
- assistant thinking
- tool use
- tool result
- final assistant text

For the first implementation, the replay should preserve only the visible conversational state:

- user messages
- final assistant text

Do not replay:

- hidden thinking
- low-level tool event graph

Reason:

- the visible branch semantics are the main product requirement
- hidden/tool replay fidelity is significantly more complex
- the first milestone should solve visible context correctness first

Future improvement:

- add structured summaries of tool use/result blocks when they materially affect branch semantics

## Branch Creation Flow

## Current non-tail flow

```text
UI click -> /api/branches -> fork-branch job -> Claude resume+fork -> store branch
```

## Proposed non-tail flow

```text
UI click
-> /api/branches
-> detect non-tail source message
-> transcript index resolves exact source event
-> prefix replay prompt is built
-> Claude Code starts a brand-new session without --resume
-> new sessionId returned
-> branch is stored with strategy=prefix_replay
```

## Proposed tail flow

Tail branching can continue using:

```text
--resume <sessionId> --fork-session
```

with `strategy=native_fork`.

## Suggested Code Changes

## Shared types

Update:

- `packages/shared/src/index.ts`

Add:

- branch strategy type
- transcript metadata fields
- new runtime request type for prefix replay branching

## Server

Update:

- `apps/server/src/index.ts`
- `apps/server/src/store.ts`
- `apps/server/src/workspace-store.ts` if needed

Responsibilities:

- choose `native_fork` or `prefix_replay`
- persist new message/branch metadata
- expose strategy and transcript-debug data to the UI when developer mode is enabled

## Daemon

Update:

- `apps/daemon/src/runtime.ts`
- `apps/daemon/src/machine.ts`

Add:

- transcript indexing
- prefix replay prompt builder
- runtime method to create a new branch session without resume

Suggested runtime method:

```ts
createBranchFromPrefix(input: PrefixReplayRuntimeRequest): Promise<RuntimeResponse>
```

Where `PrefixReplayRuntimeRequest` contains:

- `sourceSessionId`
- `sourceMessageUuid`
- `prefixMessages`
- `userPrompt`

## UI / developer tooling

Update:

- `apps/web/src/App.tsx`

Developer mode should eventually show:

- branch strategy
- branch session id
- source session id
- source message UUID

This will make it much easier to verify whether the underlying runtime topology matches the visible graph.

## Caching Considerations

## What may help

If Claude Code benefits from Anthropic prompt-prefix caching, replay prompts may be cache-friendly when:

- the replay scaffold is constant
- the serialized prefix is byte-stable
- the model and settings are unchanged
- the branch point is reused multiple times

## What must not be assumed

- prompt cache availability is not guaranteed at the Claude Code CLI layer
- no product logic should depend on cache hits
- current observed transcripts do not provide strong evidence that cache reuse is happening in the existing flow

Conclusion:

- design for deterministic prefixes
- treat cache reuse only as a possible optimization, not as a correctness mechanism

## Validation Plan

Use the known failing scenario:

```text
user1 -> claude1 -> user2 -> claude2
branch from claude1 with user3
```

Expected result under `prefix_replay`:

### netchat DB

- child branch points to `claude1`
- child branch session is a new session
- branch strategy is `prefix_replay`

### Claude transcript

The new session should contain only:

```text
replayed prefix up to claude1
+ new user branch prompt
+ new assistant reply
```

It should not contain:

- `user2`
- `claude2`

### behavioral check

Ask both branches to summarize their branch-only history.

The replay branch should not need an "ignore later messages" instruction to avoid sibling-path leakage, because sibling-path turns were never supplied to that new session.

## Trade-Off Summary

## Pros

- clean mid-message branch semantics
- still uses Claude Code
- no transcript mutation
- much closer match between UI topology and runtime topology
- can coexist with native tail branching

## Cons

- not identical to an internal Claude checkpoint fork
- initial replay prompt can be token-heavy
- tool history fidelity is imperfect in the first version
- requires new transcript metadata plumbing

## Recommended Rollout

### Phase 1

- implement transcript event mapping
- implement `prefix_replay` for non-tail assistant branching
- keep tail branching on `native_fork`

### Phase 2

- add developer visibility for branch strategy and transcript mapping
- record replay hashes and prefix sizes
- compare quality and cost against the current fork mode

### Phase 3

- improve tool-history summarization
- consider branch-point prompt reuse
- evaluate whether tail branching should remain native-only or also support replay

## Final Recommendation

The most promising implementation is a hybrid model:

- tail assistant branch -> `native_fork`
- mid-message assistant branch -> `prefix_replay`

This is the best balance between correctness, implementation complexity, and compatibility with the current Claude Code-based architecture.
