import {
  AgentRuntimeOption,
  AgentTurnEvent,
  AgentTurnInput,
  AgentTurnResult,
  CompleteMachineJobInput,
  CreateMachineJobEventInput,
  CreateMachineHeartbeatInput,
  CreateMachineRegisterInput,
  MachineJob,
  MachineRecord,
  MachineRegistration,
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

type EnqueuedJob = {
  kind: MachineJob["kind"];
  payload: AgentTurnInput;
};

type InFlightJob = {
  machineId: string;
  kind: MachineJob["kind"];
  enqueuedAtMs: number;
  claimedAtMs: number | null;
  resolve: (value: AgentTurnResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type JobEventListener = (event: AgentTurnEvent) => void;

export type StreamingJobHandle = {
  jobId: string;
  result: Promise<AgentTurnResult>;
  subscribe: (listener: JobEventListener) => () => void;
  dispose: () => void;
};

export class MachineStore {
  private readonly machines = new Map<string, RegisteredMachine>();
  private readonly pendingJobs = new Map<string, PendingJob[]>();
  private readonly inFlightJobs = new Map<string, InFlightJob>();
  private readonly jobEventHistory = new Map<string, AgentTurnEvent[]>();
  private readonly jobEventListeners = new Map<string, Set<JobEventListener>>();
  private readonly localMode = (process.env.NETCHAT_LOCAL_MODE ?? "false").toLowerCase() === "true";
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

  registerMachine(input: CreateMachineRegisterInput): MachineRegistration {
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

  listAgentRuntimes(): AgentRuntimeOption[] {
    const grouped = new Map<string, MachineRecord[]>();

    for (const machine of this.listMachines()) {
      const runtimeId = machine.environment.runtimeId;
      const group = grouped.get(runtimeId) ?? [];
      group.push(machine);
      grouped.set(runtimeId, group);
    }

    const agents: AgentRuntimeOption[] = [];
    for (const [runtimeId, machines] of grouped.entries()) {
      const preferredMachine = [...machines].sort(comparePreferredRuntimeMachine)[0] ?? null;
      const environment = preferredMachine?.environment;
      if (!preferredMachine || !environment) {
        continue;
      }

      agents.push({
          runtimeId,
          runtimeKind: environment.runtimeKind,
          runtimeLabel: environment.runtimeLabel,
          machineId: preferredMachine.id,
          machineName: preferredMachine.name,
          status: preferredMachine.status,
          installed: environment.installed,
          version: environment.version,
          executablePath: environment.executablePath,
          workingDirectory: environment.workingDirectory,
          detectionError: environment.detectionError,
      });
    }

    return agents.sort(compareAgentRuntimeOption);
  }

  resolveMachine(input?: {
    preferredMachineId?: string | null;
    preferredRuntimeId?: string | null;
  }): MachineRecord {
    const preferredMachineId = input?.preferredMachineId ?? null;
    const preferredRuntimeId = input?.preferredRuntimeId ?? null;

    if (preferredMachineId) {
      const preferred = this.machines.get(preferredMachineId);
      if (preferred) {
        const record = this.toPublicRecord(preferred);
        if (record.status === "online" && record.environment.installed) {
          return record;
        }
      }
    }

    if (preferredRuntimeId) {
      const runtimeMatch = this.listMachines()
        .filter(
          (machine) =>
            machine.environment.runtimeId === preferredRuntimeId &&
            machine.status === "online" &&
            machine.environment.installed,
        )
        .sort(comparePreferredRuntimeMachine)[0];

      if (runtimeMatch) {
        return runtimeMatch;
      }
    }

    if (preferredMachineId || preferredRuntimeId) {
      const fallback = this.resolveSingleLocalMachineFallback(preferredMachineId ?? preferredRuntimeId ?? "unknown");
      if (fallback) {
        return fallback;
      }

      if (preferredRuntimeId) {
        throw new Error("The selected agent is offline or not installed.");
      }

      if (!preferredMachineId || !this.machines.get(preferredMachineId)) {
        throw new Error("Selected machine does not exist.");
      }

      throw new Error("Selected machine is offline.");
    }

    const online = this.listMachines().filter((machine) => machine.status === "online" && machine.environment.installed);
    if (online.length === 0) {
      throw new Error("No installed online agent is registered yet.");
    }

    if (online.length > 1) {
      throw new Error("Multiple agents are online. Select one explicitly.");
    }

    return online[0];
  }

  enqueueJob(
    machine: string | { preferredMachineId?: string | null; preferredRuntimeId?: string | null },
    job: EnqueuedJob,
  ): Promise<AgentTurnResult> {
    const handle = this.enqueueStreamingJob(machine, job);
    handle.result.finally(handle.dispose);
    return handle.result;
  }

  enqueueStreamingJob(
    machine: string | { preferredMachineId?: string | null; preferredRuntimeId?: string | null },
    job: EnqueuedJob,
  ): StreamingJobHandle {
    const resolvedMachine =
      typeof machine === "string" ? this.resolveMachine({ preferredMachineId: machine }) : this.resolveMachine(machine);
    const pending = this.pendingJobs.get(resolvedMachine.id) ?? [];
    const base = {
      id: makeId("job"),
      createdAt: nowIso(),
      machineId: resolvedMachine.id,
    };

    const queuedJob: PendingJob = {
      ...base,
      kind: job.kind,
      payload: job.payload,
    };

    pending.push(queuedJob);
    this.pendingJobs.set(resolvedMachine.id, pending);
    this.jobEventHistory.set(queuedJob.id, []);
    this.jobEventListeners.set(queuedJob.id, new Set());
    this.diagnostics?.log(
      "info",
      `Enqueued job ${queuedJob.id} (${queuedJob.kind}) for ${resolvedMachine.name}. Pending jobs: ${pending.length}.`,
    );
    this.syncDiagnostics();

    const result = new Promise<AgentTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.inFlightJobs.delete(queuedJob.id);
        this.pendingJobs.set(
          resolvedMachine.id,
          (this.pendingJobs.get(resolvedMachine.id) ?? []).filter((candidate) => candidate.id !== queuedJob.id),
        );
        this.jobEventHistory.delete(queuedJob.id);
        this.jobEventListeners.delete(queuedJob.id);
        this.diagnostics?.log(
          "error",
          `Job ${queuedJob.id} (${queuedJob.kind}) timed out after ${formatDuration(this.jobTimeoutMs)} on ${resolvedMachine.name}.`,
        );
        this.syncDiagnostics();
        reject(new Error("Machine job timed out."));
      }, this.jobTimeoutMs);

      this.inFlightJobs.set(queuedJob.id, {
        machineId: resolvedMachine.id,
        kind: queuedJob.kind,
        enqueuedAtMs: Date.now(),
        claimedAtMs: null,
        resolve,
        reject,
        timeout,
      });
      this.syncDiagnostics();
    });

    return {
      jobId: queuedJob.id,
      result,
      subscribe: (listener) => {
        const listeners = this.jobEventListeners.get(queuedJob.id);
        const history = this.jobEventHistory.get(queuedJob.id) ?? [];

        listeners?.add(listener);
        for (const event of history) {
          listener(event);
        }

        return () => {
          listeners?.delete(listener);
        };
      },
      dispose: () => {
        this.jobEventHistory.delete(queuedJob.id);
        this.jobEventListeners.delete(queuedJob.id);
      },
    };
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

  recordJobEvent(jobId: string, input: CreateMachineJobEventInput): void {
    this.authenticate(input.machineId, input.machineSecret).lastSeenAt = nowIso();
    const inFlight = this.inFlightJobs.get(jobId);
    if (!inFlight) {
      throw new Error("Unknown machine job.");
    }

    if (inFlight.machineId !== input.machineId) {
      throw new Error("Machine is not allowed to publish events for this job.");
    }

    const history = this.jobEventHistory.get(jobId);
    if (history) {
      history.push(input.event);
    }

    for (const listener of this.jobEventListeners.get(jobId) ?? []) {
      listener(input.event);
    }
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

  private resolveSingleLocalMachineFallback(staleMachineLabel: string) {
    if (!this.localMode) {
      return null;
    }

    const online = this.listMachines().filter((machine) => machine.status === "online" && machine.environment.installed);
    if (online.length !== 1) {
      return null;
    }

    const fallback = online[0];
    if (fallback.id === staleMachineLabel || fallback.environment.runtimeId === staleMachineLabel) {
      return fallback;
    }

    this.diagnostics?.log(
      "warn",
      `Falling back from stale agent target ${staleMachineLabel} to the active local machine ${fallback.id}.`,
    );
    return fallback;
  }
}

function comparePreferredRuntimeMachine(left: MachineRecord, right: MachineRecord) {
  if (left.status !== right.status) {
    return left.status === "online" ? -1 : 1;
  }

  if (left.environment.installed !== right.environment.installed) {
    return left.environment.installed ? -1 : 1;
  }

  return right.lastSeenAt.localeCompare(left.lastSeenAt);
}

function compareAgentRuntimeOption(left: AgentRuntimeOption, right: AgentRuntimeOption) {
  const kindDelta = compareRuntimeKindPriority(left.runtimeKind, right.runtimeKind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  if (left.installed !== right.installed) {
    return left.installed ? -1 : 1;
  }

  if (left.status !== right.status) {
    return left.status === "online" ? -1 : 1;
  }

  return left.runtimeLabel.localeCompare(right.runtimeLabel);
}

function compareRuntimeKindPriority(left: AgentRuntimeOption["runtimeKind"], right: AgentRuntimeOption["runtimeKind"]) {
  return getRuntimeKindPriority(left) - getRuntimeKindPriority(right);
}

function getRuntimeKindPriority(runtimeKind: AgentRuntimeOption["runtimeKind"]) {
  switch (runtimeKind) {
    case "claude":
      return 0;
    case "codex":
      return 1;
    case "droid":
      return 2;
    case "opencode":
      return 3;
    case "mock":
      return 4;
  }
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
