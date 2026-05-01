import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import {
  AgentTurnResult,
  AssistantStreamState,
  Branch,
  CreateBranchInput,
  CreateNetInput,
  GraphSnapshot,
  MachineWorkspacesState,
  MessageNode,
  OpenWorkspaceInput,
  UpdateNetInput,
  WorkspaceDirectoryListing,
  WorkspaceBrowserSummary,
  WorkspaceExplorerEntry,
  WorkspaceFileContent,
  WorkspaceNetSummary,
  WorkspaceState,
  nowIso,
  resolveAgentRuntimeLabel,
} from "@netchat/shared";

import { readLatestMessageTimestamp } from "./store.js";
import {
  compareNetSummaryActivity,
  createWorkspaceStorageKey,
  isAgentRuntimeKind,
  normalizeWorkingDirectory,
  resolveWorkspaceDataDirectory,
  resolveWorkspaceRegistryRootDirectory,
  resolveWorkspaceWorkingDirectory,
  WorkspaceStore,
} from "./workspace-store.js";
import { canPickWorkspaceFolder } from "./workspace-picker.js";
import { convertPdfToMarkdownWithMineru } from "./mineru.js";

type WorkspaceManifestSnapshot = {
  version?: unknown;
  workspaceId?: unknown;
  workingDirectory?: unknown;
  activeNetId?: unknown;
  nets?: unknown;
};

type WorkspaceNetRecordSnapshot = {
  id?: unknown;
  title?: unknown;
  agentRuntimeId?: unknown;
  agentRuntimeKind?: unknown;
  createdAt?: unknown;
  lastOpenedAt?: unknown;
  databasePath?: unknown;
};

const workspaceFilePreviewByteLimit = 256 * 1024;

export class WorkspaceManagerStore {
  private activeStore: WorkspaceStore;

  constructor() {
    mkdirSync(resolveWorkspaceRegistryRootDirectory(), { recursive: true });
    this.activeStore = new WorkspaceStore({
      workingDirectory: resolveWorkspaceWorkingDirectory(),
      ensureLaunchNet: true,
      useConfiguredInitialDatabasePath: true,
    });
  }

  getWorkspaceState(): WorkspaceState {
    return this.activeStore.getWorkspaceState();
  }

  getWorkspacesState(): MachineWorkspacesState {
    const activeWorkspaceId = this.getWorkspaceState().workspaceId;
    return {
      activeWorkspaceId,
      workspaces: this.listWorkspaceSummaries(),
      canPickWorkspaceFolder: canPickWorkspaceFolder(),
    };
  }

  getSnapshot(): GraphSnapshot {
    return this.activeStore.getSnapshot();
  }

