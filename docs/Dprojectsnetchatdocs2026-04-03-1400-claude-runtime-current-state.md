# Claude Code Runtime Current State

Snapshot timestamp: 2026-04-03 14:00 UTC+08:00

## Purpose

This document records how `netchat` currently integrates Claude Code before any unified multi-runtime interface exists.

The goal is to capture the actual runtime boundary in the codebase today, not the idealized future design.

## Short Answer

Claude Code is not wired directly into the web app or the server.

Today, Claude Code acts as the concrete execution backend behind a daemon-local adapter. The daemon translates Claude CLI behavior into a small set of `netchat` contracts, and the rest of the app talks to those contracts rather than to Claude CLI directly.

The real upward-facing boundary today is:

1. daemon-local runtime methods in `apps/daemon/src/runtime.ts`
2. shared wire contracts in `packages/shared/src/index.ts`
3. the server/daemon machine-job-event protocol

There is already a `RuntimeAdapter` interface in the daemon, but it is only an internal abstraction between:

- `ClaudeCliRuntime`
- `MockRuntimeAdapter`

It is not yet a cross-app, cross-runtime unified agent interface.

## What Claude Code Provides Upward Today

At the current boundary, Claude Code effectively provides four things upward.

### 1. Turn execution

The daemon exposes three netchat-shaped operations:

- `runRootTurn`
- `createBranch`
- `continueBranch`

All three return the same final payload:

- `sessionId`
- `assistantMessage`
- `machineId`

Important detail:

- root continuation uses Claude `--resume <sessionId>`
- branch continuation uses Claude `--resume <sessionId>`
- non-tail branch creation starts a fresh Claude session and does not resume the old one

### 2. Session continuity

Claude Code provides a resumable session identity through `sessionId`.

`netchat` persists that session id onto both:

- `branches.session_id`
- `messages.session_id`

That persisted session id is what lets later turns continue the same runtime conversation.

### 3. Streaming assistant trace

Claude CLI `stream-json` output is translated into a runtime-neutral event stream with three event kinds:

- `thinking.update`
- `tool.update`
- `response.update`

This is the core trace surface that the server and web app consume during streamed turns.

### 4. Environment and diagnostics

The daemon detects and reports Claude-specific environment data:

- whether Claude is installed
- Claude version
- Claude binary path
- working directory
- runtime mode (`claude` or `mock`)

This data is surfaced through daemon diagnostics and rendered by the web UI as connection status.

## What Claude Code Does Not Provide Upward Today

Claude Code does not currently provide the full product behavior upward. Several important semantics are still owned by `netchat` itself.

### Product semantics owned by server/shared code

- deciding whether a user action is a root turn, branch creation, or branch continuation
- deciding when a text selection becomes a focused continuation vs a new branch
- building replay prompts for non-tail branching
- building selection-focused prompts
- optimistic UI snapshots
- graph persistence
- branch/message topology

### Missing generic runtime concepts

- no runtime registry
- no runtime capability model
- no runtime-agnostic environment shape
- no per-turn runtime selection
- no adapter/plugin boundary that server and web can target directly

## Current Layer Map

### Web

The web app only talks to server HTTP endpoints.

For streamed turns it calls:

- `POST /api/root-turn/stream`
- `POST /api/branches/stream`
- `POST /api/branches/:branchId/turns/stream`

The web app never calls Claude CLI and does not call the daemon runtime directly for turn execution.

### Server

The server owns:

- input validation
- prompt shaping
- branch replay construction
- machine selection
- streaming response framing
- SQLite persistence
- workspace/net management

The server does not run Claude directly.

Instead, it enqueues jobs for a machine and receives streamed runtime events plus a final response.

### Daemon

The daemon owns:

- Claude installation detection
- Claude CLI invocation
- Claude stream parsing
- translation from Claude stream-json to shared runtime events
- machine registration, heartbeat, job claim, event publish, completion report

This is the only place where the current codebase truly knows how to speak to Claude Code.

### Shared contracts

`packages/shared/src/index.ts` defines the cross-process contracts currently used by web, server, and daemon.

These include:

- `RuntimeStreamEvent`
- `RuntimeResponse`
- machine registration / heartbeat / job / completion schemas
- graph and assistant-state types

## End-to-End Control Plane

Before any turn runs, the daemon and server establish a local control plane.

### Boot

1. The daemon starts and calls `createRuntimeAdapter()`.
2. `createRuntimeAdapter()` selects either `ClaudeCliRuntime` or `MockRuntimeAdapter`.
3. The daemon detects the runtime environment.
4. `MachineClient` registers the daemon with the server.
5. The daemon starts heartbeat and job polling loops.

### Registration and heartbeat responsibilities

The daemon sends:

- machine name
- runtime environment snapshot
- heartbeat updates

The server keeps:

- machine id
- machine secret
- online/offline status
- pending jobs
- in-flight jobs

This part is already mostly runtime-agnostic. The Claude-specific part is the environment payload shape.

## End-to-End Turn Flow

The runtime chain is easiest to understand by following a streamed turn from web to Claude and back.

### A. Web chooses the turn shape

In `apps/web/src/App.tsx`, the composer chooses one of these modes:

- root turn
- continue root
- branch from earlier message
- branch from earlier selection
- continue existing branch

The web app also creates an optimistic snapshot so the canvas can show a pending user bubble and an empty assistant bubble immediately.

### B. Web sends a streamed request to server

The web sends a POST request to the server and then reads newline-delimited JSON from the response stream.

The streamed event types that the web consumes are:

- `turn.bootstrap`
- `assistant.patch`
- `turn.committed`
- `turn.error`

These are server-shaped UI events, not direct Claude events.

