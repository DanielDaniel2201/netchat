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

## Other references

Refer to /DESIGN.md for frontend UI design principles.
Update the changelog after each major code change

## Testing and Validation

After implementing a new feature or fixing a bug, validate the result using the `agent-browser` CLI.

If the new implementation is unrelated to agent runtime, use Claude Code by default.