  getWorkspaceDirectoryListing(directoryPath: string): WorkspaceDirectoryListing {
    const workspaceRootPath = this.activeStore.getWorkspaceState().workingDirectory;
    const resolvedTarget = resolveWorkspaceTargetPath(workspaceRootPath, directoryPath);
    const targetStats = statSync(resolvedTarget.absolutePath);
    if (!targetStats.isDirectory()) {
      throw new Error("The requested workspace path is not a directory.");
    }

    const entries: WorkspaceExplorerEntry[] = [];
    for (const entry of readdirSync(resolvedTarget.absolutePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryKind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
      if (!entryKind) {
        continue;
      }

      const entryPath = resolvedTarget.relativePath ? `${resolvedTarget.relativePath}/${entry.name}` : entry.name;
      entries.push({
        path: entryPath,
        name: entry.name,
        kind: entryKind,
      });
    }

    entries.sort(compareWorkspaceExplorerEntries);

    return {
      directoryPath: resolvedTarget.relativePath,
      entries,
    };
  }

  getWorkspaceFileContent(filePath: string): WorkspaceFileContent {
    const workspaceRootPath = this.activeStore.getWorkspaceState().workingDirectory;
    const resolvedTarget = resolveWorkspaceTargetPath(workspaceRootPath, filePath);
    const targetStats = statSync(resolvedTarget.absolutePath);
    if (!targetStats.isFile()) {
      throw new Error("The requested workspace path is not a file.");
    }

    const previewBuffer = readWorkspaceFilePreview(resolvedTarget.absolutePath, targetStats.size);
    const isBinary = isProbablyBinaryContent(previewBuffer);

    return {
      path: resolvedTarget.relativePath,
      name: resolvedTarget.relativePath ? path.basename(resolvedTarget.relativePath) : path.basename(resolvedTarget.absolutePath),
      size: targetStats.size,
      isBinary,
      truncated: targetStats.size > workspaceFilePreviewByteLimit,
      content: isBinary ? "" : previewBuffer.toString("utf8"),
    };
  }

  async convertWorkspacePdfToMarkdown(filePath: string, token: string) {
    const workspaceRootPath = this.activeStore.getWorkspaceState().workingDirectory;
    const resolvedTarget = resolveWorkspaceTargetPath(workspaceRootPath, filePath);
    const targetStats = statSync(resolvedTarget.absolutePath);
    if (!targetStats.isFile()) {
      throw new Error("The requested workspace path is not a file.");
    }

    if (path.extname(resolvedTarget.absolutePath).toLowerCase() !== ".pdf") {
      throw new Error("Only PDF files can be parsed through MinerU.");
    }

    const result = await convertPdfToMarkdownWithMineru({
      filePath: resolvedTarget.absolutePath,
      token,
    });
    const markdownAbsolutePath = path.resolve(result.markdownFilePath);

    if (!isWorkspaceDescendantPath(path.resolve(workspaceRootPath), markdownAbsolutePath)) {
      throw new Error("The generated markdown path is outside the active workspace.");
    }

    return {
      sourcePdfPath: resolvedTarget.relativePath,
      markdownFilePath: normalizeWorkspaceRelativePath(path.relative(workspaceRootPath, markdownAbsolutePath)),
    };
  }

  getActiveNetSummary() {
    return this.activeStore.getActiveNetSummary();
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
    return this.activeStore.createNet(input);
  }

  selectNet(netId: string): WorkspaceState {
    return this.activeStore.selectNet(netId);
  }

  selectWorkspace(workspaceId: string): WorkspaceState {
    this.ensureActiveWorkspace(workspaceId);
    return this.activeStore.selectNet(this.activeStore.getWorkspaceState().activeNetId);
  }

  selectWorkspaceNet(workspaceId: string, netId: string): WorkspaceState {
    this.ensureActiveWorkspace(workspaceId);
    return this.activeStore.selectNet(netId);
  }

  openWorkspace(input: OpenWorkspaceInput | string): WorkspaceState {
    const rawWorkingDirectory = typeof input === "string" ? input : input.workingDirectory;
    const workingDirectory = normalizeWorkingDirectory(rawWorkingDirectory);
    this.assertOpenableWorkspaceDirectory(workingDirectory);

    if (this.getWorkspaceState().workspaceId !== createWorkspaceStorageKey(workingDirectory)) {
      this.switchActiveStore(
        new WorkspaceStore({
          workingDirectory,
          ensureLaunchNet: false,
          useConfiguredInitialDatabasePath: false,
        }),
      );
    }

    return this.activeStore.selectNet(this.activeStore.getWorkspaceState().activeNetId);
  }

  updateNet(netId: string, input: UpdateNetInput): WorkspaceState {
    return this.activeStore.updateNet(netId, input);
  }

  deleteNet(netId: string): WorkspaceState {
    return this.activeStore.deleteNet(netId);
  }

  deleteWorkspace(workspaceId: string): WorkspaceState {
    const targetWorkspace = this.listWorkspaceSummaries().find((candidate) => candidate.workspaceId === workspaceId) ?? null;
    if (!targetWorkspace) {
      throw new Error("The requested workspace does not exist.");
    }

    const remainingWorkspaces = this.listWorkspaceSummaries().filter((candidate) => candidate.workspaceId !== workspaceId);
    if (remainingWorkspaces.length === 0) {
      throw new Error("The last remaining workspace cannot be deleted.");
    }

    const deletingActiveWorkspace = this.getWorkspaceState().workspaceId === workspaceId;
    if (deletingActiveWorkspace) {
      const replacementWorkspace = remainingWorkspaces[0];
      this.switchActiveStore(
        new WorkspaceStore({
          workingDirectory: replacementWorkspace.workingDirectory,
          ensureLaunchNet: false,
          useConfiguredInitialDatabasePath: false,
        }),
      );
    }

    const workspaceDataDirectory = resolveWorkspaceDataDirectory(targetWorkspace.workingDirectory);
    rmSync(workspaceDataDirectory, { force: true, recursive: true });

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
    return this.activeStore.applyRootTurn(prompt, runtime, options);
  }

  seedRootArticle(content: string, sourcePath: string): GraphSnapshot {
    return this.activeStore.seedRootArticle(sourcePath, content);
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
    return this.activeStore.applyBranchCreation(input, runtime, options);
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
    return this.activeStore.applyBranchTurn(branchId, prompt, runtime, options);
  }

  saveAssistantState(messageId: string, state: AssistantStreamState) {
    this.activeStore.saveAssistantState(messageId, state);
  }

  private ensureActiveWorkspace(workspaceId: string) {
    if (this.getWorkspaceState().workspaceId === workspaceId) {
      return;
    }

    const nextWorkspace = this.listWorkspaceSummaries().find((candidate) => candidate.workspaceId === workspaceId) ?? null;
    if (!nextWorkspace) {
      throw new Error("The requested workspace does not exist.");
    }

    this.switchActiveStore(
      new WorkspaceStore({
        workingDirectory: nextWorkspace.workingDirectory,
        ensureLaunchNet: false,
        useConfiguredInitialDatabasePath: false,
      }),
    );
  }

  private switchActiveStore(nextStore: WorkspaceStore) {
    const previousStore = this.activeStore;
    this.activeStore = nextStore;
    previousStore.dispose();
  }

  private listWorkspaceSummaries() {
    const workspaceRoot = resolveWorkspaceRegistryRootDirectory();
    const summariesById = new Map<string, WorkspaceBrowserSummary>();

    if (existsSync(workspaceRoot)) {
      for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const summary = readWorkspaceBrowserSummary(path.join(workspaceRoot, entry.name));
        if (summary) {
          summariesById.set(summary.workspaceId, summary);
        }
      }
    }

    const activeSummary = buildWorkspaceBrowserSummaryFromState(this.getWorkspaceState());
    summariesById.set(activeSummary.workspaceId, activeSummary);

    return Array.from(summariesById.values()).sort(compareWorkspaceBrowserSummary);
  }

