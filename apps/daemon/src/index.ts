import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  DaemonDiagnostics,
  ContinueBranchRuntimeRequest,
  ForkBranchRuntimeRequest,
  RootTurnRuntimeRequest,
} from "@netchat/shared";

import { applyCliEnvOverrides } from "./cli.js";
import { DaemonDiagnosticsStore } from "./diagnostics.js";
import { detectRuntimeEnvironment } from "./environment.js";
import { loadLocalEnv } from "./load-env.js";
import { MachineClient } from "./machine.js";
import { createRuntimeAdapter } from "./runtime.js";

applyCliEnvOverrides();
loadLocalEnv();

const app = Fastify({ logger: true });
const runtime = createRuntimeAdapter();
const initialEnvironment = await detectRuntimeEnvironment(runtime.getMode(), runtime.getWorkingDirectory());
const diagnostics = new DaemonDiagnosticsStore(initialEnvironment);
const machineClient = new MachineClient(
  runtime,
  async () => {
    const environment = await detectRuntimeEnvironment(runtime.getMode(), runtime.getWorkingDirectory());
    diagnostics.recordEnvironment(environment);
    return environment;
  },
  diagnostics,
);
const port = Number(process.env.DAEMON_PORT ?? 4318);

diagnostics.log("info", `Daemon booting in ${runtime.getMode()} mode.`);
diagnostics.log(
  initialEnvironment.claudeInstalled ? "info" : "warn",
  initialEnvironment.claudeInstalled
    ? `Claude detected at ${initialEnvironment.claudePath}.`
    : initialEnvironment.detectionError ?? "Claude binary not detected.",
);

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true }));

app.get("/runtime/environment", async () => {
  const environment = await detectRuntimeEnvironment(runtime.getMode(), runtime.getWorkingDirectory());
  diagnostics.recordEnvironment(environment);
  return environment;
});

app.get("/runtime/diagnostics", async (): Promise<DaemonDiagnostics> => {
  return diagnostics.getSnapshot();
});

app.post("/runtime/root-turn", async (request) => {
  return runtime.runRootTurn(request.body as RootTurnRuntimeRequest);
});

app.post("/runtime/fork-branch", async (request) => {
  return runtime.forkBranch(request.body as ForkBranchRuntimeRequest);
});

app.post("/runtime/branch-turn", async (request) => {
  return runtime.continueBranch(request.body as ContinueBranchRuntimeRequest);
});

await app.listen({ host: "0.0.0.0", port });
diagnostics.log("info", `Daemon HTTP server listening on port ${port}.`);

if (machineClient.hasServerUrl()) {
  void machineClient.start().catch((error) => {
    app.log.error(error, "Machine client failed to start");
    const message = error instanceof Error ? error.message : "Machine client failed to start.";
    if (/NETCHAT_PAIRING_CODE is required/i.test(message)) {
      return;
    }

    diagnostics.recordError(message);
  });
} else {
  diagnostics.setStatus(
    "local_only",
    "NETCHAT_SERVER_URL is not configured, so this daemon is not registering a machine with the server.",
    "warn",
  );
}
