# Changelog

## Changelog rule

After each commit, update the Changelog under the current date. Each entry must be short, specific, and describe the actual change and its impact; do not copy vague commit messages. Prioritize new features, behavior changes, bug fixes, and API/config/schema updates. Use a consistent date + bullet list format, with one change per bullet, so others can understand it immediately.

## 2026-04-07

- Switched local app startup from a single runtime daemon to parallel Claude/Codex/Droid daemons, exposed `/api/agents`, and routed turns by stable `runtimeId` so nets can target an agent without setting `NETCHAT_RUNTIME` before launch.
- Added net-scoped agent persistence to `workspace.json` plus runtime metadata on branches/messages, so reopening a historical net keeps its original agent choice and branch/session resumes survive daemon restarts without relying on stale random machine ids.
- Added a new-net agent dropdown beside the workspace path, surfaced each net's bound agent in the history drawer and header status, and blocked sending when the selected net agent is offline or missing so agent selection is explicit and visible in the UI.

## 2026-04-06

- Added a unified agent runtime contract across shared/server/daemon layers, so netchat now executes generic `executeTurn` requests with runtime-neutral events, results, and diagnostics instead of Claude-shaped adapter methods.
- Added a Codex CLI adapter beside Claude and Mock, generalized runtime working-directory/binary configuration, and switched the web runtime chrome to use daemon-provided runtime labels instead of hard-coded Claude copy.
- Added a Droid CLI adapter with resumable session handles, streamed tool/result event mapping, and daemon CLI support for `--runtime droid` plus `--droid-binary`.
- Restored visible assistant text streaming in the web UI by preserving in-progress `responseText`, and stopped Claude's empty final `result` event from briefly clearing streamed output before commit.

## 2026-03-28

- Switched non-tail branching to start a fresh Claude session from a replayed visible-path prefix, so later sibling messages no longer leak into branch context.
- Kept tail replies in their current session and treated tail text selections as focused continuations instead of creating unnecessary branches.
- Updated the branching design note to align product semantics around continue-vs-branch and document `/rewind` as a future runtime direction rather than a production dependency.
- Added history-net rename and delete actions in the workspace drawer, and kept the list sorted by each net's latest message time so saved nets stay in a stable, conversation-driven order.
- Rendered selection-based branch anchors inline inside Claude replies, so selection forks now start from the highlighted text itself and clicking that text reactivates the branch path highlight.

## 2026-03-30

- Prevented repeated empty-net creation when `New net` is clicked while the active canvas is already the blank new-net state, so the history list no longer accumulates duplicate empty nets.
- Merged user-bubble selected-passage quotes into the primary `User` header strip and removed the duplicate inner `User` bar, tightening the layout and reducing redundant chrome.
- Restored Claude bubble markdown rendering by moving selection-branch anchors out of the markdown text flow into a dedicated anchor button strip, and fixed anchor toggles so expand/collapse is driven only by clicking those buttons.
- Fixed selected-passage quote bars in user bubbles so continuation and branch messages immediately show the persisted quoted passage with readable styling instead of broken quote characters.
- Let the canvas thumbnail pan from anywhere inside the minimap instead of only dragging the viewport rectangle, so preview nodes no longer block free minimap dragging.
- Replaced the anchor button strip with line-aware left/right gutters around assistant markdown content, placing each branch anchor near its selected passage line while preserving markdown rendering and stabilizing click-to-toggle behavior.
- Stabilized gutter anchor behavior by preserving per-anchor layout identity across rerenders, using consistent text-node offsets for selections, and unblocking anchor button click events that were being intercepted in capture handlers.
- Fixed gutter anchor line placement after canvas zoom by converting selection rect measurements back into the markdown container's local coordinate system before positioning buttons.
- Corrected legacy anchor line drift by validating stored selection offsets against rendered text and falling back to the nearest selected-text match when older branch metadata points at the wrong line.
- Stopped Claude streaming patches from rebuilding the full React Flow graph on every token/block update, froze streaming bubble height relayout until completion, and refreshed dynamic anchor handles so branch canvases no longer blink blank or lose edges until a manual refresh.

## 2026-03-31

- Added branch-reveal camera framing for gutter selection buttons, so expanding a collapsed branch now pans and zooms to place its first user bubble at the top of the viewport, centered at roughly five-sixths of the screen width.
- Fixed the branch-reveal viewport trigger to resolve targets from the rendered flow graph instead of React Flow's lagging internal node registry, so the camera move no longer gets dropped during the same render that expands the branch.
- Added a second-level `Thinking & Tools` accordion around Claude trace blocks, so users can collapse the whole trace stack without losing the existing per-block fold controls.
- Simplified the `Thinking & Tools` accordion header by defaulting it closed and removing block-count and expand/collapse status text, leaving a cleaner single-line toggle.

## 2026-04-02

- Prepared npm first-release metadata by renaming the root package to `@danielwyq/netchat`, setting version `0.0.1`, and adding repository/homepage/bugs/keywords fields for publish discoverability.
- Updated CLI help text and command examples across entrypoints to use `npx @danielwyq/netchat@latest`, matching the intended public usage.
- Added a top-level README focused on npm users with quick-start commands, help entrypoints, cache freshness guidance, environment variables, and Node.js runtime requirements.
- Changed launch behavior to land on a blank new net when the last active net already has messages, while keeping history nets accessible from the drawer instead of reopening an old conversation by default.
- Stopped auto-selecting the latest assistant reply when a net loads, so historical nets now open on the main trunk only and selection branches stay collapsed until the user explicitly toggles their anchor.
- Removed pairing-code and machine-state setup from the localhost controller/daemon flow, so the local app now boots a single local runtime without a pairing step or `machine.json`.
- Removed the public multi-machine surface from the web app and switched local-app readiness checks to daemon diagnostics, simplifying connection status around one active local runtime.
- Updated `AGENTS.md` and `README.md` to match the current single-runtime local-first model and removed stale pairing and machine-state references.
