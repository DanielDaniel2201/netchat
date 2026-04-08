#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCliPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const packageJsonPath = path.join(packageRoot, "package.json");
const argv = process.argv.slice(2);
const launchCwd = process.cwd();

if (argv[0] === "--help" || argv[0] === "-h") {
  printHelp();
  process.exit(0);
}

if (argv[0] === "--version" || argv[0] === "-v") {
  printVersion();
  process.exit(0);
}

const subcommand = argv[0];
const isDaemonCommand = subcommand === "daemon";
const isLocalCommand = subcommand === "local";
const forwardedArgs = isDaemonCommand || isLocalCommand ? argv.slice(1) : argv;
const sourceLocalEntry = path.join(packageRoot, "apps", "server", "src", "local-app.ts");
const sourceDaemonEntry = path.join(packageRoot, "apps", "daemon", "src", "index.ts");
const distLocalEntry = path.join(packageRoot, "dist", "apps", "local-app", "index.mjs");
const distDaemonEntry = path.join(packageRoot, "dist", "apps", "daemon", "index.mjs");
const sourceMode = existsSync(tsxCliPath) && existsSync(sourceLocalEntry) && existsSync(sourceDaemonEntry);
const entryFile = isDaemonCommand
  ? sourceMode
    ? sourceDaemonEntry
    : distDaemonEntry
  : sourceMode
    ? sourceLocalEntry
    : distLocalEntry;

if (!existsSync(entryFile)) {
  console.error(`@danielwyq/netchat could not find its runtime entry at ${entryFile}.`);
  process.exit(1);
}

const childArgs = sourceMode ? [tsxCliPath, entryFile, ...forwardedArgs] : [entryFile, ...forwardedArgs];
const child = spawn(process.execPath, childArgs, {
  cwd: packageRoot,
  env: {
    ...process.env,
    NETCHAT_LAUNCH_CWD: process.env.NETCHAT_LAUNCH_CWD ?? launchCwd,
    NETCHAT_RUNTIME_CWD: process.env.NETCHAT_RUNTIME_CWD ?? process.env.CLAUDE_PROJECT_CWD ?? launchCwd,
    CLAUDE_PROJECT_CWD: process.env.CLAUDE_PROJECT_CWD ?? process.env.NETCHAT_RUNTIME_CWD ?? launchCwd,
  },
  stdio: "inherit",
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

child.on("exit", (code, signal) => {
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);

  if (signal) {
    process.exit(1);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function printHelp() {
  console.log(
    [
      "netchat",
      "",
      "Run the local-first app with sensible defaults.",
      "",
      "Usage:",
      "  npx @danielwyq/netchat@latest                  Start the controller, daemon, and local web UI",
      "  npx @danielwyq/netchat@latest daemon [...]     Start only the daemon",
      "  npx @danielwyq/netchat@latest local [...]      Explicitly start the full local app",
      "",
      "Examples:",
      "  npx @danielwyq/netchat@latest",
      "  npx @danielwyq/netchat@latest --no-browser",
      "  npx @danielwyq/netchat@latest --show-session-ids",
      "  npx @danielwyq/netchat@latest daemon --server http://localhost:3001",
      "",
      "Run `npx @danielwyq/netchat@latest local --help` or `npx @danielwyq/netchat@latest daemon --help` for command-specific options.",
    ].join("\n"),
  );
}

function printVersion() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  console.log(typeof packageJson.version === "string" ? packageJson.version : "0.0.0");
}
