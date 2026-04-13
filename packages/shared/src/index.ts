import { z } from "zod";

export type Role = "user" | "assistant" | "article";

export type Branch = {
  id: string;
  parentBranchId: string | null;
  sourceMessageId: string | null;
  sessionId: string | null;
  machineId: string | null;
  runtimeId: string | null;
  runtimeKind: AgentRuntimeKind | null;
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
  sourcePath: string | null;
  selectedText: string | null;
  sessionId: string | null;
  machineId: string | null;
  runtimeId: string | null;
  runtimeKind: AgentRuntimeKind | null;
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
  assistantStates: Record<string, AssistantStreamState>;
};

export type WorkspaceNetSummary = {
  id: string;
  title: string;
  agentRuntimeId: string | null;
  agentRuntimeKind: AgentRuntimeKind | null;
  agentRuntimeLabel: string | null;
  createdAt: string;
  lastOpenedAt: string;
  latestMessageAt: string | null;
};

export type WorkspaceState = {
  workspaceId: string;
  workingDirectory: string;
  activeNetId: string;
  nets: WorkspaceNetSummary[];
};

export type WorkspaceBrowserSummary = {
  workspaceId: string;
  workingDirectory: string;
  activeNetId: string;
  createdAt: string;
  nets: WorkspaceNetSummary[];
  latestMessageAt: string | null;
  lastOpenedAt: string | null;
};

export type MachineWorkspacesState = {
  activeWorkspaceId: string;
  workspaces: WorkspaceBrowserSummary[];
  canPickWorkspaceFolder: boolean;
};

export type PickWorkspaceFolderResult = {
  workingDirectory: string | null;
};

export type WorkspaceExplorerEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
};

export type WorkspaceDirectoryListing = {
  directoryPath: string;
  entries: WorkspaceExplorerEntry[];
};

export type WorkspaceFileContent = {
  path: string;
  name: string;
  size: number;
  isBinary: boolean;
  truncated: boolean;
  content: string;
};

export type UiConfig = {
  showSessionIds: boolean;
};

export type HostPlatform = "windows" | "macos" | "linux" | "unknown";

export type AgentRuntimeKind = "claude" | "codex" | "droid" | "opencode" | "mock";

export const agentRuntimeKindSchema = z.enum(["claude", "codex", "droid", "opencode", "mock"]);

export type AgentRuntimeDescriptor = {
  runtimeKind: AgentRuntimeKind;
  runtimeLabel: string;
  runtimeId: string;
};

export type AgentRuntimeEnvironment = {
  platform: HostPlatform;
  arch: string;
  runtimeId: string;
  runtimeKind: AgentRuntimeKind;
  runtimeLabel: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  workingDirectory: string;
  detectionError: string | null;
};

export type RuntimeEnvironment = AgentRuntimeEnvironment;

export type AgentRuntimeOption = {
  runtimeId: string;
  runtimeKind: AgentRuntimeKind;
  runtimeLabel: string;
  machineId: string | null;
  machineName: string | null;
  status: MachineStatus;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  workingDirectory: string;
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
  | "registering"
  | "registered"
  | "online"
  | "error";

export type DaemonDiagnostics = {
  startedAt: string;
  status: DaemonStatus;
  localMode: boolean;
  environment: AgentRuntimeEnvironment;
  serverUrl: string | null;
  machineName: string | null;
  machineId: string | null;
  lastServerContactAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  logs: DaemonLogEntry[];
};

export type ServerDiagnostics = {
  startedAt: string;
  jobTimeoutMs: number | null;
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
  environment: AgentRuntimeEnvironment;
};

export const createMachineRegisterInputSchema = z.object({
  machineName: z.string().trim().min(1).max(120),
  environment: z.custom<AgentRuntimeEnvironment>(),
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
  environment: z.custom<AgentRuntimeEnvironment>(),
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
  response: z.custom<AgentTurnResult>().optional(),
  error: z.string().trim().optional(),
});

export type CompleteMachineJobInput = z.infer<typeof completeMachineJobInputSchema>;

export type MachineJobKind = "root-turn" | "branch-create" | "branch-turn";

export type AgentTurnSession =
  | {
      mode: "new";
    }
  | {
      mode: "resume";
      handle: string;
    };

export type AgentTurnMetadata = {
  netchatOperation?: MachineJobKind;
  selectedText?: string | null;
};

export type AgentTurnInput = {
  prompt: string;
  session: AgentTurnSession;
  workingDirectory?: string | null;
  metadata?: AgentTurnMetadata;
};

export type AgentTurnEvent =
  | {
      type: "thinking.update";
      blockId: string;
      order: number;
      text: string;
      isComplete: boolean;
    }
  | {
      type: "tool.update";
      blockId: string;
      order: number;
      toolCallId: string;
      toolName: string;
      inputText: string;
      outputText: string;
      isComplete: boolean;
      isError: boolean;
    }
  | {
      type: "response.update";
      text: string;
      isComplete: boolean;
    };

export type RuntimeStreamEvent = AgentTurnEvent;

export const createMachineJobEventInputSchema = z.object({
  machineId: z.string().min(1),
  machineSecret: z.string().min(1),
  event: z.custom<AgentTurnEvent>(),
});

export type CreateMachineJobEventInput = z.infer<typeof createMachineJobEventInputSchema>;

export type MachineJob = {
  id: string;
  kind: MachineJobKind;
  payload: AgentTurnInput;
  createdAt: string;
};

export const rootBranchId = "branch_root";

export const clientStreamTurnMetadataSchema = z.object({
  clientTurnId: z.string().trim().min(1).max(80).optional(),
  clientUserMessageId: z.string().trim().min(1).max(80).optional(),
  clientAssistantMessageId: z.string().trim().min(1).max(80).optional(),
  clientCreatedAt: z.string().trim().min(1).max(80).optional(),
});

export type ClientStreamTurnMetadata = z.infer<typeof clientStreamTurnMetadataSchema>;

export const createRootTurnInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  machineId: z.string().trim().min(1).optional(),
  selectedText: z.string().trim().max(1000).optional(),
  clientTurnId: clientStreamTurnMetadataSchema.shape.clientTurnId,
  clientUserMessageId: clientStreamTurnMetadataSchema.shape.clientUserMessageId,
  clientAssistantMessageId: clientStreamTurnMetadataSchema.shape.clientAssistantMessageId,
  clientCreatedAt: clientStreamTurnMetadataSchema.shape.clientCreatedAt,
});

