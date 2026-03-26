import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  CompleteMachineJobInput,
  ContinueBranchRuntimeRequest,
  CreateMachineClaimJobInput,
  CreateMachineHeartbeatInput,
  CreateMachineRegisterInput,
  CreatePairingSessionInput,
  CreateBranchInput,
  CreateBranchTurnInput,
  CreateRootTurnInput,
  ForkBranchRuntimeRequest,
  RootTurnRuntimeRequest,
  ServerDiagnostics,
  buildForkPrompt,
  buildMessageBranchPrompt,
  completeMachineJobInputSchema,
  createMachineClaimJobInputSchema,
  createMachineHeartbeatInputSchema,
  createMachineRegisterInputSchema,
  createPairingSessionInputSchema,
  createBranchInputSchema,
  createBranchTurnInputSchema,
  createRootTurnInputSchema,
  rootBranchId,
} from "@netchat/shared";

import { GraphStore } from "./store.js";
import { ServerDiagnosticsStore } from "./diagnostics.js";
import { MachineStore } from "./machine-store.js";
import { loadLocalEnv } from "./load-env.js";
import { registerLocalWebUi } from "./web-ui.js";

loadLocalEnv();

const app = Fastify({
  logger: false,
});
const store = new GraphStore();
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

app.get("/api/graph", async () => store.getSnapshot());

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
  try {
    const machine = machines.resolveMachine(input.data.machineId ?? rootBranch?.machineId ?? null);
    diagnostics.log(
      "info",
      `Received root turn (${input.data.prompt.length} chars). Routing to ${formatMachineLabel(machine.id, machine.name)} with session ${rootBranch?.sessionId ?? "new"}.`,
    );
    const runtime = await machines.enqueueJob(machine.id, {
      kind: "root-turn",
      payload: {
        prompt: input.data.prompt,
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
  if (!sourceMessage?.sessionId || !sourceMessage.machineId) {
    return reply.status(400).send({ error: "The source message does not have a session id yet." });
  }

  try {
    const branchPrompt =
      input.data.mode === "message"
        ? buildMessageBranchPrompt(sourceMessage, input.data.prompt)
        : buildForkPrompt(input.data.selectedText!, input.data.prompt);
    diagnostics.log(
      "info",
      input.data.mode === "message"
        ? `Received branch-from-message request from ${sourceMessage.id} on machine ${sourceMessage.machineId} (${input.data.prompt.length} prompt chars).`
        : `Received fork request from message ${sourceMessage.id} on machine ${sourceMessage.machineId} (${input.data.selectedText!.length} selected chars, prompt ${input.data.prompt.length} chars).`,
    );
    const runtime = await machines.enqueueJob(sourceMessage.machineId, {
      kind: "fork-branch",
      payload: {
        sourceSessionId: sourceMessage.sessionId,
        selectedText:
          input.data.mode === "message"
            ? sourceMessage.content.slice(0, 160).trim() || sourceMessage.role
            : input.data.selectedText!,
        prompt: branchPrompt,
      },
    });

    const nextSnapshot = store.applyBranchCreation(input.data as CreateBranchInput, runtime);
    diagnostics.log(
      "info",
      `Branch fork completed as session ${runtime.sessionId} on machine ${runtime.machineId}. Total branches: ${nextSnapshot.branches.length}.`,
    );
    return nextSnapshot;
  } catch (error) {
    diagnostics.log("error", `Fork request failed: ${formatError(error)}`);
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

  try {
    diagnostics.log(
      "info",
      `Received branch turn for ${branchId} (${input.data.prompt.length} chars). Routing to machine ${branch.machineId} with session ${branch.sessionId}.`,
    );
    const runtime = await machines.enqueueJob(branch.machineId, {
      kind: "branch-turn",
      payload: {
        sessionId: branch.sessionId,
        prompt: input.data.prompt,
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