  private assertOpenableWorkspaceDirectory(workingDirectory: string) {
    if (!existsSync(workingDirectory)) {
      throw new Error("The selected folder does not exist.");
    }

    if (!statSync(workingDirectory).isDirectory()) {
      throw new Error("The selected path is not a folder.");
    }
  }
}

function readWorkspaceBrowserSummary(workspaceDirectory: string): WorkspaceBrowserSummary | null {
  const manifestPath = path.join(workspaceDirectory, "workspace.json");
  if (!existsSync(manifestPath)) {
    return null;
  }

  let manifest: WorkspaceManifestSnapshot;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkspaceManifestSnapshot;
  } catch {
    return null;
  }

  const workingDirectoryValue =
    typeof manifest.workingDirectory === "string" && manifest.workingDirectory.trim().length > 0
      ? normalizeWorkingDirectory(manifest.workingDirectory)
      : null;
  if (!workingDirectoryValue) {
    return null;
  }

  const netsDirectory = path.join(workspaceDirectory, "nets");
  const manifestVersion = typeof manifest.version === "number" ? manifest.version : 1;
  const netSummaries = Array.isArray(manifest.nets)
    ? manifest.nets
        .map((candidate) => normalizeWorkspaceNetSummary(candidate, manifestVersion, netsDirectory))
        .filter((candidate): candidate is WorkspaceNetSummary => candidate !== null)
        .sort(compareNetSummaryActivity)
    : [];
  if (netSummaries.length === 0) {
    return null;
  }

  const activeNetId =
    typeof manifest.activeNetId === "string" && netSummaries.some((net) => net.id === manifest.activeNetId)
      ? manifest.activeNetId
      : netSummaries[0].id;

  return {
    workspaceId: createWorkspaceStorageKey(workingDirectoryValue),
    workingDirectory: workingDirectoryValue,
    activeNetId,
    createdAt: netSummaries.reduce(
      (earliest, net) => (net.createdAt.localeCompare(earliest) < 0 ? net.createdAt : earliest),
      netSummaries[0].createdAt,
    ),
    nets: netSummaries,
    latestMessageAt: netSummaries.reduce<string | null>(
      (latest, net) =>
        !latest || (net.latestMessageAt && net.latestMessageAt.localeCompare(latest) > 0)
          ? (net.latestMessageAt ?? latest)
          : latest,
      null,
    ),
    lastOpenedAt: netSummaries.reduce((latest, net) => (net.lastOpenedAt.localeCompare(latest) > 0 ? net.lastOpenedAt : latest), netSummaries[0].lastOpenedAt),
  };
}

