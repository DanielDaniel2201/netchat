# netchat

## Project Summary

netchat is a Claude Code chat interface built around graph-shaped, non-linear branching.  
Users can fork from any part of a reply, and each branch is bound to its own Claude session, turning a linear chat into an explorable conversation canvas.

The project is being developed as a `local-first localhost web app`:

- the UI remains a web interface
- Claude Code runs on the user's local machine
- important data is stored locally by default
- a local controller / daemon serves APIs and the UI over `localhost`

This project has been publishd to npm, and to use latest stable release, users run
`npx @danielwyq/netchat@latest` under their desired path.

## Technical Direction

### Product Shape

- UI: React + Vite
- Canvas interaction: `@xyflow/react`
- Local API / controller: Fastify
- Local runtime bridge: daemon + Claude CLI
- Shared contracts: `packages/shared`
- Local persistence: SQLite

### Current Architecture

- `apps/web`
  - frontend UI
  - renders the conversation graph, message bubbles, and runtime status
- `apps/server`
  - local controller
  - serves `/api/*`
  - serves the built web UI
  - persists the local conversation graph
- `apps/daemon`
  - connects to the local Claude Code runtime
  - accepts jobs from the local controller
  - executes Claude turns and streams runtime events back locally
- `packages/shared`
  - shared schemas, types, graph model, and runtime contracts

### Local-First Storage

Default directory:

```text
~/.netchat/workspaces/<workspace-id>/
```

Key files:

- `workspace.json`
  - workspace metadata
  - active net selection
  - per-net storage locations
- `nets/*.db`
  - conversation history
  - branches
  - message graph
  - branch-to-local-Claude session mapping

## How to Start the Project

### 1. Install dependencies

```bash
npm install
```

### 2. Recommended startup: one-command local app

```bash
npm run app:local
```

This command will:

- build the web UI
- start the local controller
- start the local daemon
- serve the full UI on `localhost`

Default ports:

- controller: `3001`
- daemon: `4318`

### 3. Optional environment variables

- `PORT`
  - local controller port
- `DAEMON_PORT`
  - local daemon port
- `NETCHAT_NO_BROWSER=true`
  - do not open the browser automatically after startup
- `NETCHAT_SKIP_WEB_BUILD=true`
  - skip the web build step during repeated local runs
- `NETCHAT_APP_DB_PATH`
  - custom path for the local SQLite database

Example:

```bash
NETCHAT_NO_BROWSER=true npm run app:local
```

### 4. Development mode

Start the parts separately:

```bash
npm run dev:web
npm run dev:server
npm run dev:daemon
```

This is useful when working on a single module, but the recommended day-to-day flow is still:

```bash
npm run app:local
```

## Bug Fix Postmortem Policy

A bug fix task is not complete until a corresponding postmortem file has been created under `.agents/postmortem/`. You can only create the corresponding postmortem file until the user explicitly confirms you that this bug fix task is completed. If the user forgets, ask proactively if a postmortem file is needed.

### Rules

- Every bug fix must create exactly one new markdown file in `.agents/postmortem/`.
- Create the postmortem only after the fix has been implemented and verified.
- Do not overwrite an existing postmortem file for a different bug.
- Keep the document concise, specific, and factual.
- Use JSON frontmatter.
- Put the bug summary in the frontmatter field `summary`.
- If a value is unknown, write `unknown`.
- If no follow-up is needed, write `none`.

### Filename

Use this format:

`YYYY-MM-DD-HHMM-bug-slug.md`

Example:

`2026-04-08-1430-login-timeout.md`

### Required Frontmatter

The frontmatter must include:

- `title`
- `summary`
- `timestamp`
- `slug`
- `severity`

Optional but recommended:

- `owner`
- `reported_by`
- `related_issue`

### Template

```md
---
{
  "title": "<short bug title>",
  "summary": "<1-2 sentence summary of the bug, user impact, and fix>",
  "timestamp": "<YYYY-MM-DD HH:MM>",
  "slug": "<bug-slug>",
  "severity": "<low|medium|high|critical|unknown>",
  "owner": "<agent name|unknown>",
  "reported_by": "<user|qa|monitoring|agent|unknown>",
  "related_issue": "<issue/pr/commit/unknown>"
}
---

# <short bug title>

## Root Cause
<direct technical cause, concise and specific>

## Fix
<what was changed to resolve the bug>

## Files Changed
- `<path/to/file1>`
- `<path/to/file2>`

## Verification
- <test, reproduction, manual check, or command used to verify the fix>

## Follow-up
- <next action or `none`>
```

### Verify Template

Ignore this step if there is not a check-postmortem skill within available skills you see.

Invoke check-postmortem skill,  to verify if the newly created postmortem markdown file's format complies with the template.

## Other references

Refer to /DESIGN.md for frontend UI design principles.
Update the changelog after each major code change

## Testing and Validation

After implementing a new feature or fixing a bug, choose the validation approach based on the task itself.

If user validation is likely faster, simpler, or more reliable, especially for subtle UX, visual polish, interaction feel, or subjective behavior, recommend that the user validate it directly and give concise verification steps.

If agent-run validation is likely faster and sufficiently reliable, explain briefly how the agent plans to verify it using Claude Code and the `agent-browser` CLI. Only start automated validation after the user agrees.
