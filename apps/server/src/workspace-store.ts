import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentRuntimeKind,
  AgentTurnResult,
  AssistantStreamState,
  Branch,
  CreateBranchInput,
  CreateNetInput,
  GraphSnapshot,
  MessageNode,
  UpdateNetInput,
  WorkspaceNetSummary,
  WorkspaceState,
  nowIso,
  resolveAgentRuntimeLabel,
} from "@netchat/shared";

import { GraphStore, readLatestMessageTimestamp, readLatestUserMessageTimestamp } from "./store.js";

type WorkspaceNetRecord = Omit<WorkspaceNetSummary, "latestMessageAt" | "agentRuntimeLabel"> & {
  databasePath: string;
};

type WorkspaceManifest = {
  version: 2;
  workspaceId: string;
  workingDirectory: string;
  activeNetId: string;
  nets: WorkspaceNetRecord[];
};

type WorkspaceStoreOptions = {
  workingDirectory?: string;
  ensureLaunchNet?: boolean;
  useConfiguredInitialDatabasePath?: boolean;
};

export class WorkspaceStore {
  private readonly workingDirectory: string;
  private readonly workspaceDataDirectory: string;
  private readonly workspaceId: string;
  private readonly manifestPath: string;
  private readonly netsDirectory: string;
  private readonly configuredInitialDatabasePath: string | null;
  private manifest: WorkspaceManifest;
  private activeStore: GraphStore;

  constructor(options: WorkspaceStoreOptions = {}) {
    this.workingDirectory = normalizeWorkingDirectory(options.workingDirectory ?? resolveWorkspaceWorkingDirectory());
    this.workspaceId = createWorkspaceStorageKey(this.workingDirectory);
    this.workspaceDataDirectory = resolveWorkspaceDataDirectory(this.workingDirectory);
    this.manifestPath = path.join(this.workspaceDataDirectory, "workspace.json");
    this.netsDirectory = path.join(this.workspaceDataDirectory, "nets");
    this.configuredInitialDatabasePath =
      options.useConfiguredInitialDatabasePath === false ? null : resolveConfiguredInitialDatabasePath();

    mkdirSync(this.workspaceDataDirectory, { recursive: true });
    mkdirSync(this.netsDirectory, { recursive: true });

    this.manifest = this.loadManifest();
    if (options.ensureLaunchNet ?? true) {
      this.manifest = this.ensureLaunchNet(this.manifest);
    }
    this.activeStore = new GraphStore(this.getActiveNetRecord().databasePath);
  }

  dispose() {
    this.activeStore.dispose();
  }

  getWorkspaceState(): WorkspaceState {
    const netSummaries = this.manifest.nets.map((net) => this.buildNetSummary(net));

    return {
      workspaceId: this.manifest.workspaceId,
      workingDirectory: this.manifest.workingDirectory,
      activeNetId: this.manifest.activeNetId,
      nets: netSummaries.sort(compareNetSummaryActivity),
    };
  }

  getSnapshot(): GraphSnapshot {
    return this.activeStore.getSnapshot();
  }

  getActiveNetSummary(): WorkspaceNetSummary {
    return this.buildNetSummary(this.getActiveNetRecord());
  }

  getBranch(branchId: string): Branch | undefined {
    return this.activeStore.getBranch(branchId);
  }

  getMessage(messageId: string): MessageNode | undefined {
    return this.activeStore.getMessage(messageId);
  }

  getVisiblePathToMessage(messageId: string): MessageNode[] {
    return this.activeStore.getVisiblePathToMessage(messageId);
  }

  createNet(input: CreateNetInput): WorkspaceState {
    const createdAt = nowIso();
    const netId = makeNetId();
    const title = input.title.trim() || createDefaultNetTitle(createdAt);
    const databasePath = path.join(this.netsDirectory, `${netId}.db`);

    this.manifest.nets.push({
      id: netId,
      title,
      agentRuntimeId: input.agentRuntimeId ?? null,
      agentRuntimeKind: input.agentRuntimeKind ?? null,
      createdAt,
      lastOpenedAt: createdAt,
      databasePath,
    });
    this.manifest.activeNetId = netId;
    this.writeManifest();
    this.switchActiveStore(databasePath);

    return this.getWorkspaceState();
  }

