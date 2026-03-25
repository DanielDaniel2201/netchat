import { z } from "zod";

export type Role = "user" | "assistant";

export type Branch = {
  id: string;
  parentBranchId: string | null;
  sourceMessageId: string | null;
  sessionId: string | null;
  machineId: string | null;
  title: string;
  selectedText: string | null;
  startOffset: number | null;
  endOffset: number | null;
  createdAt: string;
};

export type MessageNode = {
  id: string;
  branchId: string;
  role: Role;
  content: string;
  sessionId: string | null;
  machineId: string | null;
  createdAt: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "fork" | "message";
};

export type GraphSnapshot = {
  branches: Branch[];
  messages: MessageNode[];
  edges: GraphEdge[];
};

export type HostPlatform = "windows" | "macos" | "linux" | "unknown";

export type RuntimeEnvironment = {
  platform: HostPlatform;
  arch: string;
  claudeInstalled: boolean;
  claudeVersion: string | null;
  claudePath: string | null;
  workingDirectory: string;
  runtimeMode: "mock" | "claude";
  detectionError: string | null;
};

export type DaemonLogLevel = "info" | "warn" | "error";

export type DaemonLogEntry = {
  id: string;
  level: DaemonLogLevel;
  message: string;
  timestamp: string;
};

export type DaemonStatus =
  | "starting"
  | "local_only"
  | "waiting_for_pairing"
  | "registering"
  | "registered"
  | "online"
  | "error";

export type DaemonDiagnostics = {
  startedAt: string;
  status: DaemonStatus;
  localMode: boolean;
  environment: RuntimeEnvironment;
  serverUrl: string | null;
  pairingCodeConfigured: boolean;
  machineName: string | null;
  machineId: string | null;
  machineStatePath: string | null;
  lastServerContactAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  logs: DaemonLogEntry[];
};

export type ServerDiagnostics = {
  startedAt: string;
  jobTimeoutMs: number;
  onlineThresholdMs: number;
  pollingIntervalMs: number;
  machineCount: number;
  onlineMachineCount: number;
  pendingJobCount: number;
  inFlightJobCount: number;
  lastError: string | null;
  logs: DaemonLogEntry[];
};

export type MachineStatus = "online" | "offline";

export type MachineRecord = {
  id: string;
  name: string;
  status: MachineStatus;
  registeredAt: string;
  lastSeenAt: string;
  environment: RuntimeEnvironment;
};

export const createPairingSessionInputSchema = z.object({
  label: z.string().trim().max(120).default(""),
});

export type CreatePairingSessionInput = z.infer<typeof createPairingSessionInputSchema>;

export type PairingSession = {
  pairingCode: string;
  expiresAt: string;
};

export const createMachineRegisterInputSchema = z.object({
  pairingCode: z.string().trim().min(1).max(32),
  machineName: z.string().trim().min(1).max(120),
  environment: z.custom<RuntimeEnvironment>(),
});

export type CreateMachineRegisterInput = z.infer<typeof createMachineRegisterInputSchema>;

export type MachineRegistration = {
  machineId: string;
  machineSecret: string;
  pollingIntervalMs: number;
};

export const createMachineHeartbeatInputSchema = z.object({
  machineId: z.string().min(1),
  machineSecret: z.string().min(1),
  environment: z.custom<RuntimeEnvironment>(),
});

export type CreateMachineHeartbeatInput = z.infer<typeof createMachineHeartbeatInputSchema>;

export const createMachineClaimJobInputSchema = z.object({
  machineId: z.string().min(1),
  machineSecret: z.string().min(1),
});

export type CreateMachineClaimJobInput = z.infer<typeof createMachineClaimJobInputSchema>;

export const completeMachineJobInputSchema = z.object({
  machineId: z.string().min(1),
  machineSecret: z.string().min(1),
  success: z.boolean(),
  response: z.custom<RuntimeResponse>().optional(),
  error: z.string().trim().optional(),
});

export type CompleteMachineJobInput = z.infer<typeof completeMachineJobInputSchema>;

export type MachineJob =
  | {
      id: string;
      kind: "root-turn";
      payload: RootTurnRuntimeRequest;
      createdAt: string;
    }
  | {
      id: string;
      kind: "fork-branch";
      payload: ForkBranchRuntimeRequest;
      createdAt: string;
    }
  | {
      id: string;
      kind: "branch-turn";
      payload: ContinueBranchRuntimeRequest;
      createdAt: string;
    };

export const rootBranchId = "branch_root";

export const createRootTurnInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  machineId: z.string().trim().min(1).optional(),
});

export type CreateRootTurnInput = z.infer<typeof createRootTurnInputSchema>;

export const createBranchInputSchema = z.object({
  sourceMessageId: z.string().min(1),
  selectedText: z.string().trim().min(1).max(1000),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  prompt: z.string().trim().max(4000).default(""),
});

export type CreateBranchInput = z.infer<typeof createBranchInputSchema>;

export const createBranchTurnInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

export type CreateBranchTurnInput = z.infer<typeof createBranchTurnInputSchema>;

export type RootTurnRuntimeRequest = {
  prompt: string;
  sessionId: string | null;
};

export type ForkBranchRuntimeRequest = {
  sourceSessionId: string;
  selectedText: string;
  prompt: string;
};

export type ContinueBranchRuntimeRequest = {
  sessionId: string;
  prompt: string;
};

export type RuntimeResponse = {
  sessionId: string;
  assistantMessage: string;
  machineId: string;
};

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildForkPrompt(selectedText: string, userPrompt: string): string {
  const suffix =
    userPrompt.trim().length > 0
      ? `\n\nUser follow-up:\n${userPrompt.trim()}`
      : "\n\nUser follow-up:\nContinue by explaining this selection more deeply.";

  return [
    "The user selected part of your previous answer and wants to fork the conversation from that exact context.",
    `Selected text: "${selectedText}"`,
    "Stay grounded in the original reply's context and keep the next answer focused on the selected text unless the user broadens the scope.",
    suffix,
  ].join("\n");
}

export function buildGraphEdges(snapshot: Pick<GraphSnapshot, "branches" | "messages">): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const messagesByBranch = new Map<string, MessageNode[]>();

  for (const message of snapshot.messages) {
    const messages = messagesByBranch.get(message.branchId) ?? [];
    messages.push(message);
    messagesByBranch.set(message.branchId, messages);
  }

  for (const branch of snapshot.branches) {
    const messages = messagesByBranch.get(branch.id) ?? [];
    for (let index = 0; index < messages.length; index += 1) {
      if (index === 0) {
        if (branch.sourceMessageId) {
          edges.push({
            id: `edge_fork_${branch.sourceMessageId}_${messages[index].id}`,
            source: branch.sourceMessageId,
            target: messages[index].id,
            kind: "fork",
          });
        }
        continue;
      }

      edges.push({
        id: `edge_message_${messages[index - 1].id}_${messages[index].id}`,
        source: messages[index - 1].id,
        target: messages[index].id,
        kind: "message",
      });
    }
  }

  return edges;
}
