import { DaemonLogEntry, DaemonLogLevel, ServerDiagnostics, makeId, nowIso } from "@netchat/shared";

const maxLogEntries = 160;
const serverLogPrefix = "[netchat-server]";
const serverLogColors = {
  error: "\x1b[31m",
  info: "\x1b[37m",
  warn: "\x1b[33m",
} satisfies Record<DaemonLogLevel, string>;
const ansiReset = "\x1b[0m";

export class ServerDiagnosticsStore {
  private snapshot: ServerDiagnostics;

  constructor(config: {
    jobTimeoutMs: number;
    onlineThresholdMs: number;
    pollingIntervalMs: number;
  }) {
    this.snapshot = {
      startedAt: nowIso(),
      jobTimeoutMs: config.jobTimeoutMs,
      onlineThresholdMs: config.onlineThresholdMs,
      pollingIntervalMs: config.pollingIntervalMs,
      machineCount: 0,
      onlineMachineCount: 0,
      pendingJobCount: 0,
      inFlightJobCount: 0,
      lastError: null,
      logs: [],
    };
  }

  recordState(state: {
    machineCount: number;
    onlineMachineCount: number;
    pendingJobCount: number;
    inFlightJobCount: number;
  }) {
    this.snapshot.machineCount = state.machineCount;
    this.snapshot.onlineMachineCount = state.onlineMachineCount;
    this.snapshot.pendingJobCount = state.pendingJobCount;
    this.snapshot.inFlightJobCount = state.inFlightJobCount;
    return this.getSnapshot();
  }

  log(level: DaemonLogLevel, message: string) {
    if (level === "error") {
      this.snapshot.lastError = message;
    }

    this.appendLog(level, message);
    return this.getSnapshot();
  }

  clearError() {
    this.snapshot.lastError = null;
    return this.getSnapshot();
  }

  getSnapshot(): ServerDiagnostics {
    return {
      ...this.snapshot,
      logs: [...this.snapshot.logs],
    };
  }

  private appendLog(level: DaemonLogLevel, message: string) {
    const entry: DaemonLogEntry = {
      id: makeId("serverlog"),
      level,
      message,
      timestamp: nowIso(),
    };

    this.snapshot.logs = [entry, ...this.snapshot.logs].slice(0, maxLogEntries);
    emitConsoleLog(level, message);
  }
}

function emitConsoleLog(level: DaemonLogLevel, message: string) {
  const formatted = `${serverLogColors[level]}${serverLogPrefix}[${level}] ${message}${ansiReset}`;
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
