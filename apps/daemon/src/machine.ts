import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CompleteMachineJobInput,
  ContinueBranchRuntimeRequest,
  CreateMachineHeartbeatInput,
  CreateMachineRegisterInput,
  ForkBranchRuntimeRequest,
  MachineJob,
  MachineRegistration,
  RootTurnRuntimeRequest,
  RuntimeEnvironment,
  RuntimeResponse,
} from "@netchat/shared";

type MachineState = {
  machineId: string;
  machineSecret: string;
  pollingIntervalMs: number;
};

export class MachineClient {
  private readonly serverUrl = process.env.NETCHAT_SERVER_URL?.trim() || "";
  private readonly pairingCode = process.env.NETCHAT_PAIRING_CODE?.trim() || "";
  private readonly localMode = (process.env.NETCHAT_LOCAL_MODE ?? "false").toLowerCase() === "true";
  private readonly machineName =
    process.env.NETCHAT_MACHINE_NAME?.trim() || `${os.hostname()} (${process.platform})`;
  private readonly statePath =
    process.env.NETCHAT_MACHINE_STATE_PATH?.trim() ||
    path.join(os.homedir(), ".netchat", "machine.json");
  private state: MachineState | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private claimTimer: NodeJS.Timeout | null = null;
  private isExecutingJob = false;
  private registrationPromise: Promise<void> | null = null;

  constructor(
    private readonly runtime: {
      getMode(): "mock" | "claude";
      getWorkingDirectory(): string;
      runRootTurn(input: RootTurnRuntimeRequest): Promise<RuntimeResponse>;
      forkBranch(input: ForkBranchRuntimeRequest): Promise<RuntimeResponse>;
      continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse>;
    },
    private readonly detectEnvironment: () => Promise<RuntimeEnvironment>,
    private readonly diagnostics?: {
      log: (level: "info" | "warn" | "error", message: string) => void;
      recordMachineConfig: (config: {
        machineId?: string | null;
        machineName?: string | null;
        machineStatePath?: string | null;
        pairingCodeConfigured?: boolean;
        serverUrl?: string | null;
      }) => void;
      recordServerContact: (message?: string) => void;
      recordHeartbeat: (message?: string) => void;
      setStatus: (status: "starting" | "local_only" | "waiting_for_pairing" | "registering" | "registered" | "online" | "error", message?: string, level?: "info" | "warn" | "error") => void;
      recordError: (message: string) => void;
      clearError: () => void;
    },
  ) {
    this.state = this.readState();
    this.diagnostics?.recordMachineConfig({
      machineId: this.state?.machineId ?? null,
      machineName: this.machineName,
      machineStatePath: this.statePath,
      pairingCodeConfigured: Boolean(this.pairingCode),
      serverUrl: this.serverUrl || null,
    });
  }

  hasServerUrl() {
    return this.serverUrl.length > 0;
  }

  async start() {
    if (!this.hasServerUrl()) {
      this.diagnostics?.setStatus(
        "local_only",
        "NETCHAT_SERVER_URL is not set. The daemon can detect Claude locally but will not register a machine.",
        "warn",
      );
      return;
    }

    this.diagnostics?.setStatus("starting", "Daemon machine client starting.");
    await this.ensureRegistration();
    this.scheduleHeartbeat(0);
    this.scheduleClaim(0);
  }

  private async ensureRegistration() {
    if (this.state) {
      this.diagnostics?.setStatus(
        "registered",
        `Using cached machine registration ${this.state.machineId}.`,
      );
      this.diagnostics?.recordMachineConfig({
        machineId: this.state.machineId,
      });
      return;
    }

    if (this.registrationPromise) {
      await this.registrationPromise;
      return;
    }

    this.registrationPromise = this.registerMachine().finally(() => {
      this.registrationPromise = null;
    });
    await this.registrationPromise;
  }

  private async registerMachine() {
    if (!this.localMode && !this.pairingCode) {
      this.diagnostics?.setStatus(
        "waiting_for_pairing",
        "NETCHAT_PAIRING_CODE is required for the first daemon registration.",
        "warn",
      );
      throw new Error("NETCHAT_PAIRING_CODE is required for the first daemon registration.");
    }

    this.diagnostics?.setStatus("registering", `Registering machine "${this.machineName}" with server.`);
    const environment = await this.detectEnvironment();
    const pairingCode = this.localMode ? this.pairingCode || "local" : this.pairingCode;
    const registration = await this.request<MachineRegistration>("/api/daemon/register", {
      method: "POST",
      body: JSON.stringify({
        pairingCode,
        machineName: this.machineName,
        environment,
      } satisfies CreateMachineRegisterInput),
    });

    this.state = {
      machineId: registration.machineId,
      machineSecret: registration.machineSecret,
      pollingIntervalMs: registration.pollingIntervalMs,
    };
    this.writeState(this.state);
    this.diagnostics?.recordMachineConfig({
      machineId: registration.machineId,
    });
    this.diagnostics?.recordServerContact(`Machine registered as ${registration.machineId}.`);
    this.diagnostics?.setStatus("registered");
  }

