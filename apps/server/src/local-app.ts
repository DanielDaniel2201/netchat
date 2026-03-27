import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxCliPath = path.join(
  repoRoot,
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const webDistPath = path.join(repoRoot, "apps", "web", "dist");
const webDistIndexPath = path.join(webDistPath, "index.html");
const webBuildMarkerPath = path.join(webDistPath, ".netchat-local-build.json");
const webSourceRoots = [
  path.join(repoRoot, "apps", "web", "src"),
  path.join(repoRoot, "apps", "web", "index.html"),
  path.join(repoRoot, "apps", "web", "package.json"),
  path.join(repoRoot, "apps", "web", "tsconfig.json"),
  path.join(repoRoot, "apps", "web", "vite.config.ts"),
  path.join(repoRoot, "apps", "web", "tailwind.config.ts"),
  path.join(repoRoot, "apps", "web", "postcss.config.cjs"),
];
const managedChildren: ChildProcess[] = [];

let shuttingDown = false;

await main().catch(async (error) => {
  console.error(`[netchat-local] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown("Local app failed to start cleanly.", 1);
});

async function main() {
  if (!existsSync(tsxCliPath)) {
    throw new Error(`tsx is not installed at ${tsxCliPath}. Run npm install first.`);
  }

  const config = await resolveLocalAppConfig(process.argv.slice(2));
  const npmCommand = resolveNpmCommand();
  mkdirSync(config.appDataDirectory, { recursive: true });

  log("Preparing the local web app...");
  const buildReason = resolveWebBuildReason(config);
  if (config.webBuildMode === "skip") {
    log("Skipping the web build because --skip-web-build was requested.");
  } else if (buildReason) {
    log(buildReason);
    await runCommand(npmCommand.command, [...npmCommand.args, "run", "build:web"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_API_BASE_URL: config.serverUrl,
        VITE_DAEMON_BASE_URL: config.daemonUrl,
      },
      shell: npmCommand.shell,
      stdio: "inherit",
    });
    writeWebBuildMarker(config);
  } else {
    log("Reusing the existing web build.");
  }

  if (!existsSync(webDistIndexPath)) {
    throw new Error(`Local web build not found at ${webDistPath}.`);
  }

  const serverProcess = startProcess("controller", process.execPath, [tsxCliPath, path.join(repoRoot, "apps", "server", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      NETCHAT_APP_DATA_DIR: config.appDataDirectory,
      NETCHAT_APP_DB_PATH: config.databasePath,
      NETCHAT_LOCAL_MODE: "true",
      NETCHAT_WEB_DIST_PATH: webDistPath,
      PORT: String(config.serverPort),
    },
    stdio: "inherit",
  });
  void serverProcess.exitPromise.catch(() => undefined);
  await waitForHealth(`${config.serverUrl}/health`);

  const daemonProcess = startProcess("daemon", process.execPath, [tsxCliPath, path.join(repoRoot, "apps", "daemon", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DAEMON_PORT: String(config.daemonPort),
      NETCHAT_APP_DATA_DIR: config.appDataDirectory,
      NETCHAT_LOCAL_MODE: "true",
      NETCHAT_MACHINE_STATE_PATH: config.machineStatePath,
      NETCHAT_SERVER_URL: config.serverUrl,
    },
    stdio: "inherit",
  });
  void daemonProcess.exitPromise.catch(() => undefined);

  await waitForHealth(`${config.daemonUrl}/health`);
  await waitForOnlineMachine(`${config.serverUrl}/api/machines`);

  log(`Local controller ready at ${config.serverUrl}.`);
  log(`Graph history will persist at ${config.databasePath}.`);
  if (config.openBrowser) {
    await openBrowser(config.serverUrl);
  }

  await Promise.race([serverProcess.exitPromise, daemonProcess.exitPromise]);
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

type WebBuildMode = "auto" | "skip" | "force";

type ParsedLocalAppArgs = {
  appDataDirectory: string | null;
  databasePath: string | null;
  machineStatePath: string | null;
  serverPort: number | null;
  daemonPort: number | null;
  openBrowser: boolean | null;
  webBuildMode: WebBuildMode | null;
};

type LocalAppConfig = {
  appDataDirectory: string;
  databasePath: string;
  machineStatePath: string;
  serverPort: number;
  daemonPort: number;
  serverUrl: string;
  daemonUrl: string;
  openBrowser: boolean;
  webBuildMode: WebBuildMode;
};

type WebBuildMarker = {
  version: 1;
  apiBaseUrl: string;
  daemonBaseUrl: string;
};

async function resolveLocalAppConfig(argv: string[]): Promise<LocalAppConfig> {
  const parsedArgs = parseLocalAppArgs(argv);
  const appDataDirectory =
    parsedArgs.appDataDirectory ??
    readStringEnv("NETCHAT_APP_DATA_DIR") ??
    path.join(os.homedir(), ".netchat");
  const databasePath =
    parsedArgs.databasePath ??
    readStringEnv("NETCHAT_APP_DB_PATH") ??
    path.join(appDataDirectory, "app.db");
  const machineStatePath =
    parsedArgs.machineStatePath ??
    readStringEnv("NETCHAT_MACHINE_STATE_PATH") ??
    path.join(appDataDirectory, "machine.json");
  const configuredServerPort = parsedArgs.serverPort ?? readPortEnv("PORT");
  const serverPort = await resolvePort("controller", configuredServerPort ?? 3001, {
    explicit: configuredServerPort !== null,
  });
  const configuredDaemonPort = parsedArgs.daemonPort ?? readPortEnv("DAEMON_PORT");
  const daemonPort = await resolvePort("daemon", configuredDaemonPort ?? 4318, {
    explicit: configuredDaemonPort !== null,
    reservedPorts: new Set([serverPort]),
  });
  const openBrowser =
    parsedArgs.openBrowser ?? !readBooleanEnv("NETCHAT_NO_BROWSER");
  const webBuildMode =
    parsedArgs.webBuildMode ??
    (readBooleanEnv("NETCHAT_FORCE_WEB_BUILD")
      ? "force"
      : readBooleanEnv("NETCHAT_SKIP_WEB_BUILD")
        ? "skip"
        : "auto");

  return {
    appDataDirectory,
    databasePath,
    machineStatePath,
    serverPort,
    daemonPort,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    daemonUrl: `http://127.0.0.1:${daemonPort}`,
    openBrowser,
    webBuildMode,
  };
}

function parseLocalAppArgs(argv: string[]): ParsedLocalAppArgs {
  const parsed: ParsedLocalAppArgs = {
    appDataDirectory: null,
    databasePath: null,
    machineStatePath: null,
    serverPort: null,
    daemonPort: null,
    openBrowser: null,
    webBuildMode: null,
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
      case "--machine-state-path": {
        const option = readOptionValue(flag, inlineValue, argv, index);
        parsed.machineStatePath = option.value;
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
      "  npx netchat",
      "  npx netchat --no-browser",
      "  npx netchat --port 3002 --daemon-port 4319",
      "",
      "Options:",
      "  --port <number>               Controller port (default: 3001)",
      "  --daemon-port <number>        Daemon port (default: 4318)",
      "  --data-dir <path>             Override the local app data directory",
      "  --db-path <path>              Override the SQLite database path",
      "  --machine-state-path <path>   Override the daemon machine-state path",
      "  --no-browser                  Do not open the browser automatically",
      "  --browser                     Force opening the browser even if env overrides disable it",
      "  --skip-web-build              Reuse the existing web build without rebuilding",
      "  --rebuild-web                 Force a fresh web build before startup",
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
  if (config.webBuildMode === "force") {
    return "Building the web UI because --rebuild-web was requested.";
  }

  if (!existsSync(webDistIndexPath)) {
    return "Building the web UI because no local build is available.";
  }

  const existingMarker = readWebBuildMarker();
  if (!existingMarker) {
    return "Building the web UI because the existing local build does not record its API endpoints.";
  }

  if (
    existingMarker.apiBaseUrl !== config.serverUrl ||
    existingMarker.daemonBaseUrl !== config.daemonUrl
  ) {
    return "Building the web UI because the local API endpoints changed.";
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

function writeWebBuildMarker(config: LocalAppConfig) {
  const marker: WebBuildMarker = {
    version: 1,
    apiBaseUrl: config.serverUrl,
    daemonBaseUrl: config.daemonUrl,
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

async function waitForOnlineMachine(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const machines = await requestJson<Array<{ status: string }>>(url);
      if (machines.some((machine) => machine.status === "online")) {
        return;
      }
    } catch {
      // Ignore while the local daemon is still registering.
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for the local daemon to register an online machine.");
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
      cwd: repoRoot,
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
