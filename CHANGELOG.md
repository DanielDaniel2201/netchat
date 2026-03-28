# Changelog

## Changelog rule

After each commit, update the Changelog under the current date. Each entry must be short, specific, and describe the actual change and its impact; do not copy vague commit messages. Prioritize new features, behavior changes, bug fixes, and API/config/schema updates. Use a consistent date + bullet list format, with one change per bullet, so others can understand it immediately.

## 2026-03-28

- Switched non-tail branching to start a fresh Claude session from a replayed visible-path prefix, so later sibling messages no longer leak into branch context.
- Kept tail replies in their current session and treated tail text selections as focused continuations instead of creating unnecessary branches.
- Updated the branching design note to align product semantics around continue-vs-branch and document `/rewind` as a future runtime direction rather than a production dependency.
- Added history-net rename and delete actions in the workspace drawer, and kept the list sorted by each net's latest message time so saved nets stay in a stable, conversation-driven order.
- Rendered selection-based branch anchors inline inside Claude replies, so selection forks now start from the highlighted text itself and clicking that text reactivates the branch path highlight.
