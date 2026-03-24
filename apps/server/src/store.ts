import {
  Branch,
  CreateBranchInput,
  GraphSnapshot,
  MessageNode,
  RuntimeResponse,
  buildGraphEdges,
  makeId,
  nowIso,
  rootBranchId,
} from "@netchat/shared";

export class GraphStore {
  private branches = new Map<string, Branch>();
  private messages = new Map<string, MessageNode>();

  constructor() {
    this.ensureRootBranch();
  }

  getSnapshot(): GraphSnapshot {
    const branches = Array.from(this.branches.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const messages = Array.from(this.messages.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );

    return {
      branches,
      messages,
      edges: buildGraphEdges({ branches, messages }),
    };
  }

  getBranch(branchId: string): Branch | undefined {
    return this.branches.get(branchId);
  }

  getMessage(messageId: string): MessageNode | undefined {
    return this.messages.get(messageId);
  }

  applyRootTurn(prompt: string, runtime: RuntimeResponse): GraphSnapshot {
    const branch = this.ensureRootBranch();
    branch.sessionId = runtime.sessionId;
    branch.title = "Root session";
    branch.machineId = runtime.machineId;

    const userMessageId = makeId("msg");
    this.messages.set(userMessageId, {
      id: userMessageId,
      branchId: branch.id,
      role: "user",
      content: prompt,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });
    const assistantMessageId = makeId("msg");
    this.messages.set(assistantMessageId, {
      id: assistantMessageId,
      branchId: branch.id,
      role: "assistant",
      content: runtime.assistantMessage,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });

    return this.getSnapshot();
  }

  applyBranchCreation(input: CreateBranchInput, runtime: RuntimeResponse): GraphSnapshot {
    const sourceMessage = this.messages.get(input.sourceMessageId);
    if (!sourceMessage) {
      throw new Error(`Unknown source message: ${input.sourceMessageId}`);
    }

    const branchId = makeId("branch");
    this.branches.set(branchId, {
      id: branchId,
      parentBranchId: sourceMessage.branchId,
      sourceMessageId: sourceMessage.id,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      title: input.selectedText,
      selectedText: input.selectedText,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      createdAt: nowIso(),
    });

    const userMessageContent =
      input.prompt.trim().length > 0 ? input.prompt.trim() : `Explain "${input.selectedText}" in context.`;

    const userMessageId = makeId("msg");
    this.messages.set(userMessageId, {
      id: userMessageId,
      branchId,
      role: "user",
      content: userMessageContent,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });
    const assistantMessageId = makeId("msg");
    this.messages.set(assistantMessageId, {
      id: assistantMessageId,
      branchId,
      role: "assistant",
      content: runtime.assistantMessage,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });

    return this.getSnapshot();
  }

  applyBranchTurn(branchId: string, prompt: string, runtime: RuntimeResponse): GraphSnapshot {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Unknown branch: ${branchId}`);
    }

    branch.sessionId = runtime.sessionId;
    branch.machineId = runtime.machineId;

    const userMessageId = makeId("msg");
    this.messages.set(userMessageId, {
      id: userMessageId,
      branchId,
      role: "user",
      content: prompt,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });
    const assistantMessageId = makeId("msg");
    this.messages.set(assistantMessageId, {
      id: assistantMessageId,
      branchId,
      role: "assistant",
      content: runtime.assistantMessage,
      sessionId: runtime.sessionId,
      machineId: runtime.machineId,
      createdAt: nowIso(),
    });

    return this.getSnapshot();
  }

  private ensureRootBranch(): Branch {
    const existing = this.branches.get(rootBranchId);
    if (existing) {
      return existing;
    }

    const created: Branch = {
      id: rootBranchId,
      parentBranchId: null,
      sourceMessageId: null,
      sessionId: null,
      machineId: null,
      title: "Root session",
      selectedText: null,
      startOffset: null,
      endOffset: null,
      createdAt: nowIso(),
    };
    this.branches.set(created.id, created);
    return created;
  }
}
