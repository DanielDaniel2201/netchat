# Changelog

## 2026-05-01

- Added a sidebar `Settings` action and modal with a persisted MinerU API token field, and rearranged the sidebar header so `Collapse`, `New workspace`, and `Settings` stay left-aligned while `New net` moves to the far right in expanded mode and becomes the fourth stacked icon in collapsed mode.
- Let the MinerU token field reopen with the saved token already loaded under password masking, and added an inline eye toggle so users can reveal or hide the saved value without retyping it.
- Added server-side app settings storage plus a new MinerU-backed workspace PDF-to-Markdown API, so PDF article imports can upload through MinerU, poll parse status, download `full.md`, and write the generated Markdown beside the source PDF inside the active workspace.
- Wired Article Mode PDF selection to require a configured MinerU token, surface MinerU parse/load progress and errors in the UI, and automatically continue by loading the generated Markdown as the root article once parsing finishes.
- Fixed MinerU PDF upload signing by removing the extra `Content-Type` header from the presigned OSS `PUT`, so article-mode PDF imports no longer fail immediately with `SignatureDoesNotMatch`.

## 2026-04-28

- Replaced the per-article bubble Focus trigger with a global top-right `Focus` action that picks the bubble nearest the current canvas viewport center, opens Focus View on that bubble, and aligns the target bubble flush to the top of the reading surface.
- Locked inline replying to Focus View only, turning the canvas into a stable read-only browse mode, and added an in-app top-center toast for blocked actions such as trying to reply outside Focus View or trying to leave Focus View while a reply is still streaming.
- Reworked Focus View branch return handling from a single article-only jump target into a nested return stack with parent scroll restoration, so second-level and deeper branch returns now collapse only the child branch and step back to the immediate parent view instead of snapping all the way back to the root article.

## 2026-04-21

- Replaced the tail-composer `Continue session / Start branch / Replay branch` strip with a single `Continue`/`Branch` toggle button beside send, so mode switching is now one-click inline without extra selector chrome.
- Persisted tail-composer mode by last successful send (`continue` or `branch`) and wired placeholder copy to the active mode, so reopening composer restores prior intent while first-open in existing nets still defaults to `continue`.

## 2026-04-20

- Fixed Codex app-server reasoning ingestion to consume reasoning/plan delta notifications and structured final message content instead of stringifying empty arrays, so thinking traces no longer collapse into `[]` after the app-server migration.
- Moved non-final assistant text updates into the existing `Thinking & Tools` trace stack and reserved the response panel for the committed final answer, so interim Codex/Claude status messages no longer flash inside the final-response area and then disappear.
- Stopped treating normal streamed final-answer tokens as persistent trace entries, and now only keep discrete non-final assistant message items inside `Thinking & Tools`, so Codex selection-branch replies no longer show a temporary dropdown that vanishes as soon as the final answer commits.
- Demoted any streamed assistant pre-tool status text into a persisted trace block as soon as later tool/thinking events or a different assistant message arrive, so messages like “I’m listing the directory first” now stay inside `Thinking & Tools` instead of briefly occupying the final-response panel.
- Normalized `\(...\)` and `\[...\]` LaTeX delimiters before markdown rendering, and restored focus-view selection-branch return state so article-focus branches render those formulas correctly and `Esc`/return jumps back to the originating article passage instead of exiting focus view outright.
- Routed daemon runtime logs into `/runtime/diagnostics` and tagged Codex app-server sourced entries with a `(Codex appServer)` prefix, so diagnostics can distinguish native runtime-origin events from server-side strategy logs.
- Fixed root-turn runtime/session planning to respect net-scoped agent selection before legacy root-session reuse, so switching a net from Claude to Codex now starts a fresh Codex thread with replayed visible history instead of incorrectly trying to `thread/resume` a Claude session id.
- Stopped retryable Codex app-server error notifications such as `Reconnecting... n/5` from aborting netchat turns prematurely, and now finalize successful app-server turns from streamed assistant deltas when `turn/completed` arrives without embedded items.
- Replaced daemon Codex execution from `codex exec --json` to `codex app-server` JSON-RPC (`thread/start|resume|fork` + `turn/start`), with minimum CLI version gating, so Codex branch/continue can now be managed through one unified app-server control path.
- Expanded native branch-fork eligibility from Claude-only to Claude+Codex on tail messages, so Composer `Branch` now maps to absolute runtime fork (new session/thread id) for both runtimes instead of replay fallback in Codex tail cases.
- Added an explicit `Continue session` / `Start branch` toggle above tail assistant/article composers, so users can branch directly from the current reply instead of being locked into the active lane.
- Switched tail Claude branch creation to resume with native `--fork-session` when a live session handle exists, falling back to visible-path replay only for older branch points and non-Claude contexts.
- Temporarily masked Droid from local app startup and runtime selection, so `npm run app:local` now only boots background daemons for Claude Code and Codex.

## 2026-04-18

- Enabled LaTeX math rendering in message markdown and markdown file previews via `remark-math` + `rehype-katex`, so formulas like `$$...$$` now render as readable equations instead of raw source strings.
- Reworked article Focus View branch dives to reuse Focus View itself instead of a separate canvas mode: selected-text branch jumps now behave like programmatically focusing the branch’s top user bubble, non-root branches render as branch-local focus instead of vertically splicing the parent article into the same column, and both selected-text branches and whole-message type-2 branches now expose the same icon-only return arrow and `Esc` behavior, snapping straight back to either the originating selection anchor or the article-bottom continuation chooser without smooth-scroll animation.

