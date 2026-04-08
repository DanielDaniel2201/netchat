import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  AgentRuntimeOption,
  AgentTurnEvent,
  AgentTurnInput,
  AgentTurnResult,
  AssistantStreamBlock,
  AssistantStreamState,
  Branch,
  CompleteMachineJobInput,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateMachineClaimJobInput,
  CreateMachineHeartbeatInput,
  CreateMachineJobEventInput,
  CreateMachineRegisterInput,
  CreateNetInput,
  CreateRootTurnInput,
  GraphSnapshot,
  MessageNode,
  UpdateNetInput,
  ServerDiagnostics,
  TurnStreamEvent,
  UiConfig,
  WorkspaceState,
  buildGraphEdges,
  buildPrefixReplayPrompt,
  buildSelectionPrompt,
  completeMachineJobInputSchema,
  createPendingAssistantState,
  createMachineClaimJobInputSchema,
  createMachineHeartbeatInputSchema,
  createMachineJobEventInputSchema,
  createNetInputSchema,
  createMachineRegisterInputSchema,
  createBranchInputSchema,
  createBranchTurnInputSchema,
  createRootTurnInputSchema,
  describeBranchCreation,
  finalizeAssistantState,
  makeId,
  nowIso,
  updateNetInputSchema,
  rootBranchId,
} from "@netchat/shared";

import { ServerDiagnosticsStore } from "./diagnostics.js";
import { MachineStore } from "./machine-store.js";
import { loadLocalEnv } from "./load-env.js";
import { WorkspaceStore } from "./workspace-store.js";
import { registerLocalWebUi } from "./web-ui.js";

loadLocalEnv();

const app = Fastify({
  logger: false,
});
const store = new WorkspaceStore();
const machines = new MachineStore();
const diagnostics = new ServerDiagnosticsStore({
  jobTimeoutMs: null,
  onlineThresholdMs: machines.getOnlineThresholdMs(),
  pollingIntervalMs: machines.getPollingIntervalMs(),
});
machines.attachDiagnostics(diagnostics);
const port = Number(process.env.PORT ?? 3001);

diagnostics.log(
  "info",
  `Server booting with no machine job timeout and machine polling interval ${machines.getPollingIntervalMs()}ms.`,
);

await app.register(cors, {
  origin: true,
});

app.get("/health", async () => ({
  ok: true,
}));

app.get("/api/workspace", async (): Promise<WorkspaceState> => store.getWorkspaceState());

app.get("/api/graph", async () => store.getSnapshot());

app.get("/api/agents", async (): Promise<AgentRuntimeOption[]> => machines.listAgentRuntimes());

app.get("/api/ui-config", async (): Promise<UiConfig> => ({
  showSessionIds: readBooleanEnv("NETCHAT_SHOW_SESSION_IDS"),
}));

app.get("/api/runtime/diagnostics", async (request, reply) => {
  const daemonUrl = process.env.NETCHAT_DAEMON_URL?.trim();
  if (!daemonUrl) {
    return reply.status(503).send({ message: "The local daemon URL is not configured." });
  }

  try {
    const response = await fetch(new URL("/runtime/diagnostics", daemonUrl));
    const payload = await response.text();
    if (!response.ok) {
      return reply.status(response.status).type("application/json").send(payload);
    }

    reply.type("application/json");
    return payload;
  } catch (error) {
    diagnostics.log("warn", `Reading daemon diagnostics failed: ${formatError(error)}`);
    return reply.status(502).send({ message: "The local daemon is unavailable." });
  }
});

