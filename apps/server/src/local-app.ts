import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { AgentRuntimeKind, AgentRuntimeOption, resolveAgentRuntimeLabel } from "@netchat/shared";

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceMode = existsSync(path.join(runtimeRoot, "apps", "server", "src", "index.ts"));
const tsxCliPath = path.join(runtimeRoot, "node_modules", "tsx", "dist", "cli.mjs");
const sourceWebDistPath = path.join(runtimeRoot, "apps", "web", "dist");
const packagedWebDistPath = path.join(runtimeRoot, "dist", "web");
const webDistPath = sourceMode ? sourceWebDistPath : packagedWebDistPath;
const webDistIndexPath = path.join(webDistPath, "index.html");
const webBuildMarkerPath = path.join(webDistPath, ".netchat-local-build.json");
const webSourceRoots = [
  path.join(runtimeRoot, "apps", "web", "src"),
  path.join(runtimeRoot, "apps", "web", "index.html"),
  path.join(runtimeRoot, "apps", "web", "package.json"),
  path.join(runtimeRoot, "apps", "web", "tsconfig.json"),
  path.join(runtimeRoot, "apps", "web", "vite.config.ts"),
  path.join(runtimeRoot, "apps", "web", "tailwind.config.ts"),
  path.join(runtimeRoot, "apps", "web", "postcss.config.cjs"),
];
const sourceServerEntryPath = path.join(runtimeRoot, "apps", "server", "src", "index.ts");
const packagedServerEntryPath = path.join(runtimeRoot, "dist", "apps", "server", "index.mjs");
const sourceDaemonEntryPath = path.join(runtimeRoot, "apps", "daemon", "src", "index.ts");
const packagedDaemonEntryPath = path.join(runtimeRoot, "dist", "apps", "daemon", "index.mjs");
const managedChildren: ChildProcess[] = [];
const managedRuntimeKinds = ["claude", "codex", "droid"] as const satisfies readonly AgentRuntimeKind[];

let shuttingDown = false;