  private async sendHeartbeat() {
    if (!this.state) {
      return;
    }

    try {
      const environment = await this.detectEnvironment();
      await this.request("/api/daemon/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          machineId: this.state.machineId,
          machineSecret: this.state.machineSecret,
          environment,
        } satisfies CreateMachineHeartbeatInput),
      });
      this.diagnostics?.recordHeartbeat();
      this.diagnostics?.setStatus("online");
    } catch (error) {
      await this.handleMachineError(error, "heartbeat");
    } finally {
      if (!this.state) {
        return;
      }

      this.scheduleHeartbeat(this.state.pollingIntervalMs);
    }
  }

  private async pollForJob() {
    if (!this.state) {
      return;
    }

    try {
      if (this.isExecutingJob) {
        return;
      }

      const claimed = await this.request<{ job: MachineJob | null }>("/api/daemon/jobs/claim", {
        method: "POST",
        body: JSON.stringify({
          machineId: this.state.machineId,
          machineSecret: this.state.machineSecret,
        }),
      });
      this.diagnostics?.recordServerContact(
        claimed.job ? `Claimed job ${claimed.job.id} (${claimed.job.kind}).` : undefined,
      );

      if (claimed.job) {
        this.isExecutingJob = true;
        this.diagnostics?.log("info", `Executing job ${claimed.job.id} (${claimed.job.kind}) on local runtime.`);
        try {
          await this.executeJob(claimed.job);
        } finally {
          this.isExecutingJob = false;
        }
      }
    } catch (error) {
      await this.handleMachineError(error, "job-poll");
    } finally {
      if (!this.state) {
        return;
      }

      this.scheduleClaim(this.state.pollingIntervalMs);
    }
  }

  private async executeJob(job: MachineJob) {
    if (!this.state) {
      return;
    }

    try {
      let response: RuntimeResponse;

      switch (job.kind) {
        case "root-turn":
          response = await this.runtime.runRootTurn(job.payload);
          break;
        case "fork-branch":
          response = await this.runtime.forkBranch(job.payload);
          break;
        case "branch-turn":
          response = await this.runtime.continueBranch(job.payload);
          break;
      }

      this.diagnostics?.log(
        "info",
        `Local runtime finished job ${job.id} (${job.kind}). Reporting completion to server.`,
      );
      await this.request(`/api/daemon/jobs/${job.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          machineId: this.state.machineId,
          machineSecret: this.state.machineSecret,
          success: true,
          response: {
            ...response,
            machineId: this.state.machineId,
          },
        } satisfies CompleteMachineJobInput),
      });
      this.diagnostics?.clearError();
      this.diagnostics?.recordServerContact(`Completed job ${job.id}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown daemon execution error";
      this.diagnostics?.recordError(
        `Job ${job.id} (${job.kind}) failed on local runtime: ${message}`,
      );
      try {
        await this.request(`/api/daemon/jobs/${job.id}/complete`, {
          method: "POST",
          body: JSON.stringify({
            machineId: this.state.machineId,
            machineSecret: this.state.machineSecret,
            success: false,
            error: message,
          } satisfies CompleteMachineJobInput),
        });
        this.diagnostics?.recordServerContact(`Reported failure for job ${job.id}.`);
      } catch (reportError) {
        const reportMessage =
          reportError instanceof Error ? reportError.message : "Unknown completion reporting error";
        this.diagnostics?.recordError(
          `Job ${job.id} failed and the daemon could not report that failure back to the server: ${reportMessage}`,
        );
        throw reportError;
      }
    }
  }

  private async request<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response, `Daemon server request failed: ${response.status}`));
    }

    return response.json() as Promise<T>;
  }

  private readState(): MachineState | null {
    if (!existsSync(this.statePath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as MachineState;
    } catch {
      return null;
    }
  }

  private writeState(state: MachineState) {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private clearState() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
      this.claimTimer = null;
    }

    if (existsSync(this.statePath)) {
      rmSync(this.statePath, { force: true });
    }

    this.state = null;
    this.isExecutingJob = false;
    this.diagnostics?.recordMachineConfig({
      machineId: null,
    });
  }

  private shouldResetRegistration(error: unknown) {
    return error instanceof Error && /Machine authentication failed/i.test(error.message);
  }

  private scheduleHeartbeat(delayMs: number) {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.sendHeartbeat();
    }, delayMs);
  }

  private scheduleClaim(delayMs: number) {
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
    }

    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      void this.pollForJob();
    }, delayMs);
  }

  private async handleMachineError(error: unknown, stage: "heartbeat" | "job-poll") {
    const message = error instanceof Error ? error.message : String(error);

    if (this.shouldResetRegistration(error)) {
      if (!this.state) {
        try {
          await this.ensureRegistration();
        } catch (registrationError) {
          const registrationMessage =
            registrationError instanceof Error ? registrationError.message : String(registrationError);
          this.diagnostics?.recordError(registrationMessage);
        }
        return;
      }

      this.diagnostics?.log(
        "warn",
        "Server rejected the cached machine registration. Clearing local machine state.",
      );
      this.clearState();

      try {
        await this.ensureRegistration();
      } catch (registrationError) {
        const registrationMessage =
          registrationError instanceof Error ? registrationError.message : String(registrationError);
        this.diagnostics?.recordError(registrationMessage);
      }
      return;
    }

    this.diagnostics?.recordError(`${stage} error: ${message}`);
  }
}

async function readErrorMessage(response: Response, fallback: string) {
  const payload = (await response.text()).trim();
  if (!payload) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(payload) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }

    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    return payload;
  }

  return payload;
}