function normalizeWorkspaceNetSummary(
  candidate: unknown,
  manifestVersion: number,
  netsDirectory: string,
): WorkspaceNetSummary | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as WorkspaceNetRecordSnapshot;
  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
  if (!id) {
    return null;
  }

  const createdAt =
    typeof record.createdAt === "string" && record.createdAt.trim().length > 0 ? record.createdAt : nowIso();
  const lastOpenedAt =
    typeof record.lastOpenedAt === "string" && record.lastOpenedAt.trim().length > 0
      ? record.lastOpenedAt
      : createdAt;
  const title =
    typeof record.title === "string" && record.title.trim().length > 0
      ? record.title.trim()
      : createFallbackNetTitle(createdAt);
  const databasePath =
    typeof record.databasePath === "string" && record.databasePath.trim().length > 0
      ? path.resolve(record.databasePath)
      : path.join(netsDirectory, `${id}.db`);
  const latestMessageAt = readLatestMessageTimestamp(databasePath);
  const agentRuntimeId =
    typeof record.agentRuntimeId === "string" && record.agentRuntimeId.trim().length > 0
      ? record.agentRuntimeId.trim()
      : null;
  const agentRuntimeKind = isAgentRuntimeKind(record.agentRuntimeKind) ? record.agentRuntimeKind : null;
  const shouldDefaultLegacyAgent =
    !agentRuntimeId &&
    !agentRuntimeKind &&
    (manifestVersion < 2 || latestMessageAt !== null);
  const normalizedAgentRuntimeId = shouldDefaultLegacyAgent ? "claude_local" : agentRuntimeId;
  const normalizedAgentRuntimeKind = shouldDefaultLegacyAgent ? "claude" : agentRuntimeKind;

  return {
    id,
    title,
    agentRuntimeId:
      normalizedAgentRuntimeId && normalizedAgentRuntimeKind ? normalizedAgentRuntimeId : null,
    agentRuntimeKind:
      normalizedAgentRuntimeId && normalizedAgentRuntimeKind ? normalizedAgentRuntimeKind : null,
    agentRuntimeLabel:
      normalizedAgentRuntimeId && normalizedAgentRuntimeKind
        ? resolveAgentRuntimeLabel(normalizedAgentRuntimeKind)
        : null,
    createdAt,
    lastOpenedAt,
    latestMessageAt,
  };
}