### C. Server translates UI intent into runtime intent

The server decides what prompt should actually reach the runtime.

#### Root turn / branch continuation with selected text

If the user selected text in the active tail, the server builds a focused prompt with `buildSelectionPrompt(...)`.

That means selection semantics are currently server-owned, not runtime-owned.

#### Non-tail branch creation

If the user branches from an earlier assistant message, the server builds a replay prompt with `buildPrefixReplayPrompt(...)`.

This is important:

- Claude is not asked to fork an existing hidden session here
- the server reconstructs the visible path as plain prompt text
- the runtime only sees "start a fresh session with this replay prompt"

This is one of the most important current design facts for any future unified interface.

### D. Server enqueues a job

The server calls `MachineStore.enqueueStreamingJob(...)` with one of three job kinds:

- `root-turn`
- `branch-create`
- `branch-turn`

The job payload is currently small:

- root turn: `{ prompt, sessionId | null }`
- branch create: `{ prompt }`
- branch turn: `{ prompt, sessionId }`

The server also opens its own NDJSON stream back to the web client and starts listening for runtime events.

### E. Daemon claims the job

The daemon polls:

- `POST /api/daemon/jobs/claim`

When it gets a job, it dispatches by job kind:

- root turn -> `runtime.runRootTurn(...)`
- branch create -> `runtime.createBranch(...)`
- branch turn -> `runtime.continueBranch(...)`

### F. ClaudeCliRuntime runs Claude CLI

`ClaudeCliRuntime` builds a Claude CLI invocation like this:

- `claude -p --verbose --output-format stream-json --include-partial-messages ...`

Possible extra flags include:

- `--resume <sessionId>`
- `--setting-sources ...`
- `--permission-mode ...`
- `--dangerously-skip-permissions`

Important current behavior:

- root continuation and branch continuation are implemented by passing `--resume`
- branch creation is implemented as a fresh session

### G. Daemon translates Claude stream-json into netchat runtime events

The daemon parses several Claude stream shapes:

- raw `stream_event`
- assistant messages
- user tool-result messages
- final `result`

It converts them into shared `RuntimeStreamEvent` values.

#### Thinking blocks

Claude thinking or redacted-thinking blocks become:

- `thinking.update`

#### Tool activity

Claude tool use and tool result blocks become:

- `tool.update`

This includes:

- tool call id
- tool name
- tool input text
- tool output text
- complete/error state

#### Final or partial answer text

Claude text deltas and final result text become:

- `response.update`

### H. Daemon streams events back to server

For every runtime event, the daemon calls:

- `POST /api/daemon/jobs/:jobId/events`

When execution finishes, it calls:

- `POST /api/daemon/jobs/:jobId/complete`

On success, the completion payload contains the final `RuntimeResponse`.

### I. Server translates runtime events into UI assistant state

The server subscribes to runtime events for the in-flight job.

It merges them into `AssistantStreamState`:

- thinking blocks
- tool-call blocks
- response text
- streaming / complete / error status

The server then streams UI-facing NDJSON patches to the web app.

This means the web UI does not understand Claude stream-json directly. It only understands server-shaped assistant state.

### J. Server commits the final graph snapshot

After the job resolves, the server persists the result into SQLite through `WorkspaceStore` and `GraphStore`.

The final commit writes:

- branch `session_id`
- branch `machine_id`
- user message row
- assistant message row
- final assistant stream state

The server then emits `turn.committed` to the web app with the full committed graph snapshot.

## Persistence Model

Claude runtime identity currently reaches persistence in a narrow way.

### Stored on branches

- `sessionId`
- `machineId`

### Stored on messages

- `sessionId`
- `machineId`

### Stored separately for streamed assistant traces

- `assistant_states.state_json`

### Workspace/net layer

Above the graph store, `WorkspaceStore` keeps:

- workspace manifest in `workspace.json`
- one SQLite database per net

The runtime itself does not manage this persistence.

## Claude-Specific Details That Leak Upward

Several surfaces are still specifically shaped around Claude Code.

### Shared environment shape

`RuntimeEnvironment` contains:

- `claudeInstalled`
- `claudeVersion`
- `claudePath`
- `runtimeMode: "mock" | "claude"`

This is not ready for multiple runtimes.

### UI labels

The web UI still contains Claude-branded copy such as:

- `Claude Code`
- `Claude`
- `Waiting for Claude to respond...`

### Session terminology

The app assumes a single resumable `sessionId` string is the runtime continuation token.

That may or may not be sufficient for other runtimes.

## Existing Internal Adapter vs Missing Unified Interface

It is important to separate these two ideas.

### What already exists

There is already an internal adapter interface:

```ts
interface RuntimeAdapter {
  runRootTurn(...)
  createBranch(...)
  continueBranch(...)
  getMode()
  getWorkingDirectory()
}
```

This adapter exists only inside the daemon.

### What does not exist yet

There is not yet a unified interface that all upper layers target. In particular:

- server contracts are still named around `Runtime*`, not `Agent*`
- the environment schema is Claude-specific
- the runtime method surface is netchat-turn-specific rather than runtime-generic
- runtime identity is not modeled separately from machine identity
- web copy and diagnostics still assume Claude as the primary runtime

## Core Implication

At this timestamp, Claude Code's role inside `netchat` is:

- execute prepared prompts
- resume Claude sessions when asked
- emit streaming thought/tool/text signals
- return a final answer plus a session id

Everything else that makes the product feel like `netchat` is implemented above Claude Code in the server, shared contracts, persistence layer, and web UI.

That is the baseline that the future Unified Agent Interface should preserve while removing Claude-specific assumptions from the shared boundary.
