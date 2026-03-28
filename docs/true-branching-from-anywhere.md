# Branching From Earlier Messages

## Summary

`netchat` should model only two compose actions:

1. continue the current conversation
2. branch from an earlier point

There should not be a first-class "tail branch" concept.

If the user replies to the latest assistant message on the active lane, that is a normal continuation of the same conversation. If the user replies to any earlier assistant message, or to a selection inside any earlier assistant message, that is a new branch.

The current implementation for non-tail replies uses Claude Code `--resume <sessionId> --fork-session` plus an anchor prompt. That creates a visually correct branch in the canvas, but not a clean runtime branch in Claude's underlying session transcript. Later sibling-path turns can still remain in the forked session history.

This document updates the earlier proposal after reviewing Claude Code checkpointing and `/rewind`.

## Problem Summary

Current non-tail branching behaves like this:

1. read the clicked message's `sessionId`
2. call Claude Code with `--resume <sessionId> --fork-session`
3. append an anchor prompt telling Claude to ignore later turns and continue from the earlier message

This means the new session can physically inherit turns that are outside the visible branch point.

## Example Failure Mode

Visible graph:

```text
user1 -> claude1 -> user2 -> claude2
                  \
                   -> user3 -> claude3
```

Desired semantics for the lower path:

```text
claude3 should see only:
user1 -> claude1 -> user3
```

Observed current behavior:

```text
claude3 may actually be generated from:
user1 -> claude1 -> user2 -> claude2 -> anchor prompt -> user3
```

Claude may often follow the prompt and behave as if `user2` and `claude2` are outside the branch, but that correctness depends on prompt following rather than on clean session topology.

## Updated Product Semantics

### 1. Continue current conversation

If the user replies to the latest assistant message on the active lane, the reply continues the current branch and should stay in the current Claude session.

This is true even if the user selected a passage inside that latest assistant message. A selection on the current tail is a context-shaping affordance, not a new branch by itself.

### 2. Branch from an earlier point

If the user replies to any non-latest assistant message, the reply creates a new child branch.

If the user replies to a text selection inside any non-latest assistant message, that also creates a new child branch.

So the model is:

- tail reply -> continue
- earlier reply -> branch

not:

- tail branch
- middle branch

### 3. Selection is not its own branch strategy

Selection should not define a separate runtime strategy. It only narrows the context within the source assistant message.

The branch decision should come from whether the source assistant message is the current tail on the visible path:

- selection on tail -> continue with selection-scoped prompt
- selection on earlier message -> branch from earlier point with selection-scoped prompt

## Key Insight From Claude Code Checkpointing

Claude Code interactive mode provides `/rewind`, which is the closest native semantic we have found to "go back to this earlier point in the same conversation".

Public checkpointing docs say:

- every user prompt creates a checkpoint
- `/rewind` shows a list of prompts from the session
- the user can choose:
  - restore code and conversation
  - restore conversation
  - restore code
  - summarize from here
- after restoring conversation, the original prompt from the selected point is restored into the input box so it can be re-sent or edited

This matters because it suggests a better conceptual model for non-tail branching than "fork the session tail and add an anchor prompt".

## Prompt-Level Mapping

`/rewind` is prompt-based, not assistant-message-based.

That means the natural mapping from a clicked assistant message `A` is:

- find the first later user prompt on the same visible path
- rewind to that prompt
- restore conversation
- replace or edit the restored prompt with the new branch prompt

Example:

```text
user1 -> claude1 -> user2 -> claude2
```

If the user wants to branch from `claude1` with `user3`, the natural checkpoint target is `user2`.

Why:

- rewinding to `user2` and restoring conversation puts the conversation back to the state immediately after `claude1`
- `user2` then returns to the input box
- `netchat` could replace that restored text with `user3`

This is much closer to a true conversation rewind than replaying a visible prefix into a brand-new session.

## Important Constraint

Today, `/rewind` is only documented as an interactive slash command.

The public docs currently show:

- `/rewind` in interactive mode
- `--resume` / `--fork-session` in CLI mode

but do not show a documented equivalent like:

```text
claude --resume <session> --rewind <checkpoint>
```

The public SDK docs also show that slash commands can be sent through the SDK, but do not document a structured, headless way to:

1. enumerate rewind checkpoints
2. choose one programmatically
3. choose `Restore conversation` or another action
4. continue with a new prompt without going through the interactive menu

So `/rewind` is an important semantic clue, but not yet a stable headless API surface we can build the product around.

## Design Goal

Support a branch from an earlier assistant message or earlier selection such that:

- the visible graph semantics stay honest
- the runtime implementation is robust in a headless daemon architecture
- the system can adopt a future checkpoint-backed implementation if Claude exposes one
- the product model stays simple: continue vs branch-from-earlier-point

## Non-Goals

- Do not introduce a first-class `tail branch` concept in the product model.
- Do not automate the interactive `/rewind` menu as the default production path.
- Do not mutate Claude transcript files.
- Do not rely on undocumented checkpoint-selection or transcript-import APIs.
- Do not index the entire low-level Claude tool event graph unless it becomes necessary.

## Recommended Runtime Architecture

### One branch abstraction, two possible backends

For `netchat`, non-tail branching should be modeled as one capability:

```ts
createBranchFromEarlierPoint(...)
```

The runtime can support different backends under that abstraction:

- `replay-backed`
- `checkpoint-backed` (future)

Continuation remains a separate capability:

```ts
continueConversation(...)
```

This is cleaner than splitting the product model into `native_fork` tail branching versus `prefix_replay` middle branching.