function buildWorkspaceBrowserSummaryFromState(state: WorkspaceState): WorkspaceBrowserSummary {
  return {
    workspaceId: state.workspaceId,
    workingDirectory: state.workingDirectory,
    activeNetId: state.activeNetId,
    createdAt: state.nets.reduce(
      (earliest, net) => (net.createdAt.localeCompare(earliest) < 0 ? net.createdAt : earliest),
      state.nets[0]?.createdAt ?? nowIso(),
    ),
    nets: state.nets,
    latestMessageAt: state.nets.reduce<string | null>(
      (latest, net) =>
        !latest || (net.latestMessageAt && net.latestMessageAt.localeCompare(latest) > 0)
          ? (net.latestMessageAt ?? latest)
          : latest,
      null,
    ),
    lastOpenedAt: state.nets.reduce(
      (latest, net) => (net.lastOpenedAt.localeCompare(latest) > 0 ? net.lastOpenedAt : latest),
      state.nets[0]?.lastOpenedAt ?? nowIso(),
    ),
  };
}

function compareWorkspaceBrowserSummary(left: WorkspaceBrowserSummary, right: WorkspaceBrowserSummary) {
  const creationDelta = right.createdAt.localeCompare(left.createdAt);
  if (creationDelta !== 0) {
    return creationDelta;
  }

  return left.workingDirectory.localeCompare(right.workingDirectory);
}

function resolveWorkspaceTargetPath(workspaceRootPath: string, candidatePath: string) {
  const workspaceRootAbsolutePath = path.resolve(workspaceRootPath);
  const workspaceRootRealPath = realpathSync(workspaceRootAbsolutePath);
  const relativePath = normalizeWorkspaceRelativePath(candidatePath);
  const absolutePath = relativePath ? path.resolve(workspaceRootAbsolutePath, relativePath) : workspaceRootAbsolutePath;

  if (!isWorkspaceDescendantPath(workspaceRootAbsolutePath, absolutePath)) {
    throw new Error("The requested workspace path is outside the active workspace.");
  }

  const absoluteRealPath = realpathSync(absolutePath);
  if (!isWorkspaceDescendantPath(workspaceRootRealPath, absoluteRealPath)) {
    throw new Error("The requested workspace path is outside the active workspace.");
  }

  return {
    relativePath,
    absolutePath,
  };
}

function normalizeWorkspaceRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized === ".") {
    return "";
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("The requested workspace path is invalid.");
  }

  return segments.join("/");
}

function isWorkspaceDescendantPath(rootPath: string, targetPath: string) {
  const normalizedRootPath = normalizeComparablePath(rootPath);
  const normalizedTargetPath = normalizeComparablePath(targetPath);
  return normalizedTargetPath === normalizedRootPath || normalizedTargetPath.startsWith(`${normalizedRootPath}${path.sep}`);
}

function normalizeComparablePath(value: string) {
  const resolvedPath = path.resolve(value);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function compareWorkspaceExplorerEntries(left: WorkspaceExplorerEntry, right: WorkspaceExplorerEntry) {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function readWorkspaceFilePreview(filePath: string, fileSize: number) {
  const bytesToRead = Math.min(fileSize, workspaceFilePreviewByteLimit);
  const previewBuffer = Buffer.alloc(bytesToRead);
  const fileHandle = openSync(filePath, "r");

  try {
    if (bytesToRead > 0) {
      readSync(fileHandle, previewBuffer, 0, bytesToRead, 0);
    }
  } finally {
    closeSync(fileHandle);
  }

  return previewBuffer;
}

function isProbablyBinaryContent(buffer: Buffer) {
  if (buffer.length === 0) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspiciousByteCount = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }

    if ((byte >= 1 && byte <= 8) || (byte >= 14 && byte <= 31) || byte === 127) {
      suspiciousByteCount += 1;
    }
  }

  return suspiciousByteCount / sample.length > 0.1;
}

function createFallbackNetTitle(value: string) {
  return `Untitled net ${value}`;
}
