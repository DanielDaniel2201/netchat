import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Branch,
  CreateBranchInput,
  CreateNetInput,
  GraphSnapshot,
  MessageNode,
  RuntimeResponse,
  WorkspaceNetSummary,
  WorkspaceState,
  nowIso,
} from "@netchat/shared";

import { GraphStore } from "./store.js";

type WorkspaceNetRecord = WorkspaceNetSummary & {
  databasePath: string;
};

type WorkspaceManifest = {
  version: 1;
  workspaceId: string;
  workingDirectory: string;
  activeNetId: string;
  nets: WorkspaceNetRecord[];
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

  constructor() {
    this.workingDirectory = resolveWorkspaceWorkingDirectory();
    this.workspaceId = createWorkspaceStorageKey(this.workingDirectory);
    this.workspaceDataDirectory = resolveWorkspaceDataDirectory(this.workingDirectory);
    this.manifestPath = path.join(this.workspaceDataDirectory, "workspace.json");
    this.netsDirectory = path.join(this.workspaceDataDirectory, "nets");
    this.configuredInitialDatabasePath = resolveConfiguredInitialDatabasePath();

    mkdirSync(this.workspaceDataDirectory, { recursive: true });
    mkdirSync(this.netsDirectory, { recursive: true });

    this.manifest = this.loadManifest();
    this.activeStore = new GraphStore(this.getActiveNetRecord().databasePath);
  }

  getWorkspaceState(): WorkspaceState {
    return {
      workspaceId: this.manifest.workspaceId,
      workingDirectory: this.manifest.workingDirectory,
      activeNetId: this.manifest.activeNetId,
      nets: [...this.manifest.nets]
        .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
        .map(({ id, title, createdAt, lastOpenedAt }) => ({
          id,
          title,
          createdAt,
          lastOpenedAt,
        })),
    };
  }

  getSnapshot(): GraphSnapshot {
    return this.activeStore.getSnapshot();
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

  applyRootTurn(prompt: string, runtime: RuntimeResponse): GraphSnapshot {
    const shouldRetitle = this.activeStore.getSnapshot().messages.length === 0;
    const nextSnapshot = this.activeStore.applyRootTurn(prompt, runtime);
    this.touchActiveNet(shouldRetitle ? prompt : null);
    return nextSnapshot;
  }

  applyBranchCreation(input: CreateBranchInput, runtime: RuntimeResponse): GraphSnapshot {
    const nextSnapshot = this.activeStore.applyBranchCreation(input, runtime);
    this.touchActiveNet();
    return nextSnapshot;
  }

  applyBranchTurn(branchId: string, prompt: string, runtime: RuntimeResponse): GraphSnapshot {
    const nextSnapshot = this.activeStore.applyBranchTurn(branchId, prompt, runtime);
    this.touchActiveNet();
    return nextSnapshot;
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
      version: 1,
      workspaceId: this.workspaceId,
      workingDirectory: this.workingDirectory,
      activeNetId: netId,
      nets: [
        {
          id: netId,
          title: createDefaultNetTitle(createdAt),
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
    const repairedNets = Array.isArray(manifest.nets)
      ? manifest.nets
          .map((candidate) => this.normalizeNetRecord(candidate))
          .filter((candidate): candidate is WorkspaceNetRecord => candidate !== null)
      : [];
    const nets = repairedNets.length > 0 ? repairedNets : [this.createRecoveredNetRecord()];
    const activeNetId = nets.some((net) => net.id === manifest.activeNetId)
      ? manifest.activeNetId
      : nets[0].id;

    return {
      version: 1,
      workspaceId: this.workspaceId,
      workingDirectory: this.workingDirectory,
      activeNetId,
      nets,
    };
  }

  private normalizeNetRecord(candidate: unknown): WorkspaceNetRecord | null {
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
    const databasePath =
      typeof record.databasePath === "string" && record.databasePath.trim().length > 0
        ? path.resolve(record.databasePath)
        : path.join(this.netsDirectory, `${id}.db`);

    return {
      id,
      title,
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
      createdAt,
      lastOpenedAt: createdAt,
      databasePath: this.resolveInitialNetDatabasePath(netId),
    };
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

  private touchActiveNet(promptToRetitle?: string | null) {
    const activeNet = this.getActiveNetRecord();
    activeNet.lastOpenedAt = nowIso();
    if (promptToRetitle && isDefaultNetTitle(activeNet.title)) {
      activeNet.title = deriveNetTitleFromPrompt(promptToRetitle);
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
}

function resolveWorkspaceWorkingDirectory() {
  const configuredPath =
    process.env.NETCHAT_WORKSPACE_DIR?.trim() ||
    process.env.NETCHAT_LAUNCH_CWD?.trim() ||
    process.env.CLAUDE_PROJECT_CWD?.trim();

  return normalizeWorkingDirectory(configuredPath || process.cwd());
}

function resolveWorkspaceDataDirectory(workingDirectory: string) {
  const configuredPath = process.env.NETCHAT_APP_DATA_DIR?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(os.homedir(), ".netchat", "workspaces", createWorkspaceStorageKey(workingDirectory));
}

function resolveConfiguredInitialDatabasePath() {
  const configuredPath = process.env.NETCHAT_APP_DB_PATH?.trim();
  return configuredPath ? path.resolve(configuredPath) : null;
}

function normalizeWorkingDirectory(value: string) {
  return path.resolve(value).replace(/\\/g, "/");
}

function createWorkspaceStorageKey(workingDirectory: string) {
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