void main().catch(async (error) => {
  console.error(`[netchat-local] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown("Local app failed to start cleanly.", 1);
});

async function main() {
  if (sourceMode && !existsSync(tsxCliPath)) {
    throw new Error(`tsx is not installed at ${tsxCliPath}. Run npm install first.`);
  }

  const config = await resolveLocalAppConfig(process.argv.slice(2));
  mkdirSync(config.appDataDirectory, { recursive: true });

  log("Preparing the local web app...");
  if (!sourceMode) {
    log("Using the packaged web build.");
  } else {
    const npmCommand = resolveNpmCommand();
    const buildReason = resolveWebBuildReason(config);
    if (config.webBuildMode === "skip") {
      log("Skipping the web build because --skip-web-build was requested.");
    } else if (buildReason) {
      log(buildReason);
      await runCommand(npmCommand.command, [...npmCommand.args, "run", "build:web"], {
        cwd: runtimeRoot,
        env: process.env,
        shell: npmCommand.shell,
        stdio: "inherit",
      });
      writeWebBuildMarker();
    } else {
      log("Reusing the existing web build.");
    }
  }

  if (!existsSync(webDistIndexPath)) {
    throw new Error(`Local web build not found at ${webDistPath}.`);
  }

  const serverProcess = startProcess("controller", process.execPath, resolveManagedEntryArgs("server"), {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      NETCHAT_APP_DATA_DIR: config.appDataDirectory,
      NETCHAT_DAEMON_URL: config.daemons[0]?.url ?? "",
      NETCHAT_LAUNCH_CWD: process.env.NETCHAT_LAUNCH_CWD ?? config.workingDirectory,
      NETCHAT_WORKSPACE_DIR: config.workingDirectory,
      NETCHAT_LOCAL_MODE: "true",
      NETCHAT_SHOW_SESSION_IDS: String(config.showSessionIds),
      NETCHAT_WEB_DIST_PATH: webDistPath,
      PORT: String(config.serverPort),
      ...(config.databasePath ? { NETCHAT_APP_DB_PATH: config.databasePath } : {}),
    },
    stdio: "inherit",
  });
  void serverProcess.exitPromise.catch(() => undefined);
  await waitForHealth(`${config.serverUrl}/health`);

  const daemonProcesses = config.daemons.map((daemon) => {
    const daemonProcess = startProcess(
      `${daemon.runtimeLabel} daemon`,
      process.execPath,
      resolveManagedEntryArgs("daemon"),
      {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          NETCHAT_RUNTIME: daemon.runtimeKind,
          NETCHAT_RUNTIME_ID: daemon.runtimeId,
          NETCHAT_MACHINE_NAME: daemon.runtimeLabel,
          NETCHAT_RUNTIME_CWD: process.env.NETCHAT_RUNTIME_CWD ?? process.env.CLAUDE_PROJECT_CWD ?? config.workingDirectory,
          CLAUDE_PROJECT_CWD: process.env.CLAUDE_PROJECT_CWD ?? process.env.NETCHAT_RUNTIME_CWD ?? config.workingDirectory,
          DAEMON_PORT: String(daemon.port),
          NETCHAT_APP_DATA_DIR: config.appDataDirectory,
          NETCHAT_LAUNCH_CWD: process.env.NETCHAT_LAUNCH_CWD ?? config.workingDirectory,
          NETCHAT_LOCAL_MODE: "true",
          NETCHAT_SERVER_URL: config.serverUrl,
          NETCHAT_WORKSPACE_DIR: config.workingDirectory,
        },
        stdio: "inherit",
      },
    );
    void daemonProcess.exitPromise.catch(() => undefined);
    return daemonProcess;
  });

  await Promise.all(config.daemons.map((daemon) => waitForHealth(daemon.url + "/health")));
  await waitForAgentsReady(`${config.serverUrl}/api/agents`);

  log(`Local controller ready at ${config.serverUrl}.`);
  log(`Workspace-scoped net history will persist under ${config.appDataDirectory}.`);
  log(`Local agents ready: ${config.daemons.map((daemon) => `${daemon.runtimeLabel} (${daemon.url})`).join(", ")}.`);
  if (config.showSessionIds) {
    log("Developer mode is enabled: every message bubble will show its session_id.");
  }
  if (config.openBrowser) {
    await openBrowser(config.serverUrl);
  }

  await Promise.race([serverProcess.exitPromise, ...daemonProcesses.map((daemon) => daemon.exitPromise)]);
}

process.on("SIGINT", () => {
  void shutdown("Received SIGINT, stopping local services...");
});

process.on("SIGTERM", () => {
  void shutdown("Received SIGTERM, stopping local services...");
});

async function shutdown(message: string, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(message);
  for (const child of managedChildren) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(200);
  process.exit(exitCode);
}

function startProcess(
  description: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) {
  const child = spawn(command, args, options);
  managedChildren.push(child);

  const exitPromise = new Promise<never>((_, reject) => {
    child.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }

      const detail =
        code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : "an unknown reason";
      reject(new Error(`${description} process stopped with ${detail}.`));
      void shutdown(`${description} process stopped with ${detail}.`, 1);
    });

    child.on("error", (error) => {
      if (shuttingDown) {
        return;
      }

      reject(error);
      void shutdown(`Failed to start the ${description} process: ${error.message}`, 1);
    });
  });

  return {
    child,
    exitPromise,
  };
}

function resolveManagedEntryArgs(target: "server" | "daemon") {
  if (sourceMode) {
    return [tsxCliPath, target === "server" ? sourceServerEntryPath : sourceDaemonEntryPath];
  }

  return [target === "server" ? packagedServerEntryPath : packagedDaemonEntryPath];
}

type WebBuildMode = "auto" | "skip" | "force";

type ParsedLocalAppArgs = {
  appDataDirectory: string | null;
  databasePath: string | null;
  serverPort: number | null;
  daemonPort: number | null;
  openBrowser: boolean | null;
  webBuildMode: WebBuildMode | null;
  showSessionIds: boolean | null;
};

type LocalAppConfig = {
  appDataDirectory: string;
  databasePath: string | null;
  workingDirectory: string;
  serverPort: number;
  serverUrl: string;
  daemons: Array<{
    runtimeKind: (typeof managedRuntimeKinds)[number];
    runtimeId: string;
    runtimeLabel: string;
    port: number;
    url: string;
  }>;
  openBrowser: boolean;
  webBuildMode: WebBuildMode;
  showSessionIds: boolean;
};

type WebBuildMarker = {
  version: 2;
};

async function resolveLocalAppConfig(argv: string[]): Promise<LocalAppConfig> {
  const parsedArgs = parseLocalAppArgs(argv);
  const workingDirectory = resolveLaunchWorkingDirectory();
  const appDataDirectory =
    parsedArgs.appDataDirectory ??
    readStringEnv("NETCHAT_APP_DATA_DIR") ??
    path.join(os.homedir(), ".netchat", "workspaces", createWorkspaceStorageKey(workingDirectory));
  const databasePath = parsedArgs.databasePath ?? readStringEnv("NETCHAT_APP_DB_PATH");
  const configuredServerPort = parsedArgs.serverPort ?? readPortEnv("PORT");
  const serverPort = await resolvePort("controller", configuredServerPort ?? 3001, {
    explicit: configuredServerPort !== null,
  });
  const configuredDaemonPort = parsedArgs.daemonPort ?? readPortEnv("DAEMON_PORT");
  const daemonBasePort = configuredDaemonPort ?? 4318;
  const reservedPorts = new Set([serverPort]);
  const daemons: LocalAppConfig["daemons"] = [];
  for (const [index, runtimeKind] of managedRuntimeKinds.entries()) {
    const runtimeLabel = resolveAgentRuntimeLabel(runtimeKind);
    const port = await resolvePort(`${runtimeLabel} daemon`, daemonBasePort + index, {
      explicit: configuredDaemonPort !== null && index === 0,
      reservedPorts,
    });
    reservedPorts.add(port);
    daemons.push({
      runtimeKind,
      runtimeId: `${runtimeKind}_local`,
      runtimeLabel,
      port,
      url: `http://127.0.0.1:${port}`,
    });
  }
  const openBrowser =
    parsedArgs.openBrowser ?? !readBooleanEnv("NETCHAT_NO_BROWSER");
  const webBuildMode =
    parsedArgs.webBuildMode ??
    (readBooleanEnv("NETCHAT_FORCE_WEB_BUILD")
      ? "force"
      : readBooleanEnv("NETCHAT_SKIP_WEB_BUILD")
        ? "skip"
        : "auto");
  const showSessionIds =
    parsedArgs.showSessionIds ??
    readBooleanEnv("NETCHAT_SHOW_SESSION_IDS");

  return {
    appDataDirectory,
    databasePath,
    workingDirectory,
    serverPort,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    daemons,
    openBrowser,
    webBuildMode,
    showSessionIds,
  };
}

