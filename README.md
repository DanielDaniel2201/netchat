# @danielwyq/netchat

Local-first graph chat interface for Claude Code.

The packaged app now assumes a single local controller + daemon flow on `localhost`; no pairing step or machine-state file is required.

## Quick start

Use the latest stable release:

```bash
npx @danielwyq/netchat@latest
```

Run daemon-only mode:

```bash
npx @danielwyq/netchat@latest daemon --server http://127.0.0.1:3001
```

Show local help:

```bash
npx @danielwyq/netchat@latest --help
npx @danielwyq/netchat@latest local --help
npx @danielwyq/netchat@latest daemon --help
```

## Why `@latest`

If you update frequently, always documenting and using `@latest` helps avoid stale cached resolutions:

```bash
npx @danielwyq/netchat@latest
```

If users still suspect cache issues, they can run:

```bash
npm cache clean --force
npx @danielwyq/netchat@latest
```

## Environment variables

- `PORT`: local controller port (default `3001`)
- `DAEMON_PORT`: local daemon port (default `4318`)
- `NETCHAT_NO_BROWSER=true`: do not auto-open browser
- `NETCHAT_SKIP_WEB_BUILD=true`: skip rebuilding web assets during local runs
- `NETCHAT_APP_DB_PATH`: custom SQLite path

## Requirements

- Node.js `>=20`