### Backend A: Replay-backed branch

This should be the default implementation now.

For any non-tail assistant message or non-tail selection:

1. collect the visible conversation history up to the source assistant message
2. create a brand-new Claude session
3. send a deterministic prompt containing:
   - the visible history up to the branch point
   - the branch-point statement
   - the new user prompt
   - selection context if the user branched from a text span

#### Why this is still the best default today

- it works in the current headless daemon architecture
- it does not require TUI automation
- it does not mutate an existing interactive session
- it keeps runtime behavior deterministic and testable
- it avoids workspace rewinds in a shared working directory

#### What it does not provide

- it is not a true Claude checkpoint branch
- it can be token-heavy for long histories
- first versions will only preserve visible conversation state well
- tool/result fidelity can still diverge from the original session

### Backend B: Checkpoint-backed branch

This is the future-preferred backend if Claude exposes a stable programmable checkpoint surface.

Desired flow:

1. identify the source assistant message `A`
2. map `A` to the first later user prompt `U_next` on the same visible path
3. create an isolated scratch runtime context for the new branch
4. resume or fork the source Claude session inside that isolated context
5. rewind to `U_next`
6. choose `Restore conversation` or, in carefully isolated cases, `Restore code and conversation`
7. replace the restored prompt with the new branch prompt
8. bind the resulting Claude session to the new netchat branch

#### Why this is preferable if it becomes possible

- it is closer to native Claude conversation semantics
- it preserves more hidden session state than replay
- it avoids reconstructing long visible prefixes by hand
- it makes "branch from earlier point" a true runtime operation rather than a prompt reconstruction trick

### Why it is not the default today

#### 1. No documented headless rewind API

The current docs do not expose a public non-interactive way to select a checkpoint and action.

#### 2. Interactive automation would be brittle

Automating `/rewind` through a PTY or TUI driver would be fragile across:

- terminal differences
- Windows behavior
- Claude UI changes
- focus / timing / scroll behavior

#### 3. Workspace restore has real side effects

Checkpointing docs explicitly say:

- bash-command file changes are not tracked
- external changes are not reliably tracked

So using `Restore code and conversation` in a shared workspace could create surprising state rollbacks.

If a checkpoint-backed backend is ever attempted before a better API exists, it should only run behind a feature flag and inside isolated per-branch worktrees or equivalent isolated directories.

## Data Model Guidance

The previous proposal leaned toward transcript-event-level metadata such as raw Claude message UUIDs for every low-level event.

After reviewing checkpointing, the more useful future-facing metadata appears to be prompt-oriented, not raw event-oriented.

### Persist what maps to prompt boundaries

When available, prefer storing fields like:

- `claudeSessionId`
- `claudePromptId` or `claudePromptOrdinal`
- `responseToPromptId`
- `sourcePromptId` for a derived branch

This supports the mapping that `/rewind` actually exposes: prompt checkpoints.

### Do not over-invest in raw transcript event plumbing yet

We should not assume that a future production implementation needs:

- low-level tool event UUIDs
- full event-graph parent pointers
- replay hashes tied to internal transcript layout

Those can be added later if real runtime evidence shows they are required.

## UI Semantics

UI copy and behavior should reflect the simpler model:

- reply on current tail -> continue this conversation
- reply on earlier assistant -> create a new branch
- selected text only changes what context is emphasized; it does not create a different branching category

Developer tooling can still expose runtime details such as:

- branch backend: `replay` or `checkpoint`
- source message id
- source prompt id
- source session id
- branch session id

But that is debugging information, not product language.

## Validation Scenarios

### Scenario A: continue at tail

```text
user1 -> claude1 -> user2 -> claude2
reply to claude2 with user3
```

Expected:

- stay in the same branch
- stay in the same Claude session
- no new branch node is created

### Scenario B: branch from earlier assistant

```text
user1 -> claude1 -> user2 -> claude2
branch from claude1 with user3
```

Expected:

- create a new child branch from `claude1`
- new branch should not depend on sibling-path turns for correctness
- current default backend may be replay-backed
- future checkpoint-backed backend would map `claude1` to checkpoint `user2`

### Scenario C: branch from earlier selection

```text
user1 -> claude1(long reply) -> user2 -> claude2
branch from a selected span inside claude1 with user3
```

Expected:

- create a new child branch
- selected text narrows the branch prompt
- branch still semantically starts from the earlier assistant message, not from a new special selection-only session primitive

## Recommended Rollout

### Phase 1

- update product and UI language to `continue` vs `branch from earlier point`
- remove `tail branch` from design terminology
- use replay-backed branching for all non-tail branch creation
- treat selection as scoped context, not its own branch strategy

### Phase 2

- persist prompt-oriented metadata where available
- expose debug visibility for source session, source prompt, and runtime backend
- measure prompt size and quality of replay-backed branches

### Phase 3

- monitor Claude Code for a documented programmable checkpoint API
- if such an API appears, add a `checkpoint-backed` backend behind a feature flag
- only consider enabling it by default once workspace isolation and runtime reliability are proven

## Final Recommendation

`netchat` should stop thinking in terms of `tail branch` versus `middle branch`.

The right product model is:

- reply to the latest assistant -> continue
- reply to any earlier assistant or earlier selection -> branch

The right implementation model today is:

- non-tail branch = replay-backed new session

The right future direction is:

- adopt a checkpoint-backed backend if Claude exposes a real headless way to leverage `/rewind`

That keeps the product semantics clean today while leaving room for a genuinely more native branch primitive later.