function parseLocalAppArgs(argv: string[]): ParsedLocalAppArgs {
  const parsed: ParsedLocalAppArgs = {
    appDataDirectory: null,
    databasePath: null,
    serverPort: null,
    daemonPort: null,
    openBrowser: null,
    webBuildMode: null,
    showSessionIds: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inlineValue] = token.split("=", 2);

    switch (flag) {
      case "--help":
      case "-h":
        printLocalAppHelp();
        process.exit(0);
      case "--port": {
        const option = readOptionValue(flag, inlineValue, argv, index);
        parsed.serverPort = parsePort(flag, option.value);
        index = option.nextIndex;
        break;
      }
      case "--daemon-port": {
        const option = readOptionValue(flag, inlineValue, argv, index);
        parsed.daemonPort = parsePort(flag, option.value);
        index = option.nextIndex;
        break;
      }
      case "--data-dir":
      case "--app-data-dir": {
        const option = readOptionValue(flag, inlineValue, argv, index);
        parsed.appDataDirectory = option.value;
        index = option.nextIndex;
        break;
      }
      case "--db-path":
      case "--app-db-path": {
        const option = readOptionValue(flag, inlineValue, argv, index);
        parsed.databasePath = option.value;
        index = option.nextIndex;
        break;
      }
      case "--no-browser":
        parsed.openBrowser = false;
        break;
      case "--browser":
        parsed.openBrowser = true;
        break;
      case "--skip-web-build":
        parsed.webBuildMode = "skip";
        break;
      case "--rebuild-web":
      case "--force-web-build":
        parsed.webBuildMode = "force";
        break;
      case "--show-session-ids":
        parsed.showSessionIds = true;
        break;
      default:
        throw new Error(`Unknown option ${token}. Run with --help to see supported flags.`);
    }
  }

  return parsed;
}