## 2026-04-14

- Simplified selection-branch camera moves to horizontal recentering only, fixed expanded anchor clicks inside article Focus View to collapse in place, and stopped article/root nets from reapplying their initial viewport on every branch toggle so selected-text navigation no longer jerks the canvas back to a top-framed zoom.
- Added an article-only Focus View with a new zoom-in action on article bubbles, opening a full-screen reading mode that hides sidebar, explorer chrome, and minimap so one branch path can be read as a document instead of a canvas.
- Kept selection follow-ups and branch anchor toggles working inside Focus View, and now auto-scroll focus mode to newly expanded branch tops and optimistic in-progress assistant bubbles after send so branch reading flow stays uninterrupted.
- Let clicking the same assistant or article bubble dismiss an already-open inline composer, including selection-based follow-up composers, so users can toggle reply mode off without extra canvas clicks.
- Repositioned forked branch entry bubbles to seed from the selected-passage anchor when a branch comes from highlighted text, with lateral fork routing as the fallback for non-selection branches, so expanding a branch tracks the relevant passage instead of dropping below a very tall source bubble.
- Split non-tail assistant/article branching back into two layouts, keeping direct bubble-click branches fully below the source bubble while selection-created branches fork laterally from the exact selected-passage anchor with a much shorter gap.
- Let article Focus View branch-outs temporarily exit back to the canvas with a `Return` action, then restore the article reader at the originating selection line near the top third of the screen instead of dumping the user back at the top of the article.
- Added bottom-edge `user query` continuation pickers in article Focus View for whole-message follow-up branches, spacing each dashed-arrow entry evenly across the source bubble so users can continue on the intended branch without leaving the reader.

## 2026-04-13

- Added a new-chat Article Mode that swaps the first-turn textarea for a workspace file picker and seeds the canvas from a selected local file, so users can begin a conversation from article source material instead of typing the opening bubble manually.
- Added persisted `article` root messages with markdown-aware rendering and first-turn root prompt replay, so follow-up questions and selection-based branches stay grounded in the imported article before any agent session exists.

## 2026-04-12

- Replaced the file preview word-wrap toggle with Markdown rendering for `.md` files while keeping the plain numbered, horizontally scrollable viewer for all other file types.
- Made the explorer pane fully occupy the right-side workspace area whenever no file preview is open, so opening the explorer alone no longer leaves a blank reserved sheet beside it.
- Added desktop drag splitters between `canvas | workspace panes` and `explorer | file preview`, with clamped widths and persisted pane sizing, so the right-side workspace tools now resize like an editor instead of staying on fixed widths.
- Replaced per-line horizontal scrolling in the workspace file preview with a single pane-level bottom scrollbar, so long lines now behave like a real code viewer instead of spawning one scrollbar per row.
- Trimmed the new workspace explorer and file preview headers down to just the active folder or file name and removed the extra root-summary chrome, so the right-side panels read as much thinner, cleaner utility panes.
- Added line numbers to workspace file previews, so browsing source files from the canvas now has lightweight editor-style orientation without extra metadata bars.
- Replaced the sidebar `Open folder as workspace` and `New net` glyphs with `folder-plus` and `pencil` actions, so adding a workspace and starting a fresh net read as distinct creation flows.
- Added active-workspace explorer APIs plus a right-side file tree and file preview panel toggled from the canvas, so the main view can now expand into `canvas + explorer + file content` like a lightweight editor workspace.
- Raised Codex's default daemon inactivity timeout from the shared `60s` fallback to a dedicated `5m` window and added per-runtime timeout env overrides, so long-running `codex exec --json` turns are no longer misclassified as stalled while Claude and Droid keep their shorter defaults.
- Replaced the default framework lightning favicon with a `🕸️` mark, so browser tabs now match netchat's graph-like branding more closely.
- Swapped the favicon to a fixed black-backed gray-white spiderweb SVG and included `apps/web/public` in local web rebuild detection, so `npm run app:local` now picks up favicon asset changes without serving a stale dist copy.

## 2026-04-10

- Prepared the `0.0.5` patch release against `v0.0.4`, bundling the latest sidebar, workspace, and composer refinements into the next npm publish.
- Removed the sidebar `NetChat` wordmark and moved the collapse toggle to the far-left edge of the control row, so the rail header is now just the action strip.
- Narrowed user and assistant message bubbles to roughly two-thirds of the previous width and recalibrated line estimation, so canvas conversations read less like wall-to-wall strips and keep their measured layout stable.
- Changed launch selection to reopen the net with the most recent user message instead of forcing a fresh empty `Untitled net`, so startup lands back in the latest active conversation by default.
- Snapped the in-net composer agent badge onto a flush bottom-left rail, so the badge now aligns with the composer frame instead of floating above the corner.
- Matched workspace deletion to the existing net deletion modal, so destructive confirmation now uses the same inline dialog instead of a browser `confirm`.
- Made sidebar collapse/expand animate through a real 80px rail and persisted workspace drag-reorder in React state, so the left rail now transitions smoothly and reordered workspaces update immediately.
- Fixed the Windows folder picker to treat cancel as a normal no-op and stopped net agent changes from disabling unrelated sidebar buttons, so `Open folder as workspace` no longer throws on cancel or flashes during agent switches.
- Restyled in-net reply composers onto the same light surface as the new-net composer and flattened the lower-left agent badge into monochrome inline text, so active-net prompt UI now matches the editorial canvas more closely.
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
