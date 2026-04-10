# Changelog

## 2026-04-10

- Removed the badge box chrome around composer agent icons and switched Codex/Droid marks to dark-on-light rendering, so runtime icons now read as clean standalone glyphs instead of boxed logos.
- Replaced the new-net runtime `<select>` with an icon-based agent menu and added matching read-only agent badges to reply composers, so Claude/Codex/Droid selection now stays visually consistent across empty and active net flows.
- Stopped workspace rows from auto-switching the active net when expanded, defaulted workspace ordering to newest-created first with client-side drag reordering, folded net timestamps and menus into a tighter single-line row, and made the collapsed sidebar collapse all the way down to just the three action buttons.
- Turned workspace rows into the expand target, replaced the separate right-side toggle button with a passive arrow indicator, and added workspace deletion from a trash icon that removes only netchat's local workspace data.
- Flattened the sidebar's workspace and net rows and moved each workspace expand toggle to the far right, so the left rail reads more like a compact list than stacked cards.
- Reduced sidebar chrome to a single `NetChat` title, removed redundant workspace metadata, and switched net subtitles to compact relative ages like `43m` and `4d` so the left rail stays focused on names and recency.
- Fixed workspace net action menus being clipped inside single-net sections by letting the active workspace card overflow above its container, so `Delete` remains reachable from the three-dot menu.
- Shrunk the canvas minimap preview to two-thirds of its previous width and height, reducing the bottom-right thumbnail footprint without changing its drag or viewport behavior.
- Rebalanced the app's typography, bubble widths, side gutters, and composer sizing so the canvas now feels correct at normal browser page zoom (`100%`) instead of only looking comfortable after zooming the browser out.
- Simplified the left net sidebar into a collapsible navigation rail, removing the oversized current-net summary and sidebar agent picker so workspace and net switching stay focused on navigation instead of duplicated runtime chrome.
- Tightened branch reveal and fallback canvas framing zoom caps, so expanding selection branches no longer snaps the React Flow viewport into an overly close camera on wider layouts.
- Estimated the initial canvas camera from the actual desktop canvas width and skipped the sidebar's first-paint width transition, so opening the app no longer depends on a transient full-window measurement before the sidebar settles.
- Moved net and workspace management out of the top-right header into a persistent left sidebar, adding machine-local workspace discovery, grouped nets, collapsible workspace sections, and a current-net summary that keeps the canvas focused on one active workspace.
- Added native folder-picker workspace opening plus cross-workspace net switching on the sidebar, so existing local folders can be registered and revisited without starting the app from that directory.
- Passed the active workspace working directory through server and daemon turn payloads, so Claude/Codex/Droid jobs now execute against the selected workspace path instead of the controller's launch directory.

## 2026-04-09

- Added a repo-local `check-postmortem` skill plus a postmortem indexing script, so agents fixing stubborn bugs can quickly scan historical bug reports by `title` and `summary` before opening the full write-up.

## 2026-04-08

- Switched the local app's default controller and daemon URLs from `127.0.0.1` to `localhost`, so browser auto-open, runtime wiring, and CLI examples now consistently use the project's advertised localhost loopback host.
- Removed the server-side machine job time limit and marked diagnostics as unbounded, so long-running turns now rely only on the runtime inactivity timeout instead of being force-failed after a fixed total duration.
- Stabilized React Flow handle refreshes in selection-enabled message nodes, so Claude/Codex stream completion no longer risks a `Minified React error #185` infinite update loop in the canvas.
- Narrowed top-level assistant-stream subscriptions and stabilized viewport/composer state updates, so streaming replies no longer force the entire canvas app through avoidable React/React Flow update cycles on every token.
- Rendered in-progress assistant replies as lightweight plain text until stream completion, so very long markdown/code responses no longer reparse and relayout the full markdown tree on every token mid-stream.
- Fixed the canvas camera to use a controlled React Flow viewport instead of relying on one-time `defaultViewport` initialization, so `npm run app:local` now opens nets at the intended default zoom instead of falling back to an oversized `scale(1)` first paint.

## Changelog rule

After each commit, update the Changelog under the current date. Each entry must be short, specific, and describe the actual change and its impact; do not copy vague commit messages. Prioritize new features, behavior changes, bug fixes, and API/config/schema updates. Use a consistent date + bullet list format, with one change per bullet, so others can understand it immediately.

## 2026-04-07

- Fixed minimap recentering at extreme zoom-out by centering non-pannable axes instead of clamping them to the thumbnail's top-left corner, so clicking a fully-covered minimap no longer shoves the canvas graph off toward the upper-left.
- Reset the canvas viewport whenever the active net changes and always reopen a net from the root session's first user bubble, so zoom/pan state from one net no longer leaks into another net's default camera position.
- Normalized the published CLI `bin` metadata to an explicit `{ "netchat": "bin/netchat.mjs" }` mapping, so npm no longer has to rewrite the package manifest during publish and the installed command name stays stable.
- Switched local app startup from a single runtime daemon to parallel Claude/Codex/Droid daemons, exposed `/api/agents`, and routed turns by stable `runtimeId` so nets can target an agent without setting `NETCHAT_RUNTIME` before launch.
- Added net-scoped agent persistence to `workspace.json` plus runtime metadata on branches/messages, so reopening a historical net keeps its original agent choice and branch/session resumes survive daemon restarts without relying on stale random machine ids.
- Added a new-net agent dropdown beside the workspace path, surfaced each net's bound agent in the history drawer and header status, and blocked sending when the selected net agent is offline or missing so agent selection is explicit and visible in the UI.
- Moved the new-net agent selector to sit directly beside the workspace path and removed the non-selectable `Select agent` option from the runtime dropdown menu so the control reads as a real runtime picker instead of a placeholder field.
- Auto-migrated legacy nets with existing history to `Claude Code` and removed the old-net header dropdown fallback, so pre-agent-binding conversations now open with a stable default agent instead of prompting again in the top-right chrome.

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
