#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const packageJsonPath = path.join(repoRoot, "package.json");
const argv = process.argv.slice(2);

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
const entryFile = isDaemonCommand
  ? path.join(repoRoot, "apps", "daemon", "src", "index.ts")
  : path.join(repoRoot, "apps", "server", "src", "local-app.ts");

if (!existsSync(tsxCliPath)) {
  console.error(`netchat requires tsx at ${tsxCliPath}. Run npm install first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCliPath, entryFile, ...forwardedArgs], {
  cwd: repoRoot,
  env: process.env,
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
      "  npx netchat                  Start the controller, daemon, and local web UI",
      "  npx netchat daemon [...]     Start only the daemon",
      "  npx netchat local [...]      Explicitly start the full local app",
      "",
      "Examples:",
      "  npx netchat",
      "  npx netchat --no-browser",
      "  npx netchat daemon --server http://127.0.0.1:3001 --pair ABC123",
      "",
      "Run `npx netchat local --help` or `npx netchat daemon --help` for command-specific options.",
    ].join("\n"),
  );
}

function printVersion() {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  console.log(typeof packageJson.version === "string" ? packageJson.version : "0.0.0");
}