  selectNet(netId: string): WorkspaceState {
    const net = this.findNetRecord(netId);
    if (!net) {
      throw new Error("The requested net does not exist in this workspace.");
    }

    const selectedAt = nowIso();
    net.lastOpenedAt = selectedAt;
    this.manifest.activeNetId = net.id;
    this.writeManifest();
    this.switchActiveStore(net.databasePath);

    return this.getWorkspaceState();
  }

  updateNet(netId: string, input: UpdateNetInput): WorkspaceState {
    const net = this.findNetRecord(netId);
    if (!net) {
      throw new Error("The requested net does not exist in this workspace.");
    }

    if (typeof input.title === "string") {
      net.title = input.title.trim();
    }

    if (typeof input.agentRuntimeId === "string" && input.agentRuntimeKind) {
      const canUpdateAgent = !this.netHasMessages(net) || net.agentRuntimeId === null;
      if (!canUpdateAgent) {
        throw new Error("This net already has messages, so its agent can no longer be changed.");
      }

      net.agentRuntimeId = input.agentRuntimeId;
      net.agentRuntimeKind = input.agentRuntimeKind;
    }

    this.writeManifest();

    return this.getWorkspaceState();
  }

  deleteNet(netId: string): WorkspaceState {
    const net = this.findNetRecord(netId);
    if (!net) {
      throw new Error("The requested net does not exist in this workspace.");
    }

    if (this.manifest.nets.length === 1) {
      this.manifest.nets.push(this.createRecoveredNetRecord());
    }

    const removingActiveNet = this.manifest.activeNetId === netId;
    const replacementNet = removingActiveNet ? this.pickReplacementNetRecord(netId) : null;

    if (removingActiveNet && !replacementNet) {
      throw new Error("A replacement net could not be found for the current workspace.");
    }

    this.manifest.nets = this.manifest.nets.filter((candidate) => candidate.id !== netId);

    if (replacementNet) {
      this.manifest.activeNetId = replacementNet.id;
    }

    this.writeManifest();

    if (replacementNet) {
      this.switchActiveStore(replacementNet.databasePath);
    }

    this.deleteManagedNetDatabase(net.databasePath);

    return this.getWorkspaceState();
  }

  applyRootTurn(
    prompt: string,
    runtime: AgentTurnResult,
    options?: {
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
      selectedText?: string | null;
    },
  ): GraphSnapshot {
    const shouldRetitle = this.activeStore.getSnapshot().messages.length === 0;
    const nextSnapshot = this.activeStore.applyRootTurn(prompt, runtime, options);
    this.touchActiveNet({
      promptToRetitle: shouldRetitle ? prompt : null,
      runtime,
    });
    return nextSnapshot;
  }

  applyBranchCreation(
    input: CreateBranchInput,
    runtime: AgentTurnResult,
    options?: {
      branchId?: string;
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
    },
  ): GraphSnapshot {
    const nextSnapshot = this.activeStore.applyBranchCreation(input, runtime, options);
    this.touchActiveNet({
      runtime,
    });
    return nextSnapshot;
  }

  applyBranchTurn(
    branchId: string,
    prompt: string,
    runtime: AgentTurnResult,
    options?: {
      userMessageId?: string;
      assistantMessageId?: string;
      assistantState?: AssistantStreamState;
      selectedText?: string | null;
    },
  ): GraphSnapshot {
    const nextSnapshot = this.activeStore.applyBranchTurn(branchId, prompt, runtime, options);
    this.touchActiveNet({
      runtime,
    });
    return nextSnapshot;
  }

  saveAssistantState(messageId: string, state: AssistantStreamState) {
    this.activeStore.saveAssistantState(messageId, state);
  }

  private loadManifest(): WorkspaceManifest {
    const existing = this.readManifest();
    if (existing) {
      const repaired = this.repairManifest(existing);
      this.writeManifest(repaired);
      return repaired;
    }

    const createdAt = nowIso();
    const netId = makeNetId();
    const manifest: WorkspaceManifest = {
      version: 2,
      workspaceId: this.workspaceId,
      workingDirectory: this.workingDirectory,
      activeNetId: netId,
      nets: [
        {
          id: netId,
          title: createDefaultNetTitle(createdAt),
          agentRuntimeId: null,
          agentRuntimeKind: null,
          createdAt,
          lastOpenedAt: createdAt,
          databasePath: this.resolveInitialNetDatabasePath(netId),
        },
      ],
    };

    this.writeManifest(manifest);
    return manifest;
  }

