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
  buildForkPrompt,
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
import { MachineStore } from "./machine-store.js";
import { loadLocalEnv } from "./load-env.js";

loadLocalEnv();

const app = Fastify({ logger: true });
const store = new GraphStore();
const machines = new MachineStore();
const port = Number(process.env.PORT ?? 3001);

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

app.post("/api/machines/pairing-sessions", async (request, reply) => {
  const input = createPairingSessionInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  return machines.createPairingSession(input.data.label);
});

app.post("/api/daemon/register", async (request, reply) => {
  const input = createMachineRegisterInputSchema.safeParse(request.body);
  if (!input.success) {
    return reply.status(400).send({ error: input.error.flatten() });
  }

  try {
    return machines.registerMachine(input.data as CreateMachineRegisterInput);
  } catch (error) {
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
    const runtime = await machines.enqueueJob(machine.id, {
      kind: "root-turn",
      payload: {
        prompt: input.data.prompt,
        sessionId: rootBranch?.sessionId ?? null,
      },
    });

    return store.applyRootTurn(input.data.prompt, runtime);
  } catch (error) {
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
    const runtime = await machines.enqueueJob(sourceMessage.machineId, {
      kind: "fork-branch",
      payload: {
        sourceSessionId: sourceMessage.sessionId,
        selectedText: input.data.selectedText,
        prompt: buildForkPrompt(input.data.selectedText, input.data.prompt),
      },
    });

    return store.applyBranchCreation(input.data as CreateBranchInput, runtime);
  } catch (error) {
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
    const runtime = await machines.enqueueJob(branch.machineId, {
      kind: "branch-turn",
      payload: {
        sessionId: branch.sessionId,
        prompt: input.data.prompt,
      },
    });

    return store.applyBranchTurn(branchId, input.data.prompt, runtime);
  } catch (error) {
    return reply.status(400).send({ message: formatError(error) });
  }
});

await app.listen({ host: "0.0.0.0", port });

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown server error";
}