app.post("/api/nets", async (request, reply) => {
  const input = createNetInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    const workspace = store.createNet(input.data as CreateNetInput);
    diagnostics.log("info", `Created net ${workspace.activeNetId} for workspace ${workspace.workspaceId}.`);
    return workspace;
  } catch (error) {
    diagnostics.log("error", `Creating a new net failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/nets/:netId/select", async (request, reply) => {
  const netId = (request.params as { netId: string }).netId;

  try {
    const workspace = store.selectNet(netId);
    diagnostics.log("info", `Switched to net ${netId} for workspace ${workspace.workspaceId}.`);
    return workspace;
  } catch (error) {
    diagnostics.log("warn", `Switching to net ${netId} failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.patch("/api/nets/:netId", async (request, reply) => {
  const netId = (request.params as { netId: string }).netId;
  const input = updateNetInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    const workspace = store.updateNet(netId, input.data as UpdateNetInput);
    diagnostics.log("info", `Updated net ${netId} for workspace ${workspace.workspaceId}.`);
    return workspace;
  } catch (error) {
    diagnostics.log("warn", `Updating net ${netId} failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.delete("/api/nets/:netId", async (request, reply) => {
  const netId = (request.params as { netId: string }).netId;

  try {
    const workspace = store.deleteNet(netId);
    diagnostics.log("info", `Deleted net ${netId} for workspace ${workspace.workspaceId}.`);
    return workspace;
  } catch (error) {
    diagnostics.log("warn", `Deleting net ${netId} failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.get("/api/diagnostics", async (): Promise<ServerDiagnostics> => diagnostics.getSnapshot());

app.post("/api/daemon/register", async (request, reply) => {
  const input = createMachineRegisterInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    return machines.registerMachine(input.data as CreateMachineRegisterInput);
  } catch (error) {
    diagnostics.log(
      "warn",
      `Rejected machine registration for ${input.data.machineName}: ${formatError(error)}`,
    );
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/daemon/heartbeat", async (request, reply) => {
  const input = createMachineHeartbeatInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    return machines.heartbeat(input.data as CreateMachineHeartbeatInput);
  } catch (error) {
    return reply.status(401).send({ message: formatError(error) });
  }
});

app.post("/api/daemon/jobs/claim", async (request, reply) => {
  const input = createMachineClaimJobInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    return {
      job: machines.claimJob(input.data.machineId, input.data.machineSecret),
    };
  } catch (error) {
    return reply.status(401).send({ message: formatError(error) });
  }
});

app.post("/api/daemon/jobs/:jobId/complete", async (request, reply) => {
  const jobId = (request.params as { jobId: string }).jobId;
  const input = completeMachineJobInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    machines.completeJob(jobId, input.data as CompleteMachineJobInput);
    return {
      ok: true,
    };
  } catch (error) {
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/daemon/jobs/:jobId/events", async (request, reply) => {
  const jobId = (request.params as { jobId: string }).jobId;
  const input = createMachineJobEventInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    machines.recordJobEvent(jobId, input.data as CreateMachineJobEventInput);
    return { ok: true };
  } catch (error) {
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/root-turn/stream", async (request, reply) => {
  const input = createRootTurnInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const baseSnapshot = store.getSnapshot();
  const rootBranch = baseSnapshot.branches.find((branch) => branch.id === rootBranchId) ?? null;
  const activeNet = store.getActiveNetSummary();
  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    const machine = machines.resolveMachine({
      preferredMachineId: input.data.machineId ?? rootBranch?.machineId ?? null,
      preferredRuntimeId: rootBranch?.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    const turnId = input.data.clientTurnId ?? makeId("turn");
    const userMessageId = input.data.clientUserMessageId ?? makeId("msg");
    const assistantMessageId = input.data.clientAssistantMessageId ?? makeId("msg");
    const createdAt = input.data.clientCreatedAt ?? nowIso();
    const streamingJob = machines.enqueueStreamingJob(machine.id, {
      kind: "root-turn",
      payload: {
        prompt: runtimePrompt,
        session: rootBranch?.sessionId
          ? {
              mode: "resume",
              handle: rootBranch.sessionId,
            }
          : {
              mode: "new",
            },
        metadata: {
          netchatOperation: "root-turn",
          selectedText: input.data.selectedText ?? null,
        },
      },
    });
    const optimisticSnapshot = buildOptimisticRootTurnSnapshot(baseSnapshot, {
      assistantMessageId,
      createdAt,
      machineId: machine.id,
      runtimeId: machine.environment.runtimeId,
      runtimeKind: machine.environment.runtimeKind,
      prompt: input.data.prompt,
      selectedText: input.data.selectedText ?? null,
      userMessageId,
    });

    diagnostics.log(
      "info",
      input.data.selectedText
        ? `Streaming root turn from highlighted passage (${input.data.selectedText.length} selected chars, ${input.data.prompt.length} prompt chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${rootBranch?.sessionId ?? "new"}.`
        : `Streaming root turn (${input.data.prompt.length} chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${rootBranch?.sessionId ?? "new"}.`,
    );

    return streamTurnResponse({
      assistantMessageId,
      bootstrapSnapshot: optimisticSnapshot,
      commit: (runtime, assistantState) => {
        const nextSnapshot = store.applyRootTurn(input.data.prompt, runtime, {
          assistantMessageId,
          assistantState,
          selectedText: input.data.selectedText ?? null,
          userMessageId,
        });
        diagnostics.log(
          "info",
          `Root turn completed on ${formatMachineLabel(runtime.machineId, machine.name)}. Graph now has ${nextSnapshot.messages.length} messages across ${nextSnapshot.branches.length} branches.`,
        );
        return nextSnapshot;
      },
      reply,
      request,
      result: streamingJob.result,
      dispose: streamingJob.dispose,
      subscribe: streamingJob.subscribe,
      turnId,
    });
  } catch (error) {
    diagnostics.log("error", `Root turn failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/branches/stream", async (request, reply) => {
  const input = createBranchInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const sourceMessage = store.getMessage(input.data.sourceMessageId);
  if (!sourceMessage) {
    return reply.status(400).send({ error: "The source message does not exist." });
  }

  try {
    const activeNet = store.getActiveNetSummary();
    const machine = machines.resolveMachine({
      preferredMachineId: sourceMessage.machineId ?? null,
      preferredRuntimeId: sourceMessage.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    const visibleHistory = store.getVisiblePathToMessage(sourceMessage.id);
    const branchPrompt = buildPrefixReplayPrompt({
      history: visibleHistory,
      userPrompt: input.data.prompt,
      selectedText: input.data.mode === "selection" ? input.data.selectedText! : null,
    });
    const turnId = input.data.clientTurnId ?? makeId("turn");
    const branchId = input.data.clientBranchId ?? makeId("branch");
    const userMessageId = input.data.clientUserMessageId ?? makeId("msg");
    const assistantMessageId = input.data.clientAssistantMessageId ?? makeId("msg");
    const createdAt = input.data.clientCreatedAt ?? nowIso();
    const optimisticSnapshot = buildOptimisticBranchCreationSnapshot(store.getSnapshot(), {
      assistantMessageId,
      branchId,
      createdAt,
      input: input.data as CreateBranchInput,
      machineId: machine.id,
      runtimeId: machine.environment.runtimeId,
      runtimeKind: machine.environment.runtimeKind,
      userMessageId,
    });
    const streamingJob = machines.enqueueStreamingJob(
      {
        preferredMachineId: sourceMessage.machineId ?? null,
        preferredRuntimeId: sourceMessage.runtimeId ?? activeNet.agentRuntimeId ?? null,
      },
      {
      kind: "branch-create",
      payload: {
        prompt: branchPrompt,
        session: {
          mode: "new",
        },
        metadata: {
          netchatOperation: "branch-create",
          selectedText: input.data.mode === "selection" ? input.data.selectedText ?? null : null,
        },
      } satisfies AgentTurnInput,
      },
    );

    diagnostics.log(
      "info",
      input.data.mode === "message"
        ? `Streaming branch-from-message request from ${sourceMessage.id} on ${formatMachineLabel(machine.id, machine.name)} (${visibleHistory.length} visible messages, ${input.data.prompt.length} prompt chars, replay ${branchPrompt.length} chars).`
        : `Streaming branch-from-selection request from message ${sourceMessage.id} on ${formatMachineLabel(machine.id, machine.name)} (${visibleHistory.length} visible messages, ${input.data.selectedText!.length} selected chars, prompt ${input.data.prompt.length} chars, replay ${branchPrompt.length} chars).`,
    );

    return streamTurnResponse({
      assistantMessageId,
      bootstrapSnapshot: optimisticSnapshot,
      commit: (runtime, assistantState) => {
        const nextSnapshot = store.applyBranchCreation(input.data as CreateBranchInput, runtime, {
          assistantMessageId,
          assistantState,
          branchId,
          userMessageId,
        });
        diagnostics.log(
          "info",
          `Branch creation completed as handle ${runtime.handle} on machine ${runtime.machineId}. Total branches: ${nextSnapshot.branches.length}.`,
        );
        return nextSnapshot;
      },
      reply,
      request,
      result: streamingJob.result,
      dispose: streamingJob.dispose,
      subscribe: streamingJob.subscribe,
      turnId,
    });
  } catch (error) {
    diagnostics.log("error", `Branch request failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/branches/:branchId/turns/stream", async (request, reply) => {
  const branchId = (request.params as { branchId: string }).branchId;
  const input = createBranchTurnInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const branch = store.getBranch(branchId);
  if (!branch?.sessionId) {
    return reply.status(400).send({ error: "This branch does not have a session id yet." });
  }

  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    const activeNet = store.getActiveNetSummary();
    const machine = machines.resolveMachine({
      preferredMachineId: branch.machineId ?? null,
      preferredRuntimeId: branch.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    const turnId = input.data.clientTurnId ?? makeId("turn");
    const userMessageId = input.data.clientUserMessageId ?? makeId("msg");
    const assistantMessageId = input.data.clientAssistantMessageId ?? makeId("msg");
    const createdAt = input.data.clientCreatedAt ?? nowIso();
    const optimisticSnapshot = buildOptimisticBranchTurnSnapshot(store.getSnapshot(), {
      assistantMessageId,
      branchId,
      createdAt,
      machineId: machine.id,
      runtimeId: machine.environment.runtimeId,
      runtimeKind: machine.environment.runtimeKind,
      prompt: input.data.prompt,
      selectedText: input.data.selectedText ?? null,
      userMessageId,
    });
    const streamingJob = machines.enqueueStreamingJob(
      {
        preferredMachineId: branch.machineId ?? null,
        preferredRuntimeId: branch.runtimeId ?? activeNet.agentRuntimeId ?? null,
      },
      {
      kind: "branch-turn",
      payload: {
        prompt: runtimePrompt,
        session: {
          mode: "resume",
          handle: branch.sessionId,
        },
        metadata: {
          netchatOperation: "branch-turn",
          selectedText: input.data.selectedText ?? null,
        },
      },
      },
    );

    diagnostics.log(
      "info",
      input.data.selectedText
        ? `Streaming branch turn for ${branchId} from highlighted passage (${input.data.selectedText.length} selected chars, ${input.data.prompt.length} prompt chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${branch.sessionId}.`
        : `Streaming branch turn for ${branchId} (${input.data.prompt.length} chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${branch.sessionId}.`,
    );

    return streamTurnResponse({
      assistantMessageId,
      bootstrapSnapshot: optimisticSnapshot,
      commit: (runtime, assistantState) => {
        const nextSnapshot = store.applyBranchTurn(branchId, input.data.prompt, runtime, {
          assistantMessageId,
          assistantState,
          selectedText: input.data.selectedText ?? null,
          userMessageId,
        });
        diagnostics.log(
          "info",
          `Branch turn ${branchId} completed on machine ${runtime.machineId}. Branch now has ${nextSnapshot.messages.filter((message) => message.branchId === branchId).length} messages.`,
        );
        return nextSnapshot;
      },
      reply,
      request,
      result: streamingJob.result,
      dispose: streamingJob.dispose,
      subscribe: streamingJob.subscribe,
      turnId,
    });
  } catch (error) {
    diagnostics.log("error", `Branch turn failed for ${branchId}: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/root-turn", async (request, reply) => {
  const input = createRootTurnInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const snapshot = store.getSnapshot();
  const rootBranch = snapshot.branches.find((branch) => branch.id === rootBranchId) ?? null;
  const activeNet = store.getActiveNetSummary();
  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    const machine = machines.resolveMachine({
      preferredMachineId: input.data.machineId ?? rootBranch?.machineId ?? null,
      preferredRuntimeId: rootBranch?.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    diagnostics.log(
      "info",
      input.data.selectedText
        ? `Received root turn from a highlighted passage (${input.data.selectedText.length} selected chars, ${input.data.prompt.length} prompt chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${rootBranch?.sessionId ?? "new"}.`
        : `Received root turn (${input.data.prompt.length} chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${rootBranch?.sessionId ?? "new"}.`,
    );
    const runtime = await machines.enqueueJob(machine.id, {
      kind: "root-turn",
      payload: {
        prompt: runtimePrompt,
        session: rootBranch?.sessionId
          ? {
              mode: "resume",
              handle: rootBranch.sessionId,
            }
          : {
              mode: "new",
            },
        metadata: {
          netchatOperation: "root-turn",
          selectedText: input.data.selectedText ?? null,
        },
      },
    });

    const nextSnapshot = store.applyRootTurn(input.data.prompt, runtime, {
      selectedText: input.data.selectedText ?? null,
    });
    diagnostics.log(
      "info",
      `Root turn completed on ${formatMachineLabel(runtime.machineId, machine.name)}. Graph now has ${nextSnapshot.messages.length} messages across ${nextSnapshot.branches.length} branches.`,
    );
    return nextSnapshot;
  } catch (error) {
    diagnostics.log("error", `Root turn failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/branches", async (request, reply) => {
  const input = createBranchInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const sourceMessage = store.getMessage(input.data.sourceMessageId);
  if (!sourceMessage) {
    return reply.status(400).send({ error: "The source message does not exist." });
  }

  try {
    const activeNet = store.getActiveNetSummary();
    const machine = machines.resolveMachine({
      preferredMachineId: sourceMessage.machineId ?? null,
      preferredRuntimeId: sourceMessage.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    const visibleHistory = store.getVisiblePathToMessage(sourceMessage.id);
    const branchPrompt = buildPrefixReplayPrompt({
      history: visibleHistory,
      userPrompt: input.data.prompt,
      selectedText: input.data.mode === "selection" ? input.data.selectedText! : null,
    });

    diagnostics.log(
      "info",
      input.data.mode === "message"
        ? `Received branch-from-message request from ${sourceMessage.id} on ${formatMachineLabel(machine.id, machine.name)} (${visibleHistory.length} visible messages, ${input.data.prompt.length} prompt chars, replay ${branchPrompt.length} chars).`
        : `Received branch-from-selection request from message ${sourceMessage.id} on ${formatMachineLabel(machine.id, machine.name)} (${visibleHistory.length} visible messages, ${input.data.selectedText!.length} selected chars, prompt ${input.data.prompt.length} chars, replay ${branchPrompt.length} chars).`,
    );
    const runtime = await machines.enqueueJob(
      {
        preferredMachineId: sourceMessage.machineId ?? null,
        preferredRuntimeId: sourceMessage.runtimeId ?? activeNet.agentRuntimeId ?? null,
      },
      {
      kind: "branch-create",
      payload: {
        prompt: branchPrompt,
        session: {
          mode: "new",
        },
        metadata: {
          netchatOperation: "branch-create",
          selectedText: input.data.mode === "selection" ? input.data.selectedText ?? null : null,
        },
      } satisfies AgentTurnInput,
      },
    );

    const nextSnapshot = store.applyBranchCreation(input.data as CreateBranchInput, runtime);
    diagnostics.log(
      "info",
      `Branch creation completed as handle ${runtime.handle} on machine ${runtime.machineId}. Total branches: ${nextSnapshot.branches.length}.`,
    );
    return nextSnapshot;
  } catch (error) {
    diagnostics.log("error", `Branch request failed: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

app.post("/api/branches/:branchId/turns", async (request, reply) => {
  const branchId = (request.params as { branchId: string }).branchId;
  const input = createBranchTurnInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const branch = store.getBranch(branchId);
  if (!branch?.sessionId) {
    return reply.status(400).send({ error: "This branch does not have a session id yet." });
  }

  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    const activeNet = store.getActiveNetSummary();
    const machine = machines.resolveMachine({
      preferredMachineId: branch.machineId ?? null,
      preferredRuntimeId: branch.runtimeId ?? activeNet.agentRuntimeId ?? null,
    });
    diagnostics.log(
      "info",
      input.data.selectedText
        ? `Received branch turn for ${branchId} from a highlighted passage (${input.data.selectedText.length} selected chars, ${input.data.prompt.length} prompt chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${branch.sessionId}.`
        : `Received branch turn for ${branchId} (${input.data.prompt.length} chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${branch.sessionId}.`,
    );
    const runtime = await machines.enqueueJob(
      {
        preferredMachineId: branch.machineId ?? null,
        preferredRuntimeId: branch.runtimeId ?? activeNet.agentRuntimeId ?? null,
      },
      {
      kind: "branch-turn",
      payload: {
        prompt: runtimePrompt,
        session: {
          mode: "resume",
          handle: branch.sessionId,
        },
        metadata: {
          netchatOperation: "branch-turn",
          selectedText: input.data.selectedText ?? null,
        },
      },
      },
    );

    const nextSnapshot = store.applyBranchTurn(branchId, input.data.prompt, runtime, {
      selectedText: input.data.selectedText ?? null,
    });
    diagnostics.log(
      "info",
      `Branch turn ${branchId} completed on machine ${runtime.machineId}. Branch now has ${nextSnapshot.messages.filter((message) => message.branchId === branchId).length} messages.`,
    );
    return nextSnapshot;
  } catch (error) {
    diagnostics.log("error", `Branch turn failed for ${branchId}: ${formatError(error)}`);
    return reply.status(400).send({ message: formatError(error) });
  }
});

registerLocalWebUi(app, diagnostics);

await app.listen({ host: "0.0.0.0", port });
diagnostics.log("info", `Server listening on port ${port}.`);

function applyRuntimeEventToAssistantState(
  current: AssistantStreamState,
  event: AgentTurnEvent,
): AssistantStreamState {
  if (event.type === "response.update") {
    return {
      ...current,
      status: event.isComplete ? "complete" : "streaming",
      responseText: event.text,
    };
  }

  const nextBlocks = upsertAssistantBlock(current.blocks, event);
  return {
    ...current,
    status: "streaming",
    blocks: nextBlocks,
  };
}

function upsertAssistantBlock(
  blocks: AssistantStreamBlock[],
  event: Exclude<AgentTurnEvent, { type: "response.update" }>,
): AssistantStreamBlock[] {
  const nextBlocks = [...blocks];
  const index = nextBlocks.findIndex((block) => block.id === event.blockId);

  if (event.type === "thinking.update") {
    const nextBlock: AssistantStreamBlock = {
      id: event.blockId,
      order: event.order,
      kind: "thinking",
      text: event.text,
      status: event.isComplete ? "complete" : "streaming",
    };

    if (index >= 0) {
      nextBlocks[index] = nextBlock;
    } else {
      nextBlocks.push(nextBlock);
    }

    return nextBlocks.sort(compareAssistantBlocks);
  }

  const nextBlock: AssistantStreamBlock = {
    id: event.blockId,
    order: event.order,
    kind: "tool_call",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    inputText: event.inputText,
    outputText: event.outputText,
    isError: event.isError,
    status: event.isError ? "error" : event.isComplete ? "complete" : "streaming",
  };

  if (index >= 0) {
    nextBlocks[index] = nextBlock;
  } else {
    nextBlocks.push(nextBlock);
  }

  return nextBlocks.sort(compareAssistantBlocks);
}

function compareAssistantBlocks(left: AssistantStreamBlock, right: AssistantStreamBlock) {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  return left.id.localeCompare(right.id);
}

async function streamTurnResponse(input: {
  turnId: string;
  assistantMessageId: string;
  bootstrapSnapshot: GraphSnapshot;
  request: {
    raw: {
      on: (event: "close", listener: () => void) => void;
    };
  };
  reply: {
    hijack: () => void;
    raw: {
      end: () => void;
      on: (event: "close", listener: () => void) => void;
      write: (chunk: string) => void;
      writeHead: (statusCode: number, headers: Record<string, string>) => void;
    };
  };
  subscribe: (listener: (event: AgentTurnEvent) => void) => () => void;
  dispose: () => void;
  result: Promise<AgentTurnResult>;
  commit: (runtime: AgentTurnResult, assistantState: AssistantStreamState) => GraphSnapshot;
}) {
  let assistantState = createPendingAssistantState();
  const bootstrapEvent: TurnStreamEvent = {
    type: "turn.bootstrap",
    turnId: input.turnId,
    assistantMessageId: input.assistantMessageId,
    snapshot: input.bootstrapSnapshot,
    assistantState,
  };

  input.reply.hijack();
  const response = input.reply.raw;
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });

  const writeEvent = (event: TurnStreamEvent) => {
    response.write(`${JSON.stringify(event)}\n`);
  };

  store.saveAssistantState(input.assistantMessageId, assistantState);
  writeEvent(bootstrapEvent);

  const unsubscribe = input.subscribe((runtimeEvent) => {
    assistantState = applyRuntimeEventToAssistantState(assistantState, runtimeEvent);
    store.saveAssistantState(input.assistantMessageId, assistantState);
    writeEvent({
      type: "assistant.patch",
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      state: assistantState,
    });
  });

  response.on("close", unsubscribe);

  try {
    const runtime = await input.result;
    assistantState = finalizeAssistantState(assistantState, runtime.outputText);
    store.saveAssistantState(input.assistantMessageId, assistantState);
    const snapshot = input.commit(runtime, assistantState);
    writeEvent({
      type: "turn.committed",
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      snapshot,
    });
  } catch (error) {
    assistantState = {
      ...assistantState,
      status: "error",
      errorMessage: formatError(error),
    };
    store.saveAssistantState(input.assistantMessageId, assistantState);
    writeEvent({
      type: "assistant.patch",
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      state: assistantState,
    });
    writeEvent({
      type: "turn.error",
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      message: formatError(error),
    });
  } finally {
    unsubscribe();
    input.dispose();
    response.end();
  }
}

function buildOptimisticRootTurnSnapshot(
  snapshot: GraphSnapshot,
  input: {
    userMessageId: string;
    assistantMessageId: string;
    prompt: string;
    selectedText: string | null;
    machineId: string;
    runtimeId: string;
    runtimeKind: MessageNode["runtimeKind"];
    createdAt: string;
  },
) {
  const messages = [
    ...snapshot.messages,
    {
      id: input.userMessageId,
      branchId: rootBranchId,
      role: "user",
      content: input.prompt,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
    {
      id: input.assistantMessageId,
      branchId: rootBranchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
  ];

  return {
    branches: snapshot.branches,
    messages,
    edges: buildGraphEdges({
      branches: snapshot.branches,
      messages,
    }),
    assistantStates: {
      ...snapshot.assistantStates,
      [input.assistantMessageId]: createPendingAssistantState(),
    },
  } satisfies GraphSnapshot;
}

function buildOptimisticBranchCreationSnapshot(
  snapshot: GraphSnapshot,
  input: {
    branchId: string;
    userMessageId: string;
    assistantMessageId: string;
    input: CreateBranchInput;
    machineId: string;
    runtimeId: string;
    runtimeKind: Branch["runtimeKind"];
    createdAt: string;
  },
) {
  const sourceMessage = snapshot.messages.find((message) => message.id === input.input.sourceMessageId);
  if (!sourceMessage) {
    throw new Error(`Unknown source message: ${input.input.sourceMessageId}`);
  }

  const { branchTitle, userMessageContent } = describeBranchCreation(input.input, sourceMessage);
  const branch: Branch = {
    id: input.branchId,
    parentBranchId: sourceMessage.branchId,
    sourceMessageId: sourceMessage.id,
    sessionId: null,
    machineId: input.machineId,
    runtimeId: input.runtimeId,
    runtimeKind: input.runtimeKind,
    title: branchTitle,
    selectedText: input.input.mode === "selection" ? input.input.selectedText ?? null : null,
    startOffset: input.input.mode === "selection" ? input.input.startOffset ?? null : null,
    endOffset: input.input.mode === "selection" ? input.input.endOffset ?? null : null,
    createdAt: input.createdAt,
  };
  const messages = [
    ...snapshot.messages,
    {
      id: input.userMessageId,
      branchId: input.branchId,
      role: "user",
      content: userMessageContent,
      selectedText: input.input.mode === "selection" ? input.input.selectedText ?? null : null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
    {
      id: input.assistantMessageId,
      branchId: input.branchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
  ];
  const branches = [...snapshot.branches, branch];

  return {
    branches,
    messages,
    edges: buildGraphEdges({ branches, messages }),
    assistantStates: {
      ...snapshot.assistantStates,
      [input.assistantMessageId]: createPendingAssistantState(),
    },
  } satisfies GraphSnapshot;
}

function buildOptimisticBranchTurnSnapshot(
  snapshot: GraphSnapshot,
  input: {
    branchId: string;
    userMessageId: string;
    assistantMessageId: string;
    prompt: string;
    selectedText: string | null;
    machineId: string;
    runtimeId: string;
    runtimeKind: MessageNode["runtimeKind"];
    createdAt: string;
  },
) {
  const messages = [
    ...snapshot.messages,
    {
      id: input.userMessageId,
      branchId: input.branchId,
      role: "user",
      content: input.prompt,
      selectedText: input.selectedText,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
    {
      id: input.assistantMessageId,
      branchId: input.branchId,
      role: "assistant",
      content: "",
      selectedText: null,
      sessionId: null,
      machineId: input.machineId,
      runtimeId: input.runtimeId,
      runtimeKind: input.runtimeKind,
      createdAt: input.createdAt,
    } satisfies MessageNode,
  ];

  return {
    branches: snapshot.branches,
    messages,
    edges: buildGraphEdges({
      branches: snapshot.branches,
      messages,
    }),
    assistantStates: {
      ...snapshot.assistantStates,
      [input.assistantMessageId]: createPendingAssistantState(),
    },
  } satisfies GraphSnapshot;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown server error";
}

function formatMachineLabel(machineId: string, machineName: string) {
  return `${machineName} (${machineId})`;
}

function readBooleanEnv(name: string) {
  return process.env[name]?.trim().toLowerCase() === "true";
}