  private readManifest(): WorkspaceManifest | null {
    if (!existsSync(this.manifestPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(this.manifestPath, "utf8")) as WorkspaceManifest;
    } catch {
      return null;
    }
  }

  private repairManifest(manifest: WorkspaceManifest): WorkspaceManifest {
    const manifestVersion = typeof manifest.version === "number" ? manifest.version : 1;
    const repairedNets = Array.isArray(manifest.nets)
      ? manifest.nets
          .map((candidate) => this.normalizeNetRecord(candidate, manifestVersion))
          .filter((candidate): candidate is WorkspaceNetRecord => candidate !== null)
      : [];
    const nets = repairedNets.length > 0 ? repairedNets : [this.createRecoveredNetRecord()];
    const activeNetId = nets.some((net) => net.id === manifest.activeNetId)
      ? manifest.activeNetId
      : nets[0].id;

    return {
      version: 2,
      workspaceId: this.workspaceId,
      workingDirectory: this.workingDirectory,
      activeNetId,
      nets,
    };
  }

  private normalizeNetRecord(candidate: unknown, manifestVersion: number): WorkspaceNetRecord | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const record = candidate as Partial<WorkspaceNetRecord>;
    const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
    if (!id) {
      return null;
    }

    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.trim().length > 0
        ? record.createdAt
        : nowIso();
    const title =
      typeof record.title === "string" && record.title.trim().length > 0
        ? record.title.trim()
        : createDefaultNetTitle(createdAt);
    const lastOpenedAt =
      typeof record.lastOpenedAt === "string" && record.lastOpenedAt.trim().length > 0
        ? record.lastOpenedAt
        : createdAt;
    const agentRuntimeId =
      typeof record.agentRuntimeId === "string" && record.agentRuntimeId.trim().length > 0
        ? record.agentRuntimeId.trim()
        : null;
    const agentRuntimeKind = isAgentRuntimeKind(record.agentRuntimeKind) ? record.agentRuntimeKind : null;
    const databasePath =
      typeof record.databasePath === "string" && record.databasePath.trim().length > 0
        ? path.resolve(record.databasePath)
        : path.join(this.netsDirectory, `${id}.db`);
    const shouldDefaultLegacyAgent =
      !agentRuntimeId &&
      !agentRuntimeKind &&
      (manifestVersion < 2 || readLatestMessageTimestamp(databasePath) !== null);
    const normalizedAgentRuntimeId = shouldDefaultLegacyAgent ? "claude_local" : agentRuntimeId;
    const normalizedAgentRuntimeKind = shouldDefaultLegacyAgent ? "claude" : agentRuntimeKind;

