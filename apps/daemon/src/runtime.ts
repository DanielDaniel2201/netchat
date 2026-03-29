import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CreateBranchRuntimeRequest,
  ContinueBranchRuntimeRequest,
  RootTurnRuntimeRequest,
  RuntimeResponse,
  makeId,
} from "@netchat/shared";

import { resolveClaudeBinaryPath, resolveClaudeWorkingDirectory } from "./claude-config.js";

type SessionState = {
  id: string;
  turns: string[];
};

type ClaudeCliResult = {
  errors?: string[];
  result?: string;
  session_id?: string;
  subtype?: string;
  type?: string;
};

type ClaudeStreamEvent = {
  errors?: unknown;
  result?: unknown;
  session_id?: unknown;
  subtype?: unknown;
  type?: unknown;
};

type ClaudeCliExecutionError = Error & {
  activityCount?: number;
  hadActivity?: boolean;
  killed?: boolean;
  lastActivityAtMs?: number;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
};

type ClaudeTranscriptEntry = {
  message?: {
    content?: Array<
      | {
          text?: string;
          type?: string;
        }
      | undefined
    >;
    role?: string;
  };
  sessionId?: string;
  type?: string;
};

export interface RuntimeAdapter {
  runRootTurn(input: RootTurnRuntimeRequest): Promise<RuntimeResponse>;
  createBranch(input: CreateBranchRuntimeRequest): Promise<RuntimeResponse>;
  continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse>;
  getMode(): "mock" | "claude";
  getWorkingDirectory(): string;
}

export function createRuntimeAdapter(): RuntimeAdapter {
  if (resolveRuntimeMode() === "claude") {
    return new ClaudeCliRuntime();
  }

  return new MockRuntimeAdapter();
}

class ClaudeCliRuntime implements RuntimeAdapter {
  private readonly binaryResolution = resolveClaudeBinaryPath();
  private readonly cwdResolution = resolveClaudeWorkingDirectory();
  private readonly cwd = this.cwdResolution.workingDirectory;
  private readonly binaryPath = this.binaryResolution.binaryPath;
  private readonly permissionMode = readStringEnv("NETCHAT_PERMISSION_MODE") ?? "bypassPermissions";
  private readonly allowDangerouslySkipPermissions = readBooleanEnv("NETCHAT_ALLOW_DANGEROUS", true);
  private readonly settingSources = readStringEnv("NETCHAT_SETTING_SOURCES");
  private readonly machineId = readStringEnv("NETCHAT_MACHINE_ID") ?? "machine_local";
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs();

  getMode(): "claude" {
    return "claude";
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async runRootTurn(input: RootTurnRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt("root-turn", input.prompt, {
      resume: input.sessionId ?? undefined,
    });
  }

  async createBranch(input: CreateBranchRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt("branch-create", input.prompt, {});
  }

  async continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt("branch-turn", input.prompt, {
      resume: input.sessionId,
    });
  }

