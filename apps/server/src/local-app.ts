import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
const npmCliPath = process.env.npm_execpath?.trim() || null;
const appDataDirectory =
  process.env.NETCHAT_APP_DATA_DIR?.trim() || path.join(os.homedir(), ".netchat");
const databasePath =
  process.env.NETCHAT_APP_DB_PATH?.trim() || path.join(appDataDirectory, "app.db");
const machineStatePath =
  process.env.NETCHAT_MACHINE_STATE_PATH?.trim() || path.join(appDataDirectory, "machine.json");
const serverPort = Number(process.env.PORT ?? 3001);
const daemonPort = Number(process.env.DAEMON_PORT ?? 4318);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const webDistPath = path.join(repoRoot, "apps", "web", "dist");
const managedChildren: ChildProcess[] = [];

let shuttingDown = false;

await main().catch(async (error) => {
  console.error(`[netchat-local] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown("Local app failed to start cleanly.", 1);
});

async function main() {
  mkdirSync(appDataDirectory, { recursive: true });

  if (!existsSync(tsxCliPath)) {
    throw new Error(`tsx is not installed at ${tsxCliPath}. Run npm install first.`);
  }

  if (!npmCliPath) {
    throw new Error("npm_execpath is not available, so the local app launcher cannot run npm scripts.");
  }

  log("Preparing the local web app...");
  const shouldSkipBuild = (process.env.NETCHAT_SKIP_WEB_BUILD ?? "false").trim().toLowerCase() === "true";
  const shouldForceBuild = (process.env.NETCHAT_FORCE_WEB_BUILD ?? "false").trim().toLowerCase() === "true";
  if (shouldForceBuild || (!shouldSkipBuild && !existsSync(path.join(webDistPath, "index.html")))) {
    log("Building the web UI because no local build is available.");
    await runCommand(process.execPath, [npmCliPath, "run", "build:web"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_API_BASE_URL: serverUrl,
        VITE_DAEMON_BASE_URL: daemonUrl,
      },
      stdio: "inherit",
    });
  } else if (shouldSkipBuild) {
    log("Skipping the web build because NETCHAT_SKIP_WEB_BUILD=true.");
  } else {
    log("Reusing the existing web build. Set NETCHAT_FORCE_WEB_BUILD=true to rebuild it.");
  }

  if (!existsSync(path.join(webDistPath, "index.html"))) {
    throw new Error(`Local web build not found at ${webDistPath}.`);
  }

  const serverProcess = startProcess("controller", process.execPath, [tsxCliPath, path.join(repoRoot, "apps", "server", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      NETCHAT_APP_DATA_DIR: appDataDirectory,
      NETCHAT_APP_DB_PATH: databasePath,
      NETCHAT_LOCAL_MODE: "true",
      NETCHAT_WEB_DIST_PATH: webDistPath,
      PORT: String(serverPort),
    },
    stdio: "inherit",
  });
  void serverProcess.exitPromise.catch(() => undefined);
  await waitForHealth(`${serverUrl}/health`);

  const daemonProcess = startProcess("daemon", process.execPath, [tsxCliPath, path.join(repoRoot, "apps", "daemon", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DAEMON_PORT: String(daemonPort),
      NETCHAT_APP_DATA_DIR: appDataDirectory,
      NETCHAT_LOCAL_MODE: "true",
      NETCHAT_MACHINE_STATE_PATH: machineStatePath,
      NETCHAT_SERVER_URL: serverUrl,
    },
    stdio: "inherit",
  });
  void daemonProcess.exitPromise.catch(() => undefined);

  await waitForHealth(`${daemonUrl}/health`);
  await waitForOnlineMachine(`${serverUrl}/api/machines`);

  log(`Local controller ready at ${serverUrl}.`);
  log(`Graph history will persist at ${databasePath}.`);
  if ((process.env.NETCHAT_NO_BROWSER ?? "false").trim().toLowerCase() !== "true") {
    await openBrowser(serverUrl);
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