export type CreateRootTurnInput = z.infer<typeof createRootTurnInputSchema>;

export const createRootArticleInputSchema = z.object({
  filePath: z.string().trim().min(1).max(4096),
});

export type CreateRootArticleInput = z.infer<typeof createRootArticleInputSchema>;

export const createBranchInputSchema = z
  .object({
    sourceMessageId: z.string().min(1),
    mode: z.enum(["selection", "message"]).default("selection"),
    selectedText: z.string().trim().max(1000).optional(),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().positive().optional(),
    prompt: z.string().trim().max(4000).default(""),
    clientTurnId: clientStreamTurnMetadataSchema.shape.clientTurnId,
    clientUserMessageId: clientStreamTurnMetadataSchema.shape.clientUserMessageId,
    clientAssistantMessageId: clientStreamTurnMetadataSchema.shape.clientAssistantMessageId,
    clientCreatedAt: clientStreamTurnMetadataSchema.shape.clientCreatedAt,
    clientBranchId: z.string().trim().min(1).max(80).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "selection") {
      if (!input.selectedText || input.selectedText.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "selectedText is required when branching from a text selection.",
          path: ["selectedText"],
        });
      }

      if (typeof input.startOffset !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "startOffset is required when branching from a text selection.",
          path: ["startOffset"],
        });
      }

      if (typeof input.endOffset !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "endOffset is required when branching from a text selection.",
          path: ["endOffset"],
        });
      }

      if (
        typeof input.startOffset === "number" &&
        typeof input.endOffset === "number" &&
        input.endOffset <= input.startOffset
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "endOffset must be greater than startOffset.",
          path: ["endOffset"],
        });
      }
    }

    if (input.mode === "message" && input.prompt.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt is required when branching from a bubble.",
        path: ["prompt"],
      });
    }
  });

export type CreateBranchInput = z.infer<typeof createBranchInputSchema>;

export const createBranchTurnInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  selectedText: z.string().trim().max(1000).optional(),
  clientTurnId: clientStreamTurnMetadataSchema.shape.clientTurnId,
  clientUserMessageId: clientStreamTurnMetadataSchema.shape.clientUserMessageId,
  clientAssistantMessageId: clientStreamTurnMetadataSchema.shape.clientAssistantMessageId,
  clientCreatedAt: clientStreamTurnMetadataSchema.shape.clientCreatedAt,
});

export type CreateBranchTurnInput = z.infer<typeof createBranchTurnInputSchema>;

export const createNetInputSchema = z.object({
  title: z.string().trim().max(120).default(""),
  agentRuntimeId: z.string().trim().min(1).max(120).optional(),
  agentRuntimeKind: agentRuntimeKindSchema.optional(),
}).superRefine((input, ctx) => {
  const hasRuntimeId = typeof input.agentRuntimeId === "string";
  const hasRuntimeKind = typeof input.agentRuntimeKind === "string";

  if (hasRuntimeId !== hasRuntimeKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "agentRuntimeId and agentRuntimeKind must be provided together.",
      path: hasRuntimeId ? ["agentRuntimeKind"] : ["agentRuntimeId"],
    });
  }
});