  private async executePrompt(
    kind: "root-turn" | "branch-create" | "branch-turn",
    prompt: string,
    options: {
      resume?: string;
    },
  ): Promise<RuntimeResponse> {
    if (!this.binaryPath) {
      throw new Error(
        [
          "Claude binary could not be resolved.",
          ...this.binaryResolution.issues,
          "Install Claude Code or set CLAUDE_BINARY_PATH to a valid executable.",
        ].join(" "),
      );
    }

    const args = this.buildCliArgs(prompt, options);
    const startedAtMs = Date.now();

    logRuntime(
      "info",
      `Starting ${kind} via Claude CLI (cwd=${this.cwd}, resume=${options.resume ?? "new"}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
    );

    let stdout = "";
    let stderr = "";
    try {
      const result = await this.executeCli(args);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      throw this.formatExecutionError(error, {
        kind,
        startedAtMs,
        options,
      });
    }

    const parsed = this.parseStreamResult(stdout, stderr);
    if (parsed.type !== "result") {
      throw new Error(`Unexpected Claude CLI output: ${stdout.trim() || stderr.trim() || "empty output"}`);
    }

    if (parsed.subtype !== "success") {
      throw new Error(parsed.errors?.join("; ") || parsed.result || stderr.trim() || "Claude CLI execution failed.");
    }

    const sessionId = parsed.session_id?.trim();
    if (!sessionId) {
      throw new Error("Claude CLI completed without returning a session id.");
    }

    const assistantMessage =
      parsed.result?.trim() || this.readAssistantMessageFromTranscript(sessionId) || stdout.trim();
    if (!assistantMessage) {
      throw new Error("Claude CLI completed, but no assistant message was available in stdout or transcript.");
    }

    logRuntime(
      "info",
      `Claude CLI finished ${kind} in ${formatDuration(Date.now() - startedAtMs)} with session ${sessionId}.`,
    );

    return {
      assistantMessage,
      machineId: this.machineId,
      sessionId,
    };
  }

  private buildCliArgs(
    prompt: string,
    options: {
      resume?: string;
    },
  ) {
    const args = ["-p", "--verbose", "--output-format", "stream-json"];

    if (this.settingSources) {
      args.push("--setting-sources", this.settingSources);
    }

    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }

    if (this.permissionMode === "bypassPermissions" && this.allowDangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if (options.resume) {
      args.push("--resume", options.resume);
    }

    args.push(prompt);
    return args;
  }

  private executeCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (!this.binaryPath) {
      throw new Error("Claude binary path is required.");
    }

    const binaryPath = this.binaryPath;

    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
      });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let hadActivity = false;
      let activityCount = 0;
      let lastActivityAtMs = Date.now();
      const maxBufferBytes = 8 * 1024 * 1024;
      let timeout: NodeJS.Timeout | null = null;

      const armTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, this.activityTimeoutMs);
      };

      const noteActivity = () => {
        hadActivity = true;
        activityCount += 1;
        lastActivityAtMs = Date.now();
        armTimeout();
      };

      armTimeout();

      const fail = (error: ClaudeCliExecutionError) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }

        error.stdout = stdout;
        error.stderr = stderr;
        error.hadActivity = hadActivity;
        error.activityCount = activityCount;
        error.lastActivityAtMs = lastActivityAtMs;
        reject(error);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        noteActivity();
        if (Buffer.byteLength(stdout, "utf8") > maxBufferBytes) {
          const error = new Error("Claude CLI stdout exceeded the maximum buffer size.") as ClaudeCliExecutionError;
          child.kill();
          fail(error);
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        noteActivity();
        if (Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
          const error = new Error("Claude CLI stderr exceeded the maximum buffer size.") as ClaudeCliExecutionError;
          child.kill();
          fail(error);
        }
      });

      child.on("error", (error) => {
        fail(error as ClaudeCliExecutionError);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }

        if (timedOut) {
          const error = new Error("Claude CLI execution timed out.") as ClaudeCliExecutionError;
          error.stdout = stdout;
          error.stderr = stderr;
          error.killed = true;
          error.signal = signal;
          error.timedOut = true;
          error.hadActivity = hadActivity;
          error.activityCount = activityCount;
          error.lastActivityAtMs = lastActivityAtMs;
          reject(error);
          return;
        }

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(
          `Claude CLI exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}.`,
        ) as ClaudeCliExecutionError;
        error.stdout = stdout;
        error.stderr = stderr;
        error.signal = signal;
        reject(error);
      });
    });
  }

  private parseStreamResult(stdout: string, stderr: string): ClaudeCliResult {
    const output = stdout.trim();
    if (!output) {
      throw new Error(stderr.trim() || "Claude CLI returned empty stdout.");
    }

    const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let latestSessionId = "";
    let resultEvent: ClaudeCliResult | null = null;

    for (const line of lines) {
      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(line) as ClaudeStreamEvent;
      } catch {
        throw new Error(`Claude CLI returned non-JSON stream output: ${line}`);
      }

      if (typeof event.session_id === "string" && event.session_id.trim().length > 0) {
        latestSessionId = event.session_id.trim();
      }

      if (event.type !== "result") {
        continue;
      }

      resultEvent = {
        errors: Array.isArray(event.errors)
          ? event.errors.filter((value): value is string => typeof value === "string")
          : undefined,
        result: typeof event.result === "string" ? event.result : undefined,
        session_id: typeof event.session_id === "string" ? event.session_id : latestSessionId || undefined,
        subtype: typeof event.subtype === "string" ? event.subtype : undefined,
        type: event.type,
      };
    }

    if (!resultEvent) {
      throw new Error(`Claude CLI stream output did not contain a result event: ${output}`);
    }

    if (!resultEvent.session_id && latestSessionId) {
      resultEvent.session_id = latestSessionId;
    }

    return resultEvent;
  }

  private formatExecutionError(
    error: unknown,
    context: {
      kind: "root-turn" | "branch-create" | "branch-turn";
      startedAtMs: number;
      options: {
        resume?: string;
      };
    },
  ) {
    const duration = formatDuration(Date.now() - context.startedAtMs);
    const execError = error as NodeJS.ErrnoException & ClaudeCliExecutionError;
    const stderr = execError.stderr?.trim();
    const stdout = execError.stdout?.trim();
    const didTimeout =
      Boolean(execError.timedOut) ||
      Boolean(execError.killed && execError.signal) ||
      /timed out/i.test(execError.message ?? "");

    const message = didTimeout
      ? [
          `Claude CLI stopped making progress for ${formatDuration(this.activityTimeoutMs)} while running ${context.kind}.`,
          execError.hadActivity
            ? `Claude CLI emitted ${execError.activityCount ?? 0} stdout/stderr chunk(s) before going idle, so this was not a final-answer-only timeout.`
            : "Claude CLI did not emit any stdout/stderr activity before the inactivity timeout expired.",
          `The daemon now tracks streamed CLI activity instead of waiting only for a final answer.`,
          `Try running \`${this.binaryPath} -p --verbose --output-format stream-json "Reply with exactly: ping"\` manually from ${this.cwd} to verify the local Claude Code runtime.`,
        ].join(" ")
      : [
          `Claude CLI failed during ${context.kind} after ${duration}.`,
          execError.message?.trim() || "Unknown Claude CLI error.",
          stderr || stdout || "",
        ]
          .join(" ")
          .trim();

