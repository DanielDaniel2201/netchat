# Unified Agent Interface Plan

Snapshot timestamp: 2026-04-03 14:00 UTC+08:00

## Goal

Introduce a unified agent interface so that `netchat` can support more local runtimes without forcing the server and web app to understand each runtime's native protocol.

The intended runtime rollout order is:

1. Codex
2. Droid
3. OpenCode

This document is based on the current Claude-only architecture captured in `2026-04-03-1400-claude-runtime-current-state.md`.

## Core Recommendation

Do add an adapter layer, but place it carefully.

The adapter should not own `netchat` product semantics like:

- branch vs continue
- selection prompt shaping
- visible-path replay construction

Those semantics should stay in the server/shared orchestration layer.

The unified interface should abstract:

- how to start or resume a runtime conversation
- how to stream intermediate reasoning/tool/output signals
- how to return a resumable handle plus final output
- how to report runtime metadata and diagnostics

In other words:

- server decides what conversation should happen
- adapter decides how a specific runtime executes it

## Why The Existing RuntimeAdapter Is Not Enough

There is already a `RuntimeAdapter` in `apps/daemon/src/runtime.ts`, but it is not yet the right boundary for multi-runtime support across the whole app.

### Current limitations

1. It is daemon-local only.
2. It is still shaped around netchat-specific operations:
   - `runRootTurn`
   - `createBranch`
   - `continueBranch`
3. Shared types are still Claude-oriented.
4. The web app still assumes Claude-branded diagnostics and labels.
5. One daemon currently boots exactly one runtime mode: `mock` or `claude`.

So the current adapter is a useful implementation seed, but not yet the unified contract that server and web should depend on.

## Design Principles

### 1. Keep branch semantics above the adapter

Branch creation today is replay-backed and server-owned.

That should remain true in the first unified design. Otherwise every runtime adapter would need to understand:

- branch-from-selection
- branch-from-earlier-message
- visible-path replay
- netchat branch title logic

That would duplicate product logic and make every adapter harder to implement.

### 2. Preserve the machine/job/event transport for the first phase

The server/daemon job transport is already a good local control plane:

- register
- heartbeat
- claim job
- publish events
- complete job

This part is mostly runtime-agnostic already. Reuse it first.

### 3. Generalize contracts before adding more runtimes

Before adding Codex, move the shared boundary from Claude-shaped names to agent-shaped names.

Otherwise Codex support will either:

- leak Codex quirks into Claude-era types
- or force a second refactor immediately after the first adapter lands

### 4. Start with one active runtime per daemon

Do not try to solve "multiple active runtimes inside one graph" in the same first refactor unless it is immediately required.

The lower-risk first milestone is:

- one daemon
- one selected runtime backend
- same web/server flow
- runtime can be swapped by configuration

After that works for Codex, add per-net or per-branch runtime selection, both of which are what actually come in as a new feature.

## Recommended Target Layering

```text
web UI
  ->
server orchestration
  ->
shared unified agent contracts
  ->
daemon runtime registry
  ->
runtime adapters
  -> Claude adapter
  -> Codex adapter
  -> Droid adapter
  -> OpenCode adapter
  -> Mock adapter
```

### Responsibilities by layer

#### Web

- display runtime status and labels
- send turn requests
- render streamed assistant state
- optionally let the user choose a runtime later

#### Server

- decide root vs branch vs continue
- build replay and selection prompts
- persist graph state
- route a job to a runtime target

#### Shared contracts

- define runtime-neutral request, event, result, and diagnostics types

#### Daemon runtime registry

- load the selected runtime adapter
- expose runtime descriptors
- dispatch execution requests to the correct adapter

#### Runtime adapter

- translate unified requests into runtime-native CLI/API calls
- map runtime-native streaming output into unified events
- return final output and continuation handle

## Recommended First Unified Contract

The first unified contract should be narrower and more generic than the current Claude-oriented one.

### Suggested adapter surface

```ts
interface AgentRuntimeAdapter {
  getDescriptor(): AgentRuntimeDescriptor;
  executeTurn(
    input: AgentTurnInput,
    options?: { onEvent?: (event: AgentTurnEvent) => void },
  ): Promise<AgentTurnResult>;
}
```

### Suggested execution input

```ts
type AgentTurnInput = {
  prompt: string;
  session:
    | { mode: "new" }
    | { mode: "resume"; handle: string };
  metadata?: {
    netchatOperation?: "root-turn" | "branch-create" | "branch-turn";
    selectedText?: string | null;
  };
};
```

Why this shape is better than the current one:

- `createBranch` becomes just `session.mode = "new"`
- `continueBranch` becomes `session.mode = "resume"`
- branch replay stays a server concern
- adapters only need to know how to run a new or resumed turn

### Suggested streamed event surface

The current event surface is already a good minimum common denominator:

- thinking updates
- tool updates
- response updates

So the first version can stay close to what already exists:

```ts
type AgentTurnEvent =
  | { type: "thinking.update"; ... }
  | { type: "tool.update"; ... }
  | { type: "response.update"; ... };
```

This is already generic enough for a first pass, as long as the names and docs stop implying Claude-only behavior.

### Suggested result surface

```ts
type AgentTurnResult = {
  handle: string;
  outputText: string;
  runtimeId: string;
  runtimeKind: string;
};
```

Notes:

