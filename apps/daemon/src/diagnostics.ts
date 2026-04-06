import {
  AgentRuntimeEnvironment,
  DaemonDiagnostics,
  DaemonLogEntry,
  DaemonLogLevel,
  DaemonStatus,
  makeId,
  nowIso,
} from "@netchat/shared";

const maxLogEntries = 120;
const daemonLogPrefix = "[netchat-daemon]";
const daemonLogColors = {
  error: "\x1b[31m",
  info: "\x1b[37m",
  warn: "\x1b[33m",
} satisfies Record<DaemonLogLevel, string>;
const ansiReset = "\x1b[0m";

export class DaemonDiagnosticsStore {
  private snapshot: DaemonDiagnostics;

  constructor(initialEnvironment: AgentRuntimeEnvironment) {
    this.snapshot = {
      startedAt: nowIso(),
      status: "starting",
      localMode: (process.env.NETCHAT_LOCAL_MODE ?? "false").toLowerCase() === "true",
      environment: initialEnvironment,
      serverUrl: process.env.NETCHAT_SERVER_URL?.trim() || null,
      machineName: process.env.NETCHAT_MACHINE_NAME?.trim() || null,
      machineId: null,
      lastServerContactAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      logs: [],
    };
  }

  recordEnvironment(environment: AgentRuntimeEnvironment) {
    this.snapshot.environment = environment;
    return this.getSnapshot();
  }

  recordMachineConfig(config: {
    machineId?: string | null;
    machineName?: string | null;
    serverUrl?: string | null;
  }) {
    if ("machineId" in config) {
      this.snapshot.machineId = config.machineId ?? null;
    }

    if ("machineName" in config) {
      this.snapshot.machineName = config.machineName ?? null;
    }

    if ("serverUrl" in config) {
      this.snapshot.serverUrl = config.serverUrl ?? null;
    }
    return this.getSnapshot();
  }

  setStatus(status: DaemonStatus, message?: string, level: DaemonLogLevel = "info") {
    this.snapshot.status = status;
    if (message) {
      this.appendLog(level, message);
    }
    return this.getSnapshot();
  }

  recordServerContact(message?: string) {
    this.snapshot.lastServerContactAt = nowIso();
    if (message) {
      this.appendLog("info", message);
    }
    return this.getSnapshot();
  }

  recordHeartbeat(message?: string) {
    const timestamp = nowIso();
    this.snapshot.lastServerContactAt = timestamp;
    this.snapshot.lastHeartbeatAt = timestamp;
    if (message) {
      this.appendLog("info", message);
    }
    return this.getSnapshot();
  }

  recordError(message: string) {
    this.snapshot.status = "error";
    this.snapshot.lastError = message;
    this.appendLog("error", message);
    return this.getSnapshot();
  }

  clearError() {
    this.snapshot.lastError = null;
    return this.getSnapshot();
  }

  log(level: DaemonLogLevel, message: string) {
    this.appendLog(level, message);
    return this.getSnapshot();
  }

  getSnapshot(): DaemonDiagnostics {
    return {
      ...this.snapshot,
      logs: [...this.snapshot.logs],
    };
  }

  private appendLog(level: DaemonLogLevel, message: string) {
    const entry: DaemonLogEntry = {
      id: makeId("daemonlog"),
      level,
      message,
      timestamp: nowIso(),
    };

    this.snapshot.logs = [entry, ...this.snapshot.logs].slice(0, maxLogEntries);
    emitConsoleLog(level, message);
  }
}

function emitConsoleLog(level: DaemonLogLevel, message: string) {
  const formatted = `${daemonLogColors[level]}${daemonLogPrefix}[${level}] ${message}${ansiReset}`;
  if (level === "error") {
    console.error(formatted);
    return;
  }

  if (level === "warn") {
    console.warn(formatted);
    return;
  }

  console.info(formatted);
}