    logRuntime(
      didTimeout ? "error" : "warn",
      `${message} (resume=${context.options.resume ?? "new"}).`,
    );

    return new Error(message);
  }

  private readAssistantMessageFromTranscript(sessionId: string): string {
    const transcriptPath = this.resolveTranscriptPath(sessionId);
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return "";
    }

    const content = readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let latestMessage = "";

    for (const line of lines) {
      let entry: ClaudeTranscriptEntry;
      try {
        entry = JSON.parse(line) as ClaudeTranscriptEntry;
      } catch {
        continue;
      }

      if (entry.sessionId !== sessionId || entry.type !== "assistant" || entry.message?.role !== "assistant") {
        continue;
      }

      const text = (entry.message.content ?? [])
        .filter((item): item is { text?: string; type?: string } => Boolean(item))
        .filter((item) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)
        .map((item) => item.text!.trim())
        .join("\n\n");

      if (text) {
        latestMessage = text;
      }
    }

    return latestMessage;
  }

  private resolveTranscriptPath(sessionId: string): string | null {
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const directPath = path.join(projectsRoot, sanitizeProjectPath(this.cwd), `${sessionId}.jsonl`);
    if (existsSync(directPath)) {
      return directPath;
    }

    const projectDir = path.join(projectsRoot, sanitizeProjectPath(this.cwd));
    if (!existsSync(projectDir)) {
      return null;
    }

    const fallbackPath = path.join(projectDir, `${sessionId}.jsonl`);
    return existsSync(fallbackPath) ? fallbackPath : null;
  }

  private describeCliConfig() {
    const parts = [
      this.settingSources ? `setting-sources=${this.settingSources}` : "setting-sources=claude-default",
      this.permissionMode ? `permission-mode=${this.permissionMode}` : "permission-mode=claude-default",
    ];

    if (this.allowDangerouslySkipPermissions) {
      parts.push("dangerously-skip-permissions=true");
    }

    return parts.join(", ");
  }
}

class MockRuntimeAdapter implements RuntimeAdapter {
  private sessions = new Map<string, SessionState>();
  private readonly cwd = process.env.CLAUDE_PROJECT_CWD ?? process.cwd();
  private readonly machineId = process.env.NETCHAT_MACHINE_ID?.trim() || "machine_local";

  getMode(): "mock" {
    return "mock";
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async runRootTurn(input: RootTurnRuntimeRequest): Promise<RuntimeResponse> {
    const session = this.ensureSession(input.sessionId);
    session.turns.push(input.prompt);

    return {
      machineId: this.machineId,
      sessionId: session.id,
      assistantMessage: [
        "Mock Claude runtime",
        `Session: ${session.id}`,
        "",
        `You asked: ${input.prompt}`,
        "",
        "This is the place where the real local Claude CLI root turn will run.",
      ].join("\n"),
    };
  }

  async createBranch(input: CreateBranchRuntimeRequest): Promise<RuntimeResponse> {
    const session = this.ensureSession(null);
    session.turns.push(input.prompt);

    return {
      machineId: this.machineId,
      sessionId: session.id,
      assistantMessage: [
        "Mock replay-backed branch",
        `Session: ${session.id}`,
        "",
        "The branch started in a fresh session with a replay prompt built from the visible path only.",
        "",
        `Prompt:\n${input.prompt}`,
      ].join("\n"),
    };
  }

  async continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse> {
    const session = this.ensureSession(input.sessionId);
    session.turns.push(input.prompt);

    return {
      machineId: this.machineId,
      sessionId: session.id,
      assistantMessage: [
        "Mock branch continuation",
        `Session: ${session.id}`,
        `Turn count: ${session.turns.length}`,
        "",
        `Follow-up:\n${input.prompt}`,
      ].join("\n"),
    };
  }

  private ensureSession(sessionId: string | null): SessionState {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        return existing;
      }
    }

    const created: SessionState = {
      id: sessionId ?? makeId("session"),
      turns: [],
    };
    this.sessions.set(created.id, created);
    return created;
  }
}

function sanitizeProjectPath(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "-");
}

function resolveRuntimeMode(): "mock" | "claude" {
  const value = readStringEnv("NETCHAT_RUNTIME");
  if (value === "mock") {
    return "mock";
  }

  return "claude";
}

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readBooleanEnv(name: string, defaultValue = false) {
  const value = readStringEnv(name);
  if (value === null) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

function resolveRuntimeTimeoutMs() {
  const rawValue = Number(process.env.NETCHAT_RUNTIME_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return 60000;
  }

  return rawValue;
}

function logRuntime(level: "info" | "warn" | "error", message: string) {
  const color =
    level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : "\x1b[37m";
  const formatted = `${color}[netchat-daemon][runtime][${level}] ${message}\x1b[0m`;
  if (level === "error") {
    console.error(formatted);
    return;
  }

  if (level === "warn") {
    console.warn(formatted);
    return;
  }

  console.info(formatted);
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${(seconds / 60).toFixed(1)}m`;
}
