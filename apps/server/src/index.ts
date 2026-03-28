import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  CompleteMachineJobInput,
  CreateBranchRuntimeRequest,
  CreateMachineClaimJobInput,
  CreateMachineHeartbeatInput,
  CreateMachineRegisterInput,
  CreateNetInput,
  CreatePairingSessionInput,
  UpdateNetInput,
  CreateBranchInput,
  ServerDiagnostics,
  UiConfig,
  WorkspaceState,
  buildPrefixReplayPrompt,
  buildSelectionPrompt,
  completeMachineJobInputSchema,
  createMachineClaimJobInputSchema,
  createMachineHeartbeatInputSchema,
  createNetInputSchema,
  createMachineRegisterInputSchema,
  createPairingSessionInputSchema,
  createBranchInputSchema,
  createBranchTurnInputSchema,
  createRootTurnInputSchema,
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
  jobTimeoutMs: machines.getJobTimeoutMs(),
  onlineThresholdMs: machines.getOnlineThresholdMs(),
  pollingIntervalMs: machines.getPollingIntervalMs(),
});
machines.attachDiagnostics(diagnostics);
const port = Number(process.env.PORT ?? 3001);

diagnostics.log(
  "info",
  `Server booting with job timeout ${machines.getJobTimeoutMs()}ms and machine polling interval ${machines.getPollingIntervalMs()}ms.`,
);

await app.register(cors, {
  origin: true,
});

app.get("/health", async () => ({
  ok: true,
}));

app.get("/api/workspace", async (): Promise<WorkspaceState> => store.getWorkspaceState());

app.get("/api/graph", async () => store.getSnapshot());

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
    const workspace = store.renameNet(netId, (input.data as UpdateNetInput).title);
    diagnostics.log("info", `Renamed net ${netId} for workspace ${workspace.workspaceId}.`);
    return workspace;
  } catch (error) {
    diagnostics.log("warn", `Renaming net ${netId} failed: ${formatError(error)}`);
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

app.get("/api/machines", async () => {
  return machines.listMachines();
});

app.get("/api/diagnostics", async (): Promise<ServerDiagnostics> => diagnostics.getSnapshot());

app.post("/api/machines/pairing-sessions", async (request, reply) => {
  const input = createPairingSessionInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const session = machines.createPairingSession(input.data.label);
  diagnostics.log(
    "info",
    `Created pairing code ${session.pairingCode} for ${input.data.label || "unnamed daemon"}.`,
  );
  return session;
});

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

app.post("/api/root-turn", async (request, reply) => {
  const input = createRootTurnInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  const snapshot = store.getSnapshot();
  const rootBranch = snapshot.branches.find((branch) => branch.id === rootBranchId) ?? null;
  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    const machine = machines.resolveMachine(input.data.machineId ?? rootBranch?.machineId ?? null);
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
        sessionId: rootBranch?.sessionId ?? null,
      },
    });

    const nextSnapshot = store.applyRootTurn(input.data.prompt, runtime);
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
  if (!sourceMessage?.machineId) {
    return reply.status(400).send({ error: "The source message does not have a machine id yet." });
  }

  try {
    const visibleHistory = store.getVisiblePathToMessage(sourceMessage.id);
    const branchPrompt = buildPrefixReplayPrompt({
      history: visibleHistory,
      userPrompt: input.data.prompt,
      selectedText: input.data.mode === "selection" ? input.data.selectedText! : null,
    });

    diagnostics.log(
      "info",
      input.data.mode === "message"
        ? `Received branch-from-message request from ${sourceMessage.id} on machine ${sourceMessage.machineId} (${visibleHistory.length} visible messages, ${input.data.prompt.length} prompt chars, replay ${branchPrompt.length} chars).`
        : `Received branch-from-selection request from message ${sourceMessage.id} on machine ${sourceMessage.machineId} (${visibleHistory.length} visible messages, ${input.data.selectedText!.length} selected chars, prompt ${input.data.prompt.length} chars, replay ${branchPrompt.length} chars).`,
    );
    const runtime = await machines.enqueueJob(sourceMessage.machineId, {
      kind: "branch-create",
      payload: {
        prompt: branchPrompt,
      } satisfies CreateBranchRuntimeRequest,
    });

    const nextSnapshot = store.applyBranchCreation(input.data as CreateBranchInput, runtime);
    diagnostics.log(
      "info",
      `Branch creation completed as session ${runtime.sessionId} on machine ${runtime.machineId}. Total branches: ${nextSnapshot.branches.length}.`,
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
  if (!branch?.sessionId || !branch.machineId) {
    return reply.status(400).send({ error: "This branch does not have a session id yet." });
  }

  const runtimePrompt = input.data.selectedText
    ? buildSelectionPrompt(input.data.selectedText, input.data.prompt)
    : input.data.prompt;

  try {
    diagnostics.log(
      "info",
      input.data.selectedText
        ? `Received branch turn for ${branchId} from a highlighted passage (${input.data.selectedText.length} selected chars, ${input.data.prompt.length} prompt chars). Routing to machine ${branch.machineId} with session ${branch.sessionId}.`
        : `Received branch turn for ${branchId} (${input.data.prompt.length} chars). Routing to machine ${branch.machineId} with session ${branch.sessionId}.`,
    );
    const runtime = await machines.enqueueJob(branch.machineId, {
      kind: "branch-turn",
      payload: {
        sessionId: branch.sessionId,
        prompt: runtimePrompt,
      },
    });

    const nextSnapshot = store.applyBranchTurn(branchId, input.data.prompt, runtime);
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

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown server error";
}

function formatMachineLabel(machineId: string, machineName: string) {
  return `${machineName} (${machineId})`;
}

function readBooleanEnv(name: string) {
  return process.env[name]?.trim().toLowerCase() === "true";
}