export type CreateNetInput = z.infer<typeof createNetInputSchema>;

export const updateNetInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    agentRuntimeId: z.string().trim().min(1).max(120).optional(),
    agentRuntimeKind: agentRuntimeKindSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const hasTitle = typeof input.title === "string";
    const hasRuntimeId = typeof input.agentRuntimeId === "string";
    const hasRuntimeKind = typeof input.agentRuntimeKind === "string";

    if (!hasTitle && !hasRuntimeId && !hasRuntimeKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one net field must be updated.",
        path: [],
      });
    }

    if (hasRuntimeId !== hasRuntimeKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentRuntimeId and agentRuntimeKind must be provided together.",
        path: hasRuntimeId ? ["agentRuntimeKind"] : ["agentRuntimeId"],
      });
    }
  });

export type UpdateNetInput = z.infer<typeof updateNetInputSchema>;

export const openWorkspaceInputSchema = z.object({
  workingDirectory: z.string().trim().min(1),
});

export type OpenWorkspaceInput = z.infer<typeof openWorkspaceInputSchema>;

export type AgentTurnResult = {
  handle: string;
  outputText: string;
  runtimeId: string;
  runtimeKind: AgentRuntimeKind;
  machineId: string;
};

export type RuntimeResponse = AgentTurnResult;

export type AssistantStreamBlock =
  | {
      id: string;
      order: number;
      kind: "thinking";
      text: string;
      status: "streaming" | "complete";
    }
  | {
      id: string;
      order: number;
      kind: "tool_call";
      toolCallId: string;
      toolName: string;
      inputText: string;
      outputText: string;
      isError: boolean;
      status: "streaming" | "complete" | "error";
    };

export type AssistantStreamState = {
  status: "pending" | "streaming" | "complete" | "error";
  blocks: AssistantStreamBlock[];
  responseText: string;
  errorMessage: string | null;
};

export function createPendingAssistantState(): AssistantStreamState {
  return {
    status: "pending",
    blocks: [],
    responseText: "",
    errorMessage: null,
  };
}

export function resolveAgentRuntimeLabel(runtimeKind: AgentRuntimeKind) {
  switch (runtimeKind) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "mock":
      return "Mock runtime";
  }
}

function finalizeAssistantBlocks(blocks: AssistantStreamBlock[] | null | undefined): AssistantStreamBlock[] {
  return (blocks ?? []).map((block) =>
    block.kind === "thinking"
      ? {
          ...block,
          status: "complete",
        }
      : {
          ...block,
          status: block.status === "error" ? "error" : "complete",
        },
  );
}

export function finalizeAssistantState(
  current: AssistantStreamState | null | undefined,
  responseText: string,
): AssistantStreamState {
  return {
    status: current?.errorMessage ? "error" : "complete",
    blocks: finalizeAssistantBlocks(current?.blocks),
    responseText: responseText || current?.responseText || "",
    errorMessage: current?.errorMessage ?? null,
  };
}

export type TurnStreamEvent =
  | {
      type: "turn.bootstrap";
      turnId: string;
      assistantMessageId: string;
      snapshot: GraphSnapshot;
      assistantState: AssistantStreamState;
    }
  | {
      type: "assistant.patch";
      turnId: string;
      assistantMessageId: string;
      state: AssistantStreamState;
    }
  | {
      type: "turn.committed";
      turnId: string;
      assistantMessageId: string;
      snapshot: GraphSnapshot;
    }
  | {
      type: "turn.error";
      turnId: string;
      assistantMessageId: string;
      message: string;
    };

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildSelectionPrompt(
  selectedText: string,
  userPrompt: string,
  sourceRole: Role | null = "assistant",
): string {
  const normalizedSelectedText = truncatePromptContext(selectedText.trim() || "(empty selection)", 1600);
  const normalizedUserPrompt =
    userPrompt.trim().length > 0
      ? userPrompt.trim()
      : "Continue by explaining the highlighted passage more deeply.";
  const sourceDescription =
    sourceRole === "article"
      ? "The user is asking a follow-up about a highlighted passage from an article they provided."
      : "The user is asking a follow-up about a highlighted passage from your previous answer.";
  const groundingInstruction =
    sourceRole === "article"
      ? "Stay grounded in the article's context and keep the next answer focused on the highlighted passage unless the user broadens the scope."
      : "Stay grounded in the original reply's context and keep the next answer focused on the highlighted passage unless the user broadens the scope.";

  return [
    sourceDescription,
    "Highlighted passage:",
    `"""${normalizedSelectedText}"""`,
    groundingInstruction,
    "",
    "User follow-up:",
    normalizedUserPrompt,
  ].join("\n");
}