    return {
      id,
      title,
      agentRuntimeId:
        normalizedAgentRuntimeId && normalizedAgentRuntimeKind ? normalizedAgentRuntimeId : null,
      agentRuntimeKind:
        normalizedAgentRuntimeId && normalizedAgentRuntimeKind ? normalizedAgentRuntimeKind : null,
      createdAt,
      lastOpenedAt,
      databasePath,
    };
  }

  private createRecoveredNetRecord(): WorkspaceNetRecord {
    const createdAt = nowIso();
    const netId = makeNetId();
    return {
      id: netId,
      title: createDefaultNetTitle(createdAt),
      agentRuntimeId: null,
      agentRuntimeKind: null,
      createdAt,
      lastOpenedAt: createdAt,
      databasePath: this.resolveInitialNetDatabasePath(netId),
    };
  }

  private ensureLaunchNet(manifest: WorkspaceManifest) {
    const launchNet = this.pickLaunchNetRecord(manifest);
    if (!launchNet) {
      return manifest;
    }

    if (launchNet.id === manifest.activeNetId) {
      return manifest;
    }

    const selectedAt = nowIso();
    const nextManifest: WorkspaceManifest = {
      ...manifest,
      activeNetId: launchNet.id,
      nets: manifest.nets.map((net) =>
        net.id === launchNet.id
          ? {
              ...net,
              lastOpenedAt: selectedAt,
            }
          : net,
      ),
    };
    this.writeManifest(nextManifest);
    return nextManifest;
  }

  private pickLaunchNetRecord(manifest: WorkspaceManifest) {
    const activeNet = manifest.nets.find((net) => net.id === manifest.activeNetId) ?? null;
    const candidates = manifest.nets.map((net) => ({
      record: net,
      latestUserMessageAt: readLatestUserMessageTimestamp(net.databasePath),
      latestMessageAt: readLatestMessageTimestamp(net.databasePath),
    }));
    const mostRecentUserNet = [...candidates]
      .filter((candidate) => candidate.latestUserMessageAt)
      .sort((left, right) =>
        compareIsoTimestamps(
          right.latestUserMessageAt ?? right.record.createdAt,
          left.latestUserMessageAt ?? left.record.createdAt,
        ) || compareIsoTimestamps(right.record.createdAt, left.record.createdAt),
      )[0]?.record;

    if (mostRecentUserNet) {
      return mostRecentUserNet;
    }

    if (activeNet && !this.netHasMessages(activeNet)) {
      return activeNet;
    }

    const mostRecentMessageNet = [...candidates]
      .filter((candidate) => candidate.latestMessageAt)
      .sort((left, right) =>
        compareNetSummaryActivity(
          {
            ...this.toWorkspaceNetSummary(left.record),
            latestMessageAt: left.latestMessageAt,
          },
          {
            ...this.toWorkspaceNetSummary(right.record),
            latestMessageAt: right.latestMessageAt,
          },
        ),
      )[0]?.record;

    return mostRecentMessageNet ?? activeNet ?? manifest.nets[0] ?? null;
  }

  private netHasMessages(net: WorkspaceNetRecord) {
    return readLatestMessageTimestamp(net.databasePath) !== null;
  }

  private resolveInitialNetDatabasePath(netId: string) {
    if (this.configuredInitialDatabasePath) {
      return this.configuredInitialDatabasePath;
    }

    return path.join(this.netsDirectory, `${netId}.db`);
  }

  private findNetRecord(netId: string) {
    return this.manifest.nets.find((net) => net.id === netId) ?? null;
  }

  private buildNetSummary(net: WorkspaceNetRecord): WorkspaceNetSummary {
    return {
      id: net.id,
      title: net.title,
      agentRuntimeId: net.agentRuntimeId,
      agentRuntimeKind: net.agentRuntimeKind,
      agentRuntimeLabel: net.agentRuntimeKind ? resolveAgentRuntimeLabel(net.agentRuntimeKind) : null,
      createdAt: net.createdAt,
      lastOpenedAt: net.lastOpenedAt,
      latestMessageAt: readLatestMessageTimestamp(net.databasePath),
    };
  }

  private pickReplacementNetRecord(netId: string) {
    const candidates = this.manifest.nets
      .filter((net) => net.id !== netId)
      .map((net) => ({
        record: net,
        latestMessageAt: readLatestMessageTimestamp(net.databasePath),
      }))
      .sort((left, right) =>
        compareNetSummaryActivity(
          {
            ...this.toWorkspaceNetSummary(left.record),
            latestMessageAt: left.latestMessageAt,
          },
          {
            ...this.toWorkspaceNetSummary(right.record),
            latestMessageAt: right.latestMessageAt,
          },
        ),
      );

    return candidates[0]?.record ?? null;
  }

  private getActiveNetRecord() {
    const activeNet = this.findNetRecord(this.manifest.activeNetId);
    if (activeNet) {
      return activeNet;
    }

    const fallback = this.manifest.nets[0];
    if (!fallback) {
      throw new Error("No nets are available for the current workspace.");
    }

    this.manifest.activeNetId = fallback.id;
    this.writeManifest();
    return fallback;
  }

  private touchActiveNet(input?: {
    promptToRetitle?: string | null;
    runtime?: Pick<AgentTurnResult, "runtimeId" | "runtimeKind">;
  }) {
    const activeNet = this.getActiveNetRecord();
    activeNet.lastOpenedAt = nowIso();
    if (!activeNet.agentRuntimeId && input?.runtime) {
      activeNet.agentRuntimeId = input.runtime.runtimeId;
      activeNet.agentRuntimeKind = input.runtime.runtimeKind;
    }
    if (input?.promptToRetitle && isDefaultNetTitle(activeNet.title)) {
      activeNet.title = deriveNetTitleFromPrompt(input.promptToRetitle);
    }
    this.writeManifest();
  }

  private writeManifest(nextManifest = this.manifest) {
    this.manifest = nextManifest;
    writeFileSync(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
  }

  private switchActiveStore(databasePath: string) {
    const resolvedPath = path.resolve(databasePath);
    if (this.activeStore.getDatabasePath() === resolvedPath) {
      return;
    }

    const previousStore = this.activeStore;
    this.activeStore = new GraphStore(resolvedPath);
    previousStore.dispose();
  }

  private deleteManagedNetDatabase(databasePath: string) {
    if (!isManagedWorkspaceNetPath(databasePath, this.netsDirectory)) {
      return;
    }

    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
  }

  private toWorkspaceNetSummary(net: WorkspaceNetRecord) {
    return {
      id: net.id,
      title: net.title,
      agentRuntimeId: net.agentRuntimeId,
      agentRuntimeKind: net.agentRuntimeKind,
      agentRuntimeLabel: net.agentRuntimeKind ? resolveAgentRuntimeLabel(net.agentRuntimeKind) : null,
      createdAt: net.createdAt,
      lastOpenedAt: net.lastOpenedAt,
    };
  }
}

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return value === "claude" || value === "codex" || value === "droid" || value === "opencode" || value === "mock";
}