- `handle` is intentionally more generic than `sessionId`
- if all target runtimes can resume from one opaque string, this can stay a string
- if any target runtime needs richer resume state, promote `handle` to a JSON object before broad rollout

## Suggested Shared Type Migration

The current shared types should be generalized in place or behind aliases.

### Current -> target direction

- `RuntimeResponse` -> `AgentTurnResult`
- `RuntimeStreamEvent` -> `AgentTurnEvent`
- `RuntimeEnvironment` -> `AgentRuntimeEnvironment`
- `runtimeMode` -> `runtimeKind`
- `claudeInstalled` -> `installed`
- `claudeVersion` -> `version`
- `claudePath` -> `executablePath`

### Important naming choice

Do not keep adding new runtimes behind Claude-shaped field names. That will make the shared schema increasingly misleading.

## Diagnostics and Environment Plan

The diagnostics model needs to stop assuming Claude.

### Recommended environment shape

```ts
type AgentRuntimeEnvironment = {
  platform: HostPlatform;
  arch: string;
  runtimeKind: "claude" | "codex" | "droid" | "opencode" | "mock";
  runtimeLabel: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  workingDirectory: string;
  detectionError: string | null;
};
```

This lets the web render runtime identity without hard-coded Claude copy.

### Web changes implied by this

Replace hard-coded strings like:

- `Claude Code`
- `Claude`
- `Waiting for Claude to respond...`

with runtime-driven labels from diagnostics or from message metadata.

## Data Model Considerations

The current persistence model stores:

- `sessionId`
- `machineId`

That is sufficient only as long as:

- one machine maps to one runtime
- one opaque string is enough to resume a runtime session

### Safe first phase

If the first multi-runtime step is only "swap the entire daemon runtime backend", the database can likely remain mostly unchanged, with a generic rename from `sessionId` to `handle` deferred if needed.

### Required before mixed-runtime graphs

If a single app instance will later allow different branches or nets to run on different runtimes, then persistence should also record runtime identity per branch and message, for example:

- `runtimeKind`
- `runtimeId`
- `runtimeHandle`

Without this, a stored branch cannot reliably say which adapter should resume it.

## Suggested Delivery Phases

### Phase 0: Documentation

Done in this change:

- current Claude runtime snapshot
- unified interface planning note

### Phase 1: No-behavior-change refactor

Refactor names and boundaries without changing runtime behavior.

Suggested work:

- generalize shared runtime types
- generalize daemon environment detection shape
- move Claude and Mock into explicit adapter implementations
- replace Claude-specific UI labels with runtime-driven labels

Outcome:

- behavior stays Claude-backed
- app contracts stop being Claude-shaped

### Phase 2: Single-runtime registry with Codex

Add a daemon runtime registry and support selecting one backend at boot.

Suggested work:

- `NETCHAT_RUNTIME=claude|codex|mock`
- registry creates the right adapter
- Codex adapter implements the unified turn contract
- server/web remain unchanged except for generalized contracts

Outcome:

- Codex can replace Claude as the active runtime backend
- no per-branch runtime mixing yet

### Phase 3: Per-net runtime selection

Once one-runtime swap works, allow the workspace or each net to choose its runtime.

Suggested work:

- store runtime choice in workspace/net metadata
- include runtime kind in job payloads
- expose runtime list from daemon or server
- let the web pick a runtime when creating a new net or editing runtime settings

Outcome:

- different nets can use different runtimes
- routing becomes explicit and persistent

### Phase 4: Mixed-runtime graphs, if needed

Only do this if the product truly needs branches under the same canvas to target different runtimes.

Suggested work:

- store runtime identity on each branch
- possibly store runtime identity on each message
- adapt continuation routing to branch-level runtime selection

Outcome:

- one graph can carry multiple runtime backends safely

## Codex-First Scope Recommendation

For the first implementation pass, keep the scope tight.

Recommended target:

1. Generalize the shared contracts.
2. Replace hard-coded Claude labels in the UI.
3. Introduce a runtime registry in the daemon.
4. Keep one active runtime per daemon.
5. Implement the Codex adapter against that unified contract.

Do not combine that with:

- mixed-runtime graph support
- database schema redesign beyond what is necessary
- large UI changes for runtime selection

That keeps the first adapter effort focused on the real compatibility problem instead of spreading across product and persistence redesign at the same time.

## Open Questions To Resolve Before Implementation

### 1. Resume handle shape

Can Codex, Droid, and OpenCode all resume with one opaque string, or does any of them require a richer resume payload?

### 2. Event fidelity

Can each runtime surface:

- reasoning/thinking
- tool calls
- tool results
- partial answer text

If not, the unified event model should allow graceful degradation to response-only streaming.

### 3. Workspace isolation

Does any target runtime need a different working-directory or process-isolation model than Claude Code does today?

### 4. Runtime selection granularity

Is the near-term product goal:

- one runtime for the whole app
- one runtime per net
- one runtime per branch

The data model should be changed only as far as the real requirement demands.

## Recommended Next Implementation Step

The next code change should not be "add Codex directly into the current Claude-shaped contracts."

The next step should be:

1. rename and generalize the shared runtime contracts
2. refactor the daemon adapter interface to one generic `executeTurn(...)`
3. make the web render runtime-driven labels
4. keep Claude as the only real backend until the contract is clean

After that, add the Codex adapter as the first non-Claude implementation of the same contract.