export function buildPrefixReplayPrompt(input: {
  history: ReadonlyArray<Pick<MessageNode, "role" | "content">>;
  userPrompt: string;
  selectedText?: string | null;
  selectedTextSourceRole?: Role | null;
}): string {
  const normalizedHistory = input.history.map((message) => ({
    role: message.role,
    content: message.content.trim() || "(empty message)",
  }));
  const normalizedUserPrompt =
    input.userPrompt.trim().length > 0
      ? input.userPrompt.trim()
      : input.selectedText?.trim()
        ? "Continue by explaining the highlighted passage more deeply."
        : "Continue the conversation from this point.";

  const lines = [
    "You are starting a fresh branch of an existing conversation.",
    "The transcript below is the complete visible conversation history for this branch.",
    "Anything not included below is intentionally outside this branch and must not be assumed.",
    "",
    "Transcript:",
  ];

  if (normalizedHistory.length === 0) {
    lines.push("(empty transcript)");
  } else {
    for (const [index, message] of normalizedHistory.entries()) {
      lines.push(`[${index + 1}] ${formatPromptRoleLabel(message.role)}:`);
      lines.push(`"""${message.content}"""`);
      lines.push("");
    }
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  lines.push("");
  lines.push("Branch point:");
  lines.push(`The new branch begins immediately after transcript item [${normalizedHistory.length}].`);

  if (input.selectedText?.trim()) {
    lines.push("");
    lines.push(`Highlighted context inside the last ${describePromptSourceLabel(input.selectedTextSourceRole)} message:`);
    lines.push(`"""${truncatePromptContext(input.selectedText.trim(), 1600)}"""`);
    lines.push(
      input.selectedTextSourceRole === "article"
        ? "Keep the next answer grounded in that highlighted passage and the surrounding article unless the user broadens the scope."
        : "Keep the next answer grounded in that highlighted passage unless the user broadens the scope.",
    );
  }

  lines.push("");
  lines.push("New user message:");
  lines.push(normalizedUserPrompt);

  return lines.join("\n");
}

export function buildRootHistoryPrompt(input: {
  history: ReadonlyArray<Pick<MessageNode, "role" | "content">>;
  userPrompt: string;
  selectedText?: string | null;
  selectedTextSourceRole?: Role | null;
}): string {
  const normalizedHistory = input.history.map((message) => ({
    role: message.role,
    content: message.content.trim() || "(empty message)",
  }));
  const normalizedUserPrompt =
    input.userPrompt.trim().length > 0
      ? input.userPrompt.trim()
      : input.selectedText?.trim()
        ? "Continue by explaining the highlighted passage more deeply."
        : "Continue the conversation from this point.";
  const lines = [
    "You are continuing the root conversation in netchat.",
    "The transcript below is the complete root conversation history so far.",
    "Any article message is source material the user explicitly provided.",
    "",
    "Transcript:",
  ];

  if (normalizedHistory.length === 0) {
    lines.push("(empty transcript)");
  } else {
    for (const [index, message] of normalizedHistory.entries()) {
      lines.push(`[${index + 1}] ${formatPromptRoleLabel(message.role)}:`);
      lines.push(`"""${message.content}"""`);
      lines.push("");
    }
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  if (input.selectedText?.trim()) {
    lines.push("");
    lines.push(`Highlighted context inside the last ${describePromptSourceLabel(input.selectedTextSourceRole)} message:`);
    lines.push(`"""${truncatePromptContext(input.selectedText.trim(), 1600)}"""`);
    lines.push(
      input.selectedTextSourceRole === "article"
        ? "Keep the next answer grounded in that highlighted passage and the surrounding article unless the user broadens the scope."
        : "Keep the next answer grounded in that highlighted passage unless the user broadens the scope.",
    );
  }

  lines.push("");
  lines.push("New user message:");
  lines.push(normalizedUserPrompt);

  return lines.join("\n");
}

export function describeBranchCreation(input: CreateBranchInput, sourceMessage: Pick<MessageNode, "role">) {
  const isSelectionBranch = input.mode === "selection";
  const normalizedPrompt = input.prompt.trim();
  const branchTitle = isSelectionBranch
    ? input.selectedText!.trim()
    : normalizedPrompt || `Alternate path from ${sourceMessage.role}`;
  const userMessageContent = isSelectionBranch
    ? normalizedPrompt.length > 0
      ? normalizedPrompt
      : `Explain "${input.selectedText!}" in context.`
    : normalizedPrompt;

  return {
    branchTitle,
    userMessageContent,
  };
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

function truncatePromptContext(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatPromptRoleLabel(role: Role) {
  switch (role) {
    case "user":
      return "User";
    case "article":
      return "Article";
    default:
      return "Assistant";
  }
}

function describePromptSourceLabel(role: Role | null | undefined) {
  return role === "article" ? "article" : "assistant";
}
