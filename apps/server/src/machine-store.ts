import {
  CompleteMachineJobInput,
  CreateMachineHeartbeatInput,
  CreateMachineRegisterInput,
  MachineJob,
  MachineRecord,
  MachineRegistration,
  PairingSession,
  RuntimeResponse,
  makeId,
  nowIso,
} from "@netchat/shared";

import { ServerDiagnosticsStore } from "./diagnostics.js";

type RegisteredMachine = {
  id: string;
  secret: string;
  name: string;
  registeredAt: string;
  lastSeenAt: string;
  environment: MachineRecord["environment"];
};

type PendingJob = MachineJob & {
  machineId: string;
};

type EnqueuedJob =
  | {
      kind: "root-turn";
      payload: Extract<MachineJob, { kind: "root-turn" }>["payload"];
    }
  | {
      kind: "fork-branch";
      payload: Extract<MachineJob, { kind: "fork-branch" }>["payload"];
    }
  | {
      kind: "branch-turn";
      payload: Extract<MachineJob, { kind: "branch-turn" }>["payload"];
    };

type InFlightJob = {
  machineId: string;
  kind: MachineJob["kind"];
  enqueuedAtMs: number;
  claimedAtMs: number | null;
  resolve: (value: RuntimeResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PairingEntry = {
  code: string;
  expiresAt: string;
  label: string;
};

export class MachineStore {
  private readonly pairingSessions = new Map<string, PairingEntry>();
  private readonly machines = new Map<string, RegisteredMachine>();
  private readonly pendingJobs = new Map<string, PendingJob[]>();
  private readonly inFlightJobs = new Map<string, InFlightJob>();
  private readonly onlineThresholdMs = Number(process.env.NETCHAT_MACHINE_ONLINE_THRESHOLD_MS ?? 30000);
  private readonly jobTimeoutMs = Number(process.env.NETCHAT_JOB_TIMEOUT_MS ?? 600000);
  private readonly pollingIntervalMs = Number(process.env.NETCHAT_MACHINE_POLL_MS ?? 1200);
  private diagnostics?: ServerDiagnosticsStore;

  attachDiagnostics(diagnostics: ServerDiagnosticsStore) {
    this.diagnostics = diagnostics;
    this.syncDiagnostics();
  }

  getJobTimeoutMs() {
    return this.jobTimeoutMs;
  }

  getOnlineThresholdMs() {
    return this.onlineThresholdMs;
  }

  getPollingIntervalMs() {
    return this.pollingIntervalMs;
  }

  createPairingSession(label: string): PairingSession {
    const pairingCode = generatePairingCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.pairingSessions.set(pairingCode, {
      code: pairingCode,
      expiresAt,
      label,
    });

    return {
      pairingCode,
      expiresAt,
    };
  }

  registerMachine(input: CreateMachineRegisterInput): MachineRegistration {
    const pairing = this.pairingSessions.get(input.pairingCode);
    if (!pairing) {
      throw new Error("Invalid pairing code.");
    }

    if (Date.parse(pairing.expiresAt) < Date.now()) {
      this.pairingSessions.delete(input.pairingCode);
      throw new Error("Pairing code expired.");
    }

    this.pairingSessions.delete(input.pairingCode);

    const machineId = makeId("machine");
    const machineSecret = crypto.randomUUID();
    const registeredAt = nowIso();

    this.machines.set(machineId, {
      id: machineId,
      secret: machineSecret,
      name: input.machineName,
      registeredAt,
      lastSeenAt: registeredAt,
      environment: input.environment,
    });

    this.diagnostics?.clearError();
    this.diagnostics?.log("info", `Registered machine ${input.machineName} as ${machineId}.`);
    this.syncDiagnostics();

    return {
      machineId,
      machineSecret,
      pollingIntervalMs: this.pollingIntervalMs,
    };
  }

  heartbeat(input: CreateMachineHeartbeatInput): MachineRecord {
    const machine = this.authenticate(input.machineId, input.machineSecret);
    machine.lastSeenAt = nowIso();
    machine.environment = input.environment;
    this.syncDiagnostics();
    return this.toPublicRecord(machine);
  }

  listMachines(): MachineRecord[] {
    return Array.from(this.machines.values())
      .map((machine) => this.toPublicRecord(machine))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  resolveMachine(preferredMachineId?: string | null): MachineRecord {
    if (preferredMachineId) {
      const preferred = this.machines.get(preferredMachineId);
      if (!preferred) {
        throw new Error("Selected machine does not exist.");
      }

      const record = this.toPublicRecord(preferred);
      if (record.status !== "online") {
        throw new Error("Selected machine is offline.");
      }
      return record;
    }

    const online = this.listMachines().filter((machine) => machine.status === "online");
    if (online.length === 0) {
      throw new Error("No online machine is registered yet.");
    }

    if (online.length > 1) {
      throw new Error("Multiple machines are online. Select one explicitly.");
    }

    return online[0];
  }

  enqueueJob(machineId: string, job: EnqueuedJob): Promise<RuntimeResponse> {
    const machine = this.resolveMachine(machineId);
    const pending = this.pendingJobs.get(machine.id) ?? [];
    const base = {
      id: makeId("job"),
      createdAt: nowIso(),
      machineId: machine.id,
    };

    const queuedJob: PendingJob =
      job.kind === "root-turn"
        ? {
            ...base,
            kind: "root-turn",
            payload: job.payload,
          }
        : job.kind === "fork-branch"
          ? {
              ...base,
              kind: "fork-branch",
              payload: job.payload,
            }
          : {
              ...base,
              kind: "branch-turn",
              payload: job.payload,
            };

    pending.push(queuedJob);
    this.pendingJobs.set(machine.id, pending);
    this.diagnostics?.log(
      "info",
      `Enqueued job ${queuedJob.id} (${queuedJob.kind}) for ${machine.name}. Pending jobs: ${pending.length}.`,
    );
    this.syncDiagnostics();

    return new Promise<RuntimeResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.inFlightJobs.delete(queuedJob.id);
        this.pendingJobs.set(
          machine.id,
          (this.pendingJobs.get(machine.id) ?? []).filter((candidate) => candidate.id !== queuedJob.id),
        );
        this.diagnostics?.log(
          "error",
          `Job ${queuedJob.id} (${queuedJob.kind}) timed out after ${formatDuration(this.jobTimeoutMs)} on ${machine.name}.`,
        );
        this.syncDiagnostics();
        reject(new Error("Machine job timed out."));
      }, this.jobTimeoutMs);

      this.inFlightJobs.set(queuedJob.id, {
        machineId: machine.id,
        kind: queuedJob.kind,
        enqueuedAtMs: Date.now(),
        claimedAtMs: null,
        resolve,
        reject,
        timeout,
      });
      this.syncDiagnostics();
    });
  }

  claimJob(machineId: string, machineSecret: string): MachineJob | null {
    this.authenticate(machineId, machineSecret).lastSeenAt = nowIso();
    const pending = this.pendingJobs.get(machineId) ?? [];
    const next = pending.shift() ?? null;
    this.pendingJobs.set(machineId, pending);
    if (next) {
      const inFlight = this.inFlightJobs.get(next.id);
      if (inFlight) {
        inFlight.claimedAtMs = Date.now();
      }

      this.diagnostics?.clearError();
      this.diagnostics?.log("info", `Machine ${machineId} claimed job ${next.id} (${next.kind}).`);
    }
    this.syncDiagnostics();
    return next;
  }

  completeJob(jobId: string, input: CompleteMachineJobInput): void {
    this.authenticate(input.machineId, input.machineSecret).lastSeenAt = nowIso();
    const inFlight = this.inFlightJobs.get(jobId);
    if (!inFlight) {
      this.diagnostics?.log(
        "warn",
        `Machine ${input.machineId} tried to complete unknown or expired job ${jobId}.`,
      );
      this.syncDiagnostics();
      throw new Error("Unknown machine job.");
    }

    if (inFlight.machineId !== input.machineId) {
      this.diagnostics?.log(
        "error",
        `Machine ${input.machineId} tried to complete job ${jobId} owned by ${inFlight.machineId}.`,
      );
      throw new Error("Machine is not allowed to complete this job.");
    }

    clearTimeout(inFlight.timeout);
    this.inFlightJobs.delete(jobId);
    const totalDurationMs = Date.now() - inFlight.enqueuedAtMs;
    const executionDurationMs = inFlight.claimedAtMs
      ? Date.now() - inFlight.claimedAtMs
      : totalDurationMs;

    if (!input.success || !input.response) {
      this.diagnostics?.log(
        "error",
        `Job ${jobId} (${inFlight.kind}) failed on ${input.machineId} after ${formatDuration(executionDurationMs)}: ${input.error?.trim() || "Machine job failed."}`,
      );
      this.syncDiagnostics();
      inFlight.reject(new Error(input.error?.trim() || "Machine job failed."));
      return;
    }

    this.diagnostics?.clearError();
    this.diagnostics?.log(
      "info",
      `Job ${jobId} (${inFlight.kind}) completed on ${input.machineId} in ${formatDuration(executionDurationMs)} (total ${formatDuration(totalDurationMs)}).`,
    );
    this.syncDiagnostics();
    inFlight.resolve({
      ...input.response,
      machineId: input.machineId,
    });
  }

  private authenticate(machineId: string, machineSecret: string): RegisteredMachine {
    const machine = this.machines.get(machineId);
    if (!machine || machine.secret !== machineSecret) {
      throw new Error("Machine authentication failed.");
    }

    return machine;
  }

  private toPublicRecord(machine: RegisteredMachine): MachineRecord {
    return {
      id: machine.id,
      name: machine.name,
      registeredAt: machine.registeredAt,
      lastSeenAt: machine.lastSeenAt,
      environment: machine.environment,
      status: Date.now() - Date.parse(machine.lastSeenAt) <= this.onlineThresholdMs ? "online" : "offline",
    };
  }

  private syncDiagnostics() {
    this.diagnostics?.recordState({
      machineCount: this.machines.size,
      onlineMachineCount: Array.from(this.machines.values()).filter(
        (machine) => Date.now() - Date.parse(machine.lastSeenAt) <= this.onlineThresholdMs,
      ).length,
      pendingJobCount: Array.from(this.pendingJobs.values()).reduce(
        (total, jobs) => total + jobs.length,
        0,
      ),
      inFlightJobCount: this.inFlightJobs.size,
    });
  }
}

function generatePairingCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${(seconds / 60).toFixed(1)}m`;
}