export function resolveWorkspaceWorkingDirectory() {
  const configuredPath =
    process.env.NETCHAT_RUNTIME_CWD?.trim() ||
    process.env.NETCHAT_WORKSPACE_DIR?.trim() ||
    process.env.NETCHAT_LAUNCH_CWD?.trim() ||
    process.env.CLAUDE_PROJECT_CWD?.trim();

  return normalizeWorkingDirectory(configuredPath || process.cwd());
}

export function resolveWorkspaceDataDirectory(workingDirectory: string) {
  return path.join(resolveWorkspaceRegistryRootDirectory(), createWorkspaceStorageKey(workingDirectory));
}

function resolveConfiguredInitialDatabasePath() {
  const configuredPath = process.env.NETCHAT_APP_DB_PATH?.trim();
  return configuredPath ? path.resolve(configuredPath) : null;
}

export function resolveWorkspaceRegistryRootDirectory() {
  const configuredRoot = process.env.NETCHAT_WORKSPACES_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const configuredAppDataDirectory = process.env.NETCHAT_APP_DATA_DIR?.trim();
  if (configuredAppDataDirectory) {
    const resolvedAppDataDirectory = path.resolve(configuredAppDataDirectory);
    if (
      existsSync(path.join(resolvedAppDataDirectory, "workspace.json")) ||
      isHashedWorkspaceDirectory(resolvedAppDataDirectory)
    ) {
      return path.dirname(resolvedAppDataDirectory);
    }

    return resolvedAppDataDirectory;
  }

  return path.join(os.homedir(), ".netchat", "workspaces");
}

export function normalizeWorkingDirectory(value: string) {
  return path.resolve(value).replace(/\\/g, "/");
}

export function createWorkspaceStorageKey(workingDirectory: string) {
  const normalized =
    process.platform === "win32" ? workingDirectory.toLowerCase() : workingDirectory;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function makeNetId() {
  return `net_${crypto.randomUUID().slice(0, 8)}`;
}

function createDefaultNetTitle(value: string) {
  return `Untitled net · ${formatNetTimestamp(value)}`;
}

function deriveNetTitleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled net";
  }

  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 61).trimEnd()}...`;
}

function isDefaultNetTitle(value: string) {
  return value.startsWith("Untitled net");
}

function formatNetTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "now";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function compareNetSummaryActivity(left: WorkspaceNetSummary, right: WorkspaceNetSummary) {
  const activityDelta = compareIsoTimestamps(
    right.latestMessageAt ?? right.createdAt,
    left.latestMessageAt ?? left.createdAt,
  );
  if (activityDelta !== 0) {
    return activityDelta;
  }

  const creationDelta = compareIsoTimestamps(right.createdAt, left.createdAt);
  if (creationDelta !== 0) {
    return creationDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareIsoTimestamps(left: string, right: string) {
  return left.localeCompare(right);
}

function isManagedWorkspaceNetPath(databasePath: string, netsDirectory: string) {
  const normalizedDatabasePath = normalizeComparablePath(databasePath);
  const normalizedNetsDirectory = `${normalizeComparablePath(netsDirectory)}${path.sep}`;
  return normalizedDatabasePath.startsWith(normalizedNetsDirectory);
}

function normalizeComparablePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isHashedWorkspaceDirectory(value: string) {
  const parentDirectoryName = path.basename(path.dirname(value));
  const directoryName = path.basename(value);
  return parentDirectoryName === "workspaces" && /^[0-9a-f]{16}$/i.test(directoryName);
}