function readOptionValue(
  flag: string,
  inlineValue: string | undefined,
  argv: string[],
  index: number,
) {
  if (inlineValue !== undefined) {
    return {
      value: inlineValue,
      nextIndex: index,
    };
  }

  const nextValue = argv[index + 1];
  if (!nextValue || nextValue.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return {
    value: nextValue,
    nextIndex: index + 1,
  };
}

function printLocalAppHelp() {
  console.log(
    [
      "netchat local",
      "",
      "Start the controller, daemon, and web UI with local-first defaults.",
      "",
      "Examples:",
      "  npx @danielwyq/netchat@latest",
      "  npx @danielwyq/netchat@latest --no-browser",
      "  npx @danielwyq/netchat@latest --show-session-ids",
      "  npx @danielwyq/netchat@latest --port 3002 --daemon-port 4319",
      "",
      "Options:",
      "  --port <number>               Controller port (default: 3001)",
      "  --daemon-port <number>        First runtime daemon port (default: 4318)",
      "  --data-dir <path>             Override the local app data directory",
      "  --db-path <path>              Override the SQLite database path",
      "  --no-browser                  Do not open the browser automatically",
      "  --browser                     Force opening the browser even if env overrides disable it",
      "  --skip-web-build              Reuse the existing web build without rebuilding",
      "  --rebuild-web                 Force a fresh web build before startup",
      "  --show-session-ids            Developer flag: render each message bubble's session_id",
    ].join("\n"),
  );
}

function parsePort(flag: string, value: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} must be an integer between 1 and 65535.`);
  }

  return port;
}

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function readBooleanEnv(name: string) {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function readPortEnv(name: string) {
  const value = readStringEnv(name);
  return value ? parsePort(name, value) : null;
}

function resolveLaunchWorkingDirectory() {
  const configuredPath =
    readStringEnv("NETCHAT_RUNTIME_CWD") ??
    readStringEnv("NETCHAT_WORKSPACE_DIR") ??
    readStringEnv("NETCHAT_LAUNCH_CWD") ??
    readStringEnv("CLAUDE_PROJECT_CWD") ??
    process.cwd();
  return normalizeWorkingDirectory(configuredPath);
}

function normalizeWorkingDirectory(value: string) {
  return path.resolve(value).replace(/\\/g, "/");
}

function createWorkspaceStorageKey(workingDirectory: string) {
  const normalized =
    process.platform === "win32" ? workingDirectory.toLowerCase() : workingDirectory;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function resolvePort(
  label: string,
  preferredPort: number,
  options: {
    explicit: boolean;
    reservedPorts?: Set<number>;
  },
) {
  const reservedPorts = options.reservedPorts ?? new Set<number>();
  if (reservedPorts.has(preferredPort)) {
    if (options.explicit) {
      throw new Error(`The requested ${label} port ${preferredPort} is already reserved by another netchat service.`);
    }

    const nextPort = await findAvailablePort(preferredPort + 1, reservedPorts);
    log(`Port ${preferredPort} is reserved already, so the local ${label} will use ${nextPort}.`);
    return nextPort;
  }

  if (await isPortAvailable(preferredPort)) {
    return preferredPort;
  }

  if (options.explicit) {
    throw new Error(`The requested ${label} port ${preferredPort} is already in use.`);
  }

  const nextPort = await findAvailablePort(preferredPort + 1, reservedPorts);
  log(`Port ${preferredPort} is already in use, so the local ${label} will use ${nextPort}.`);
  return nextPort;
}

async function findAvailablePort(startPort: number, reservedPorts: Set<number>) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (reservedPorts.has(port)) {
      continue;
    }

    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error("Could not find a free local port for netchat.");
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen({
      port,
      host: "0.0.0.0",
    });
  });
}

function resolveWebBuildReason(config: LocalAppConfig) {
  if (!sourceMode) {
    return null;
  }

  if (config.webBuildMode === "force") {
    return "Building the web UI because --rebuild-web was requested.";
  }

  if (!existsSync(webDistIndexPath)) {
    return "Building the web UI because no local build is available.";
  }

  const existingMarker = readWebBuildMarker();
  if (!existingMarker) {
    return "Building the web UI because the existing local build predates the portable runtime bundle.";
  }

  if (isWebBuildOutdated()) {
    return "Building the web UI because the frontend sources changed since the last local build.";
  }

  return null;
}

function readWebBuildMarker(): WebBuildMarker | null {
  if (!existsSync(webBuildMarkerPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(webBuildMarkerPath, "utf8")) as WebBuildMarker;
  } catch {
    return null;
  }
}

function writeWebBuildMarker() {
  const marker: WebBuildMarker = {
    version: 2,
  };
  writeFileSync(webBuildMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function isWebBuildOutdated() {
  if (!existsSync(webDistIndexPath)) {
    return true;
  }

  let buildTimestamp = 0;
  try {
    buildTimestamp = statSync(webDistIndexPath).mtimeMs;
  } catch {
    return true;
  }

  return getLatestModifiedTime(webSourceRoots) > buildTimestamp;
}

function getLatestModifiedTime(pathsToInspect: string[]) {
  let latest = 0;

  for (const targetPath of pathsToInspect) {
    latest = Math.max(latest, getPathModifiedTime(targetPath));
  }

  return latest;
}

function getPathModifiedTime(targetPath: string): number {
  if (!existsSync(targetPath)) {
    return 0;
  }

  const stats = statSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let latest = stats.mtimeMs;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }

    latest = Math.max(latest, getPathModifiedTime(path.join(targetPath, entry.name)));
  }

  return latest;
}

function resolveNpmCommand() {
  const npmCliPath = process.env.npm_execpath?.trim();
  if (npmCliPath) {
    return {
      command: process.execPath,
      args: [npmCliPath],
      shell: false,
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [],
    shell: process.platform === "win32",
  };
}

async function waitForHealth(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore while the local service is still booting.
    }

    await delay(300);
  }

  throw new Error(`Timed out waiting for ${url} to become healthy.`);
}

async function waitForAgentsReady(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const agents = await requestJson<AgentRuntimeOption[]>(url);
      if (agents.some((agent) => agent.status === "online" && agent.installed)) {
        return;
      }
    } catch {
      // Ignore while the local daemons are still starting.
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for the local runtime agents to come online.");
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

async function openBrowser(url: string) {
  const command =
    process.platform === "win32"
      ? { file: "cmd.exe", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  try {
    const browserProcess = spawn(command.file, command.args, {
      cwd: runtimeRoot,
      detached: true,
      stdio: "ignore",
    });
    browserProcess.unref();
  } catch (error) {
    log(
      `Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell?: boolean;
    stdio: "inherit";
  },
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${code !== null ? `exit code ${code}` : `signal ${signal}`}.`,
        ),
      );
    });
    child.on("error", reject);
  });
}

function log(message: string) {
  console.info(`\x1b[37m[netchat-local][info] ${message}\x1b[0m`);
}
