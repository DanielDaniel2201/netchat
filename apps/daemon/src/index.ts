import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  AgentRuntimeDescriptor,
  AgentTurnInput,
  DaemonDiagnostics,
} from "@netchat/shared";

import { applyCliEnvOverrides } from "./cli.js";
import { DaemonDiagnosticsStore } from "./diagnostics.js";
import { detectRuntimeEnvironment } from "./environment.js";
import { loadLocalEnv } from "./load-env.js";
import { MachineClient } from "./machine.js";
import { createRuntimeAdapter } from "./runtime.js";

applyCliEnvOverrides();
loadLocalEnv();

const app = Fastify({ logger: false });
const runtime = createRuntimeAdapter();
const runtimeDescriptor = runtime.getDescriptor();
const initialEnvironment = await detectRuntimeEnvironment(runtimeDescriptor, runtime.getWorkingDirectory());
const diagnostics = new DaemonDiagnosticsStore(initialEnvironment);
const machineClient = new MachineClient(
  runtime,
  async () => {
    const environment = await detectRuntimeEnvironment(runtimeDescriptor, runtime.getWorkingDirectory());
    diagnostics.recordEnvironment(environment);
    return environment;
  },
  diagnostics,
);
const port = Number(process.env.DAEMON_PORT ?? 4318);

diagnostics.log("info", `Daemon booting in ${runtimeDescriptor.runtimeKind} mode.`);
diagnostics.log(
  initialEnvironment.installed ? "info" : "warn",
  initialEnvironment.installed
    ? `${initialEnvironment.runtimeLabel} detected at ${initialEnvironment.executablePath ?? "built-in runtime"}.`
    : initialEnvironment.detectionError ?? `${initialEnvironment.runtimeLabel} binary not detected.`,
);

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true }));

app.get("/runtime/environment", async () => {
  const environment = await detectRuntimeEnvironment(runtimeDescriptor, runtime.getWorkingDirectory());
  diagnostics.recordEnvironment(environment);
  return environment;
});

app.get("/runtime/descriptor", async (): Promise<AgentRuntimeDescriptor> => runtimeDescriptor);

app.get("/runtime/diagnostics", async (): Promise<DaemonDiagnostics> => {
  return diagnostics.getSnapshot();
});

app.post("/runtime/turn", async (request) => {
  return runtime.executeTurn(request.body as AgentTurnInput);
});

app.post("/runtime/root-turn", async (request) => {
  const input = request.body as { prompt: string; sessionId: string | null };
  return runtime.executeTurn({
    prompt: input.prompt,
    session: input.sessionId ? { mode: "resume", handle: input.sessionId } : { mode: "new" },
    metadata: {
      netchatOperation: "root-turn",
    },
  });
});

app.post("/runtime/branch-create", async (request) => {
  const input = request.body as { prompt: string };
  return runtime.executeTurn({
    prompt: input.prompt,
    session: { mode: "new" },
    metadata: {
      netchatOperation: "branch-create",
    },
  });
});

app.post("/runtime/branch-turn", async (request) => {
  const input = request.body as { prompt: string; sessionId: string };
  return runtime.executeTurn({
    prompt: input.prompt,
    session: {
      mode: "resume",
      handle: input.sessionId,
    },
    metadata: {
      netchatOperation: "branch-turn",
    },
  });
});

await app.listen({ host: "0.0.0.0", port });
diagnostics.log("info", `Daemon HTTP server listening on port ${port}.`);

if (machineClient.hasServerUrl()) {
  void machineClient.start().catch((error) => {
    app.log.error(error, "Machine client failed to start");
    const message = error instanceof Error ? error.message : "Machine client failed to start.";
    diagnostics.recordError(message);
  });
} else {
  diagnostics.setStatus(
    "local_only",
    "NETCHAT_SERVER_URL is not configured, so this daemon will not connect to the local server.",
    "warn",
  );
}
