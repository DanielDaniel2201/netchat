# Changelog

## Changelog rule

After each commit, update the Changelog under the current date. Each entry must be short, specific, and describe the actual change and its impact; do not copy vague commit messages. Prioritize new features, behavior changes, bug fixes, and API/config/schema updates. Use a consistent date + bullet list format, with one change per bullet, so others can understand it immediately.

## 2026-03-28

- Switched non-tail branching to start a fresh Claude session from a replayed visible-path prefix, so later sibling messages no longer leak into branch context.
- Kept tail replies in their current session and treated tail text selections as focused continuations instead of creating unnecessary branches.
- Updated the branching design note to align product semantics around continue-vs-branch and document `/rewind` as a future runtime direction rather than a production dependency.
- Added history-net rename and delete actions in the workspace drawer, and kept the list sorted by each net's latest message time so saved nets stay in a stable, conversation-driven order.
- Rendered selection-based branch anchors inline inside Claude replies, so selection forks now start from the highlighted text itself and clicking that text reactivates the branch path highlight.

## 2026-03-30

- Restored Claude bubble markdown rendering by moving selection-branch anchors out of the markdown text flow into a dedicated anchor button strip, and fixed anchor toggles so expand/collapse is driven only by clicking those buttons.
- Fixed selected-passage quote bars in user bubbles so continuation and branch messages immediately show the persisted quoted passage with readable styling instead of broken quote characters.
- Let the canvas thumbnail pan from anywhere inside the minimap instead of only dragging the viewport rectangle, so preview nodes no longer block free minimap dragging.
- Replaced the anchor button strip with line-aware left/right gutters around assistant markdown content, placing each branch anchor near its selected passage line while preserving markdown rendering and stabilizing click-to-toggle behavior.
- Stabilized gutter anchor behavior by preserving per-anchor layout identity across rerenders, using consistent text-node offsets for selections, and unblocking anchor button click events that were being intercepted in capture handlers.
- Fixed gutter anchor line placement after canvas zoom by converting selection rect measurements back into the markdown container's local coordinate system before positioning buttons.
- Corrected legacy anchor line drift by validating stored selection offsets against rendered text and falling back to the nearest selected-text match when older branch metadata points at the wrong line.
