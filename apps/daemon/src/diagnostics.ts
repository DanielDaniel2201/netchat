import { DaemonDiagnostics, DaemonLogEntry, DaemonLogLevel, DaemonStatus, RuntimeEnvironment, makeId, nowIso } from "@netchat/shared";

const maxLogEntries = 120;

export class DaemonDiagnosticsStore {
  private snapshot: DaemonDiagnostics;

  constructor(initialEnvironment: RuntimeEnvironment) {
    this.snapshot = {
      startedAt: nowIso(),
      status: "starting",
      environment: initialEnvironment,
      serverUrl: process.env.NETCHAT_SERVER_URL?.trim() || null,
      pairingCodeConfigured: Boolean(process.env.NETCHAT_PAIRING_CODE?.trim()),
      machineName: process.env.NETCHAT_MACHINE_NAME?.trim() || null,
      machineId: null,
      machineStatePath: process.env.NETCHAT_MACHINE_STATE_PATH?.trim() || null,
      lastServerContactAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      logs: [],
    };
  }

  recordEnvironment(environment: RuntimeEnvironment) {
    this.snapshot.environment = environment;
    return this.getSnapshot();
  }

  recordMachineConfig(config: {
    machineId?: string | null;
    machineName?: string | null;
    machineStatePath?: string | null;
    pairingCodeConfigured?: boolean;
    serverUrl?: string | null;
  }) {
    if ("machineId" in config) {
      this.snapshot.machineId = config.machineId ?? null;
    }

    if ("machineName" in config) {
      this.snapshot.machineName = config.machineName ?? null;
    }

    if ("machineStatePath" in config) {
      this.snapshot.machineStatePath = config.machineStatePath ?? null;
    }

    if ("pairingCodeConfigured" in config && typeof config.pairingCodeConfigured === "boolean") {
      this.snapshot.pairingCodeConfigured = config.pairingCodeConfigured;
    }

    if ("serverUrl" in config) {
      this.snapshot.serverUrl = config.serverUrl ?? null;
    }
    return this.getSnapshot();
  }

  setStatus(status: DaemonStatus, message?: string, level: DaemonLogLevel = "info") {
    this.snapshot.status = status;
    if (status !== "error") {
      this.snapshot.lastError = null;
    }

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
  }
}
