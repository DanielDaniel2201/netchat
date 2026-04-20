import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentRuntimeDescriptor,
  AgentRuntimeKind,
  AgentTurnEvent,
  AgentTurnInput,
  AgentTurnResult,
  makeId,
} from "@netchat/shared";

import {
  resolveBinaryInvocation,
  resolveRuntimeBinaryPath,
  resolveRuntimeKind,
  resolveRuntimeLabel,
  readRuntimeVersion,
  resolveRuntimeWorkingDirectory,
} from "./runtime-config.js";

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
  event?: ClaudeRawMessageStreamEvent;
  message?: ClaudeSdkMessagePayload;
  sessionId?: unknown;
  session_id?: unknown;
  result?: unknown;
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

type AgentRuntimeExecutionOptions = {
  onEvent?: (event: AgentTurnEvent) => void;
};

type RuntimeLogSink = (level: "info" | "warn" | "error", message: string) => void;

type ClaudeSdkMessagePayload = {
  content?: ClaudeMessageContentBlock[];
  id?: string;
  role?: string;
  stop_reason?: string | null;
  type?: string;
};

type ClaudeMessageContentBlock =
  | {
      type?: "text";
      text?: string;
    }
  | {
      signature?: string;
      thinking?: string;
      type?: "thinking" | "redacted_thinking";
    }
  | {
      id?: string;
      input?: unknown;
      name?: string;
      type?: "tool_use";
    }
  | {
      content?: unknown;
      is_error?: boolean;
      tool_use_id?: string;
      type?: "tool_result";
    };

type ClaudeRawMessageStreamEvent =
  | {
      content_block: {
        id?: string;
        input?: unknown;
        name?: string;
        text?: string;
        thinking?: string;
        type?: string;
      };
      index: number;
      type: "content_block_start";
    }
  | {
      delta: {
        partial_json?: string;
        text?: string;
        thinking?: string;
        type?: string;
      };
      index: number;
      type: "content_block_delta";
    }
  | {
      index: number;
      type: "content_block_stop";
    }
  | {
      message?: {
        id?: string;
      };
      type: "message_start" | "message_delta" | "message_stop";
    };

type ThinkingBlockState = {
  kind: "thinking";
  order: number;
  text: string;
};

type ToolBlockState = {
  kind: "tool";
  inputText: string;
  order: number;
  outputText: string;
  toolCallId: string;
  toolName: string;
};

type StreamState = {
  blockOrder: number;
  blocksById: Map<string, ThinkingBlockState | ToolBlockState>;
  blockIdByIndex: Map<string, string>;
  responseText: string;
  streamMessageOrdinal: number;
};

type CodexJsonEvent = {
  item?: CodexItemPayload;
  thread_id?: unknown;
  type?: unknown;
};

type CodexItemPayload =
  | {
      id?: string;
      type?: "agent_message";
      text?: string;
    }
  | {
      aggregated_output?: string;
      command?: string;
      exit_code?: number | null;
      id?: string;
      status?: "in_progress" | "completed" | "failed";
      type?: "command_execution";
    }
  | {
      id?: string;
      summary?: string;
      text?: string;
      type?: string;
    };

type CodexStreamState = {
  blockOrder: number;
  commandBlocksById: Map<string, ToolBlockState>;
  responseText: string;
  responseWasCompleted: boolean;
  threadId: string | null;
  thinkingBlocksById: Map<string, ThinkingBlockState>;
};

type CodexAppServerPendingRequest = {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexAppServerState = {
  child: ReturnType<typeof spawn>;
  pending: Map<string, CodexAppServerPendingRequest>;
  nextRequestId: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  startedAtMs: number;
};

type CodexActiveTurnState = {
  threadId: string;
  turnId: string | null;
  onEvent?: (event: AgentTurnEvent) => void;
  responseText: string;
  responseCompleted: boolean;
  responseTextsByItemId: Map<string, string>;
  assistantMessageBlocksById: Map<string, { order: number; text: string }>;
  commandBlocksById: Map<string, ToolBlockState>;
  thinkingBlocksById: Map<string, ThinkingBlockState>;
  blockOrder: number;
  completionTimer: NodeJS.Timeout | null;
  resolve: (value: { outputText: string }) => void;
  reject: (error: Error) => void;
};

type DroidStreamEvent =
  | {
      session_id?: unknown;
      subtype?: unknown;
      type?: "system";
    }
  | {
      id?: string;
      role?: "assistant" | "user";
      session_id?: unknown;
      text?: string;
      type?: "message";
    }
  | {
      id?: string;
      parameters?: unknown;
      session_id?: unknown;
      toolId?: string;
      toolName?: string;
      type?: "tool_call";
    }
  | {
      id?: string;
      isError?: boolean;
      session_id?: unknown;
      toolId?: string;
      type?: "tool_result";
      value?: unknown;
    }
  | {
      finalText?: string;
      session_id?: unknown;
      type?: "completion";
    };

type DroidStreamState = {
  blockOrder: number;
  responseText: string;
  responseWasCompleted: boolean;
  sessionId: string | null;
  toolBlocksById: Map<string, ToolBlockState>;
};

export interface AgentRuntimeAdapter {
  getDescriptor(): AgentRuntimeDescriptor;
  getWorkingDirectory(): string;
  executeTurn(input: AgentTurnInput, options?: AgentRuntimeExecutionOptions): Promise<AgentTurnResult>;
}

let runtimeLogSink: RuntimeLogSink | null = null;

export function setRuntimeLogSink(sink: RuntimeLogSink | null) {
  runtimeLogSink = sink;
}

export function createRuntimeAdapter(): AgentRuntimeAdapter {
  const runtimeKind = resolveRuntimeKind();
  switch (runtimeKind) {
    case "claude":
      return new ClaudeCliRuntime();
    case "codex":
      return new CodexCliRuntime();
    case "droid":
      return new DroidCliRuntime();
    case "mock":
      return new MockRuntimeAdapter();
    default:
      throw new Error(
        `NETCHAT_RUNTIME=${runtimeKind} is not implemented yet. Supported runtimes: claude, codex, droid, mock.`,
      );
  }
}

class ClaudeCliRuntime implements AgentRuntimeAdapter {
  private readonly descriptor = createRuntimeDescriptor("claude");
  private readonly binaryResolution = resolveRuntimeBinaryPath("claude");
  private readonly cwdResolution = resolveRuntimeWorkingDirectory();
  private readonly cwd = this.cwdResolution.workingDirectory;
  private readonly binaryPath = this.binaryResolution.binaryPath;
  private readonly permissionMode = readStringEnv("NETCHAT_PERMISSION_MODE") ?? "bypassPermissions";
  private readonly allowDangerouslySkipPermissions = readBooleanEnv("NETCHAT_ALLOW_DANGEROUS", true);
  private readonly settingSources = readStringEnv("NETCHAT_SETTING_SOURCES");
  private readonly machineId = readStringEnv("NETCHAT_MACHINE_ID") ?? "machine_local";
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs("claude");

  getDescriptor(): AgentRuntimeDescriptor {
    return this.descriptor;
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async executeTurn(
    input: AgentTurnInput,
    options?: AgentRuntimeExecutionOptions,
  ): Promise<AgentTurnResult> {
    return this.executePrompt(input, options);
  }

  private async executePrompt(input: AgentTurnInput, options?: AgentRuntimeExecutionOptions): Promise<AgentTurnResult> {
    if (!this.binaryPath) {
      throw new Error(
        [
          "Claude binary could not be resolved.",
          ...this.binaryResolution.issues,
          "Install Claude Code or set CLAUDE_BINARY_PATH to a valid executable.",
        ].join(" "),
      );
    }

    const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);
    const args = this.buildCliArgs(input);
    const startedAtMs = Date.now();
    const kind = input.metadata?.netchatOperation ?? (input.session.mode === "resume" ? "branch-turn" : "root-turn");
    const resumeHandle = input.session.mode === "resume" ? input.session.handle : undefined;
    const sessionLabel =
      input.session.mode === "resume"
        ? input.metadata?.forkSession
          ? `fork:${input.session.handle}`
          : input.session.handle
        : "new";

    logRuntime(
      "info",
      `Starting ${kind} via Claude CLI (cwd=${workingDirectory}, session=${sessionLabel}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
    );

    let stdout = "";
    let stderr = "";
    try {
      const liveState = createStreamState();
      const result = await this.executeCli(args, (line) => {
        this.handleStreamLine(line, liveState, options?.onEvent);
      }, workingDirectory);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      throw this.formatExecutionError(error, {
        kind,
        startedAtMs,
        resumeHandle,
        workingDirectory,
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

    const outputText =
      parsed.result?.trim() || this.readAssistantMessageFromTranscript(sessionId, workingDirectory) || stdout.trim();
    if (!outputText) {
      throw new Error("Claude CLI completed, but no assistant message was available in stdout or transcript.");
    }

    logRuntime(
      "info",
      `Claude CLI finished ${kind} in ${formatDuration(Date.now() - startedAtMs)} with session ${sessionId}.`,
    );

    return {
      handle: sessionId,
      machineId: this.machineId,
      outputText,
      runtimeId: this.descriptor.runtimeId,
      runtimeKind: this.descriptor.runtimeKind,
    };
  }

  private buildCliArgs(input: AgentTurnInput) {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];

    if (this.settingSources) {
      args.push("--setting-sources", this.settingSources);
    }

    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }

    if (this.permissionMode === "bypassPermissions" && this.allowDangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if (input.session.mode === "resume") {
      args.push("--resume", input.session.handle);
      if (input.metadata?.forkSession) {
        args.push("--fork-session");
      }
    }

    args.push(input.prompt);
    return args;
  }

  private executeCli(
    args: string[],
    onStdoutLine?: (line: string) => void,
    workingDirectory = this.cwd,
  ): Promise<{ stdout: string; stderr: string }> {
    if (!this.binaryPath) {
      throw new Error("Claude binary path is required.");
    }

    const binaryPath = this.binaryPath;
    const invocation = resolveBinaryInvocation(binaryPath, args);

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: workingDirectory,
        env: createRuntimeProcessEnv(workingDirectory),
        windowsHide: true,
      });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
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
        stdoutLineBuffer += chunk;
        noteActivity();
        flushStdoutLines();
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

        flushStdoutLines(true);

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

      function flushStdoutLines(flushTail = false) {
        let newlineIndex = stdoutLineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
          if (line) {
            onStdoutLine?.(line);
          }

          newlineIndex = stdoutLineBuffer.indexOf("\n");
        }

        if (flushTail) {
          const tail = stdoutLineBuffer.trim();
          stdoutLineBuffer = "";
          if (tail) {
            onStdoutLine?.(tail);
          }
        }
      }
    });
  }

  private handleStreamLine(
    line: string,
    state: StreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    let message: ClaudeStreamEvent;
    try {
      message = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return;
    }

    if (message.type === "stream_event" && message.event) {
      this.handleRawStreamEvent(message.event, state, onEvent);
      return;
    }

    if (message.type === "assistant" && message.message) {
      this.handleAssistantMessage(message.message, state, onEvent);
      return;
    }

    if (message.type === "user" && message.message) {
      this.handleUserMessage(message.message, state, onEvent);
      return;
    }

    if (message.type === "result" && typeof message.result === "string" && message.result.length > 0) {
      onEvent?.({
        type: "response.update",
        text: message.result,
        isComplete: true,
      });
    }
  }

  private handleRawStreamEvent(
    event: ClaudeRawMessageStreamEvent,
    state: StreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    if (event.type === "message_start") {
      state.streamMessageOrdinal += 1;
      return;
    }

    if (event.type === "message_delta" || event.type === "message_stop") {
      return;
    }

    if (event.type === "content_block_start") {
      const block = event.content_block;
      const indexKey = makeStreamIndexKey(state, event.index);
      if (block.type === "text") {
        state.blockIdByIndex.set(indexKey, "response");
        return;
      }

      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const blockId = `thinking_${state.streamMessageOrdinal}_${event.index}`;
        const thinkingText = block.type === "thinking" ? block.thinking ?? "" : "";
        state.blockIdByIndex.set(indexKey, blockId);
        state.blocksById.set(blockId, {
          kind: "thinking",
          order: nextBlockOrder(state),
          text: thinkingText,
        });
        emitThinkingUpdate(state, blockId, false, onEvent);
        return;
      }

      if (block.type === "tool_use") {
        const toolCallId =
          typeof block.id === "string" && block.id.trim().length > 0
            ? block.id
            : `tool_${state.streamMessageOrdinal}_${event.index}`;
        const blockId = toolCallId;
        state.blockIdByIndex.set(indexKey, blockId);
        state.blocksById.set(blockId, {
          kind: "tool",
          inputText: formatStructuredBlock(block.input),
          order: nextBlockOrder(state),
          outputText: "",
          toolCallId,
          toolName: block.name?.trim() || "Tool",
        });
        emitToolUpdate(state, blockId, false, false, onEvent);
        return;
      }

      return;
    }

    if (event.type === "content_block_delta") {
      const blockId = state.blockIdByIndex.get(makeStreamIndexKey(state, event.index));
      if (!blockId) {
        return;
      }

      if (blockId === "response") {
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          state.responseText += event.delta.text;
          onEvent?.({
            type: "response.update",
            text: state.responseText,
            isComplete: false,
          });
        }

        return;
      }

      const block = state.blocksById.get(blockId);
      if (!block) {
        return;
      }

      if (block.kind === "thinking") {
        if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
          block.text += event.delta.thinking;
          emitThinkingUpdate(state, blockId, false, onEvent);
        }

        return;
      }

      if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        block.inputText += event.delta.partial_json;
        emitToolUpdate(state, blockId, false, false, onEvent);
        return;
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const indexKey = makeStreamIndexKey(state, event.index);
      const blockId = state.blockIdByIndex.get(indexKey);
      if (!blockId) {
        return;
      }

      if (blockId === "response") {
        return;
      }

      const block = state.blocksById.get(blockId);
      if (!block) {
        return;
      }

      if (block.kind === "thinking") {
        emitThinkingUpdate(state, blockId, true, onEvent);
      } else {
        emitToolUpdate(state, blockId, false, false, onEvent);
      }

      state.blockIdByIndex.delete(indexKey);
    }
  }

  private handleAssistantMessage(
    message: ClaudeSdkMessagePayload,
    state: StreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    for (const block of message.content ?? []) {
      if (block.type === "thinking") {
        const blockId = `thinking_${state.blockOrder + 1}`;
        const existingId = Array.from(state.blocksById.entries()).find(
          ([, candidate]) => candidate.kind === "thinking" && candidate.text === (block.thinking ?? ""),
        )?.[0];
        const targetId = existingId ?? blockId;
        if (!state.blocksById.has(targetId)) {
          state.blocksById.set(targetId, {
            kind: "thinking",
            order: nextBlockOrder(state),
            text: block.thinking ?? "",
          });
        } else {
          const existing = state.blocksById.get(targetId);
          if (existing?.kind === "thinking") {
            existing.text = block.thinking ?? existing.text;
          }
        }

        emitThinkingUpdate(state, targetId, true, onEvent);
        continue;
      }

      if (block.type === "tool_use") {
        const blockId = block.id?.trim() || `tool_${state.blockOrder + 1}`;
        if (!state.blocksById.has(blockId)) {
          state.blocksById.set(blockId, {
            kind: "tool",
            inputText: formatStructuredBlock(block.input),
            order: nextBlockOrder(state),
            outputText: "",
            toolCallId: block.id?.trim() || blockId,
            toolName: block.name?.trim() || "Tool",
          });
        } else {
          const existing = state.blocksById.get(blockId);
          if (existing?.kind === "tool") {
            existing.inputText = formatStructuredBlock(block.input) || existing.inputText;
            existing.toolName = block.name?.trim() || existing.toolName;
          }
        }

        emitToolUpdate(state, blockId, false, false, onEvent);
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.length >= state.responseText.length) {
          state.responseText = block.text;
          onEvent?.({
            type: "response.update",
            text: state.responseText,
            isComplete: false,
          });
        }
      }
    }
  }

  private handleUserMessage(
    message: ClaudeSdkMessagePayload,
    state: StreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    for (const block of message.content ?? []) {
      if (block.type !== "tool_result") {
        continue;
      }

      const toolCallId = block.tool_use_id?.trim();
      if (!toolCallId) {
        continue;
      }

      const existing = state.blocksById.get(toolCallId);
      if (!existing || existing.kind !== "tool") {
        continue;
      }

      existing.outputText = formatToolResultContent(block.content);
      emitToolUpdate(state, toolCallId, true, Boolean(block.is_error), onEvent);
    }
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
      resumeHandle?: string;
      workingDirectory: string;
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
          `Try running \`${this.binaryPath} -p --verbose --output-format stream-json "Reply with exactly: ping"\` manually from ${context.workingDirectory} to verify the local Claude Code runtime.`,
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
      `${message} (resume=${context.resumeHandle ?? "new"}).`,
    );

    return new Error(message);
  }

  private readAssistantMessageFromTranscript(sessionId: string, workingDirectory: string): string {
    const transcriptPath = this.resolveTranscriptPath(sessionId, workingDirectory);
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

  private resolveTranscriptPath(sessionId: string, workingDirectory: string): string | null {
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const directPath = path.join(projectsRoot, sanitizeProjectPath(workingDirectory), `${sessionId}.jsonl`);
    if (existsSync(directPath)) {
      return directPath;
    }

    const projectDir = path.join(projectsRoot, sanitizeProjectPath(workingDirectory));
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

class CodexCliRuntime implements AgentRuntimeAdapter {
  private readonly descriptor = createRuntimeDescriptor("codex");
  private readonly binaryResolution = resolveRuntimeBinaryPath("codex");
  private readonly cwdResolution = resolveRuntimeWorkingDirectory();
  private readonly cwd = this.cwdResolution.workingDirectory;
  private readonly binaryPath = this.binaryResolution.binaryPath;
  private readonly machineId = readStringEnv("NETCHAT_MACHINE_ID") ?? "machine_local";
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs("codex");
  private readonly model = readStringEnv("NETCHAT_CODEX_MODEL");
  private readonly profile = readStringEnv("NETCHAT_CODEX_PROFILE");
  private readonly addDirs = readListEnv("NETCHAT_CODEX_ADD_DIRS");
  private readonly fullAuto = readBooleanEnv("NETCHAT_CODEX_FULL_AUTO", true);
  private readonly bypassApprovalsAndSandbox = readBooleanEnv("NETCHAT_CODEX_BYPASS", true);
  private readonly skipGitRepoCheck = readBooleanEnv("NETCHAT_CODEX_SKIP_GIT_REPO_CHECK", false);
  private readonly minimumCodexVersion = "0.37.0";
  private readonly appServerClientName = readStringEnv("NETCHAT_CODEX_APP_CLIENT_NAME") ?? "netchat_daemon";
  private readonly appServerClientTitle = readStringEnv("NETCHAT_CODEX_APP_CLIENT_TITLE") ?? "Netchat Daemon";
  private readonly appServerClientVersion = readStringEnv("NETCHAT_CODEX_APP_CLIENT_VERSION") ?? "0.0.1";
  private readonly requestTimeoutMs = 20_000;
  private executionQueue = Promise.resolve();
  private appServer: CodexAppServerState | null = null;
  private activeTurn: CodexActiveTurnState | null = null;

  private appServerLog(message: string) {
    return `(Codex appServer) ${message}`;
  }

  getDescriptor(): AgentRuntimeDescriptor {
    return this.descriptor;
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async executeTurn(
    input: AgentTurnInput,
    options?: AgentRuntimeExecutionOptions,
  ): Promise<AgentTurnResult> {
    const enqueueExecution = async <T>(operation: () => Promise<T>) => {
      const next = this.executionQueue.then(operation, operation);
      this.executionQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    return enqueueExecution(async () => {
      this.assertCodexVersionSupport();

      const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);
      const kind = input.metadata?.netchatOperation ?? (input.session.mode === "resume" ? "branch-turn" : "root-turn");

      logRuntime(
        "info",
        this.appServerLog(
          `Starting ${kind} (cwd=${workingDirectory}, session=${input.session.mode === "resume" ? input.session.handle : "new"}, fork=${input.metadata?.forkSession ? "true" : "false"}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
        ),
      );

      const threadId = await this.openThread(input, workingDirectory);
      const turn = await this.startTurn({
        threadId,
        prompt: input.prompt,
        onEvent: options?.onEvent,
      });

      logRuntime(
        "info",
        this.appServerLog(`Finished ${kind} with thread ${threadId}.`),
      );

      return {
        handle: threadId,
        machineId: this.machineId,
        outputText: turn.outputText,
        runtimeId: this.descriptor.runtimeId,
        runtimeKind: this.descriptor.runtimeKind,
      };
    });
  }

  private async ensureAppServer() {
    if (!this.binaryPath) {
      throw new Error("Codex binary path is required.");
    }

    if (this.appServer && !this.appServer.child.killed) {
      return this.appServer;
    }

    const invocation = resolveBinaryInvocation(this.binaryPath, ["app-server"]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: createRuntimeProcessEnv(this.cwd),
      windowsHide: true,
    });

    const appServer = {
      child,
      pending: new Map<string, {
        method: string;
        timeout: NodeJS.Timeout;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }>(),
      nextRequestId: 1,
      stdoutBuffer: "",
      stderrBuffer: "",
      startedAtMs: Date.now(),
    };
    this.appServer = appServer;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      appServer.stdoutBuffer += chunk;
      this.flushStdoutBuffer(appServer);
    });

    child.stderr.on("data", (chunk: string) => {
      appServer.stderrBuffer += chunk;
      this.flushStderrBuffer(appServer);
    });

    const handleExit = (reason: string) => {
      const pending = Array.from(appServer.pending.values());
      appServer.pending.clear();
      for (const request of pending) {
        clearTimeout(request.timeout);
        request.reject(new Error(reason));
      }

      if (this.activeTurn) {
        this.clearActiveTurnTimer(this.activeTurn);
        this.activeTurn.reject(new Error(reason));
        this.activeTurn = null;
      }

      if (this.appServer === appServer) {
        this.appServer = null;
      }
    };

    child.on("error", (error) => {
      handleExit(this.appServerLog(`Process error: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      handleExit(this.appServerLog(`Exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}.`));
    });

    await this.sendAppServerRequest("initialize", {
      clientInfo: {
        name: this.appServerClientName,
        title: this.appServerClientTitle,
        version: this.appServerClientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.writeAppServerMessage({ method: "initialized" });

    return appServer;
  }

  private flushStdoutBuffer(appServer: CodexAppServerState) {
    let newlineIndex = appServer.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = appServer.stdoutBuffer.slice(0, newlineIndex).trim();
      appServer.stdoutBuffer = appServer.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleAppServerLine(line);
      }
      newlineIndex = appServer.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStderrBuffer(appServer: CodexAppServerState) {
    let newlineIndex = appServer.stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = appServer.stderrBuffer.slice(0, newlineIndex).trim();
      appServer.stderrBuffer = appServer.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        logRuntime("warn", this.appServerLog(`stderr: ${line}`));
      }
      newlineIndex = appServer.stderrBuffer.indexOf("\n");
    }
  }

  private handleAppServerLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      this.handleServerNotification(message);
      return;
    }

    if (typeof message.id === "string" || typeof message.id === "number") {
      this.handleAppServerResponse(message);
    }
  }

  private handleAppServerResponse(response: Record<string, unknown>) {
    const appServer = this.appServer;
    if (!appServer) {
      return;
    }

    const key = String(response.id);
    const pending = appServer.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    appServer.pending.delete(key);

    const errorObject = response.error;
    if (errorObject && typeof errorObject === "object") {
      const message = typeof (errorObject as { message?: unknown }).message === "string"
        ? (errorObject as { message: string }).message
        : "Unknown Codex app-server error";
      pending.reject(new Error(this.appServerLog(`${pending.method} failed: ${message}`)));
      return;
    }

    pending.resolve(response.result);
  }

  private handleServerRequest(request: Record<string, unknown>) {
    const id = request.id;
    const method = typeof request.method === "string" ? request.method : "";
    if (!(typeof id === "string" || typeof id === "number") || !method) {
      return;
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/fileRead/requestApproval"
    ) {
      this.writeAppServerMessage({
        id,
        result: {
          decision: this.bypassApprovalsAndSandbox ? "accept" : "decline",
        },
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      this.writeAppServerMessage({
        id,
        error: {
          code: -32601,
          message: "request_user_input is not supported in netchat daemon runtime.",
        },
      });
      return;
    }

    this.writeAppServerMessage({
      id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${method}`,
      },
    });
  }

  private handleServerNotification(notification: Record<string, unknown>) {
    const method = typeof notification.method === "string" ? notification.method : "";
    const params = notification.params;
    if (!method || !this.activeTurn) {
      return;
    }

    const activeTurn = this.activeTurn;
    const threadId = this.readThreadId(params);
    if (threadId && threadId !== activeTurn.threadId) {
      return;
    }

    const notificationTurnId = this.readNotificationTurnId(params);
    if (activeTurn.turnId && notificationTurnId && notificationTurnId !== activeTurn.turnId) {
      return;
    }

    this.bumpActiveTurnTimer(activeTurn);

    if (method === "item/agentMessage/delta") {
      const delta = this.readString(params, "delta") ?? this.readStructuredCodexDelta(params) ?? "";
      if (!delta) {
        return;
      }

      const itemId = this.readResponseItemId(params);
      const nextText = `${activeTurn.responseTextsByItemId.get(itemId) ?? ""}${delta}`;
      activeTurn.responseTextsByItemId.set(itemId, nextText);
      activeTurn.responseText = nextText;
      activeTurn.onEvent?.({
        type: "response.update",
        text: nextText,
        isComplete: false,
      });
      return;
    }

    if (
      method === "item/reasoning/textDelta" ||
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/plan/delta"
    ) {
      this.handleThinkingDeltaNotification(activeTurn, method, params);
      return;
    }

    if (method === "turn/plan/updated") {
      this.handlePlanUpdatedNotification(activeTurn, params);
      return;
    }

    if (method === "codex/event/agent_reasoning" || method === "codex/event/reasoning_content_delta") {
      this.handleStructuredReasoningNotification(activeTurn, method, params);
      return;
    }

    if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      this.handleThreadItemNotification(activeTurn, method, params);
      return;
    }

    if (method === "turn/started") {
      const turn = this.readObject(params, "turn");
      const turnId = this.readString(turn, "id");
      if (turnId) {
        activeTurn.turnId = turnId;
      }
      return;
    }

    if (method === "error") {
      const errorRecord = this.readObject(params, "error");
      const message = this.readString(errorRecord, "message") ?? "Codex app-server turn failed.";
      const willRetry = this.readValue(params, "willRetry") === true;
      if (willRetry) {
        logRuntime("warn", this.appServerLog(`Retryable turn error: ${message}`));
        return;
      }

      this.clearActiveTurnTimer(activeTurn);
      activeTurn.reject(new Error(message));
      this.activeTurn = null;
      return;
    }

    if (method === "turn/completed") {
      const turn = this.readObject(params, "turn");
      const status = this.readString(turn, "status")?.toLowerCase() ?? "";
      const turnError = this.readObject(turn, "error");
      const turnErrorMessage = this.readString(turnError, "message")?.trim();
      if (status === "failed" || status === "interrupted") {
        this.clearActiveTurnTimer(activeTurn);
        activeTurn.reject(new Error(turnErrorMessage || "Codex app-server turn failed."));
        this.activeTurn = null;
        return;
      }

      const finalMessage = this.readFinalAgentMessageFromTurn(turn) || activeTurn.responseText.trim();
      if (!finalMessage) {
        this.clearActiveTurnTimer(activeTurn);
        activeTurn.reject(new Error("Codex app-server completed turn without an assistant message."));
        this.activeTurn = null;
        return;
      }

      if (!activeTurn.responseCompleted || activeTurn.responseText !== finalMessage) {
        activeTurn.responseCompleted = true;
        activeTurn.responseText = finalMessage;
        activeTurn.onEvent?.({
          type: "response.update",
          text: finalMessage,
          isComplete: true,
        });
      }

      this.clearActiveTurnTimer(activeTurn);
      activeTurn.resolve({ outputText: finalMessage });
      this.activeTurn = null;
    }
  }

  private handleThinkingDeltaNotification(
    activeTurn: CodexActiveTurnState,
    method: "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" | "item/plan/delta",
    params: unknown,
  ) {
    const delta = this.readString(params, "delta") ?? this.readStructuredCodexDelta(params) ?? "";
    if (!delta) {
      return;
    }

    this.upsertThinkingBlock(activeTurn, {
      blockId: this.readThinkingItemId(params, method),
      mode: "append",
      text: delta,
      isComplete: false,
    });
  }

  private handlePlanUpdatedNotification(activeTurn: CodexActiveTurnState, params: unknown) {
    const planText = formatPlanUpdateText(params);
    if (!planText) {
      return;
    }

    this.upsertThinkingBlock(activeTurn, {
      blockId: `codex-plan-${activeTurn.turnId ?? activeTurn.threadId}`,
      mode: "replace",
      text: planText,
      isComplete: false,
    });
  }

  private handleStructuredReasoningNotification(
    activeTurn: CodexActiveTurnState,
    method: "codex/event/agent_reasoning" | "codex/event/reasoning_content_delta",
    params: unknown,
  ) {
    if (method === "codex/event/agent_reasoning") {
      const text = this.readStructuredCodexReasoningText(params);
      if (!text) {
        return;
      }

      this.upsertThinkingBlock(activeTurn, {
        blockId: `codex-reasoning-${this.readStructuredCodexTurnId(params) ?? activeTurn.turnId ?? activeTurn.threadId}`,
        mode: "replace",
        text,
        isComplete: false,
      });
      return;
    }

    const delta = this.readStructuredCodexDelta(params);
    if (!delta) {
      return;
    }

    this.upsertThinkingBlock(activeTurn, {
      blockId: this.readThinkingItemId(params, method),
      mode: "append",
      text: delta,
      isComplete: false,
    });
  }

  private upsertThinkingBlock(
    activeTurn: CodexActiveTurnState,
    input: {
      blockId: string;
      mode: "append" | "replace";
      text: string;
      isComplete: boolean;
    },
  ) {
    const existing = activeTurn.thinkingBlocksById.get(input.blockId);
    const block =
      existing ??
      {
        kind: "thinking" as const,
        order: this.nextTurnBlockOrder(activeTurn),
        text: "",
      };
    block.text = input.mode === "append" ? `${block.text}${input.text}` : input.text;
    if (!block.text.trim()) {
      return;
    }

    activeTurn.thinkingBlocksById.set(input.blockId, block);
    activeTurn.onEvent?.({
      type: "thinking.update",
      blockId: input.blockId,
      order: block.order,
      text: block.text,
      isComplete: input.isComplete,
    });
  }

  private readThinkingItemId(
    params: unknown,
    method:
      | "item/reasoning/textDelta"
      | "item/reasoning/summaryTextDelta"
      | "item/plan/delta"
      | "codex/event/reasoning_content_delta",
  ) {
    if (method === "codex/event/reasoning_content_delta") {
      return (
        this.readString(this.readObject(params, "msg"), "item_id") ??
        this.readString(params, "id") ??
        `codex-reasoning-${this.readStructuredCodexTurnId(params) ?? this.activeTurn?.threadId ?? "current"}`
      );
    }

    return this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id") ?? `thinking-${method}`;
  }

  private handleThreadItemNotification(
    activeTurn: CodexActiveTurnState,
    method: "item/started" | "item/updated" | "item/completed",
    params: unknown,
  ) {
    const item = this.readObject(params, "item");
    if (!item) {
      return;
    }

    const itemType = this.readString(item, "type") ?? "";
    const itemId = this.readString(item, "id") ?? makeId("codex-item");

    if (itemType === "agentMessage") {
      const text = this.readAppServerAgentMessageText(item);
      if (!text) {
        return;
      }

      activeTurn.responseTextsByItemId.set(itemId, text);
      activeTurn.responseText = text;
      activeTurn.responseCompleted = false;
      activeTurn.onEvent?.({
        type: "response.update",
        text,
        isComplete: false,
      });
      return;
    }

    if (itemType === "reasoning" || itemType === "plan") {
      const text =
        this.readStructuredText(this.readValue(item, "text")) ??
        this.readStructuredText(this.readValue(item, "summary")) ??
        this.readStructuredText(this.readValue(item, "content"));
      if (!text || text.trim().length === 0) {
        return;
      }

      this.upsertThinkingBlock(activeTurn, {
        blockId: itemId,
        mode: "replace",
        text,
        isComplete: method === "item/completed",
      });
      return;
    }

    if (
      itemType === "commandExecution" ||
      itemType === "mcpToolCall" ||
      itemType === "webSearch" ||
      itemType === "fileChange" ||
      itemType === "dynamicToolCall"
    ) {
      const existing = activeTurn.commandBlocksById.get(itemId);
      const block =
        existing ??
        {
          kind: "tool" as const,
          inputText: "",
          order: this.nextTurnBlockOrder(activeTurn),
          outputText: "",
          toolCallId: itemId,
          toolName: this.resolveToolNameFromItem(itemType, item),
        };

      block.toolName = this.resolveToolNameFromItem(itemType, item) || block.toolName;
      block.inputText = this.resolveToolInputFromItem(itemType, item) || block.inputText;
      block.outputText = this.resolveToolOutputFromItem(itemType, item) || block.outputText;
      activeTurn.commandBlocksById.set(itemId, block);

      const status = this.readString(item, "status")?.toLowerCase() ?? "";
      const isComplete = method === "item/completed" || status === "completed" || status === "failed" || status === "declined";
      const isError = status === "failed" || status === "declined";

      activeTurn.onEvent?.({
        type: "tool.update",
        blockId: block.toolCallId,
        order: block.order,
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        inputText: block.inputText,
        outputText: block.outputText,
        isComplete,
        isError,
      });
    }
  }

  private resolveToolNameFromItem(itemType: string, item: Record<string, unknown>) {
    if (itemType === "commandExecution") {
      return "Shell command";
    }
    if (itemType === "webSearch") {
      return "Web search";
    }
    if (itemType === "fileChange") {
      return "Apply patch";
    }
    if (itemType === "mcpToolCall") {
      const server = this.readString(item, "server") ?? "MCP";
      const tool = this.readString(item, "tool") ?? "tool";
      return `${server}/${tool}`;
    }
    if (itemType === "dynamicToolCall") {
      return this.readString(item, "tool") ?? "Dynamic tool";
    }

    return itemType;
  }

  private resolveToolInputFromItem(itemType: string, item: Record<string, unknown>) {
    if (itemType === "commandExecution") {
      return this.readString(item, "command") ?? "";
    }

    if (itemType === "webSearch") {
      return this.readString(item, "query") ?? "";
    }

    if (itemType === "mcpToolCall") {
      return formatStructuredBlock(this.readValue(item, "arguments"));
    }

    if (itemType === "fileChange") {
      return formatStructuredBlock(this.readValue(item, "changes"));
    }

    if (itemType === "dynamicToolCall") {
      return formatStructuredBlock(this.readValue(item, "arguments"));
    }

    return "";
  }

  private resolveToolOutputFromItem(itemType: string, item: Record<string, unknown>) {
    if (itemType === "commandExecution") {
      return this.readString(item, "aggregatedOutput") ?? "";
    }

    if (itemType === "mcpToolCall") {
      return formatStructuredBlock(this.readValue(item, "result") ?? this.readValue(item, "error"));
    }

    if (itemType === "fileChange") {
      return formatStructuredBlock(this.readValue(item, "changes"));
    }

    if (itemType === "dynamicToolCall") {
      return formatStructuredBlock(this.readValue(item, "contentItems"));
    }

    if (itemType === "webSearch") {
      return formatStructuredBlock(this.readValue(item, "action"));
    }

    return "";
  }

  private nextTurnBlockOrder(activeTurn: CodexActiveTurnState) {
    activeTurn.blockOrder += 1;
    return activeTurn.blockOrder;
  }

  private readFinalAgentMessageFromTurn(turn: Record<string, unknown> | undefined) {
    if (!turn) {
      return "";
    }

    const items = this.readArray(turn, "items") ?? [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item || typeof item !== "object") {
        continue;
      }

      const itemRecord = item as Record<string, unknown>;
      const itemType = this.readString(itemRecord, "type");
      if (itemType !== "agentMessage") {
        continue;
      }

      const text = this.readAppServerAgentMessageText(itemRecord);
      if (text) {
        return text;
      }
    }

    return "";
  }

  private readAppServerAgentMessageText(item: Record<string, unknown>) {
    return (
      this.readStructuredText(this.readValue(item, "text")) ??
      this.readStructuredText(this.readValue(item, "content")) ??
      this.readStructuredText(this.readValue(item, "summary")) ??
      ""
    ).trim();
  }

  private readStructuredText(value: unknown): string | null {
    const text = extractStructuredText(value);
    return text.trim().length > 0 ? text : null;
  }

  private readResponseItemId(params: unknown) {
    return (
      this.readString(params, "itemId") ??
      this.readString(this.readObject(params, "item"), "id") ??
      this.readString(this.readObject(params, "msg"), "item_id") ??
      "codex-agent-message"
    );
  }

  private readStructuredCodexDelta(params: unknown) {
    const msg = this.readObject(params, "msg");
    return this.readString(msg, "delta");
  }

  private readStructuredCodexReasoningText(params: unknown) {
    const msg = this.readObject(params, "msg");
    return (
      this.readStructuredText(this.readValue(msg, "text")) ??
      this.readStructuredText(this.readValue(msg, "summary")) ??
      null
    );
  }

  private readStructuredCodexTurnId(params: unknown) {
    const msg = this.readObject(params, "msg");
    return this.readString(msg, "turn_id") ?? this.readString(params, "id");
  }

  private clearActiveTurnTimer(activeTurn: CodexActiveTurnState) {
    if (activeTurn.completionTimer) {
      clearTimeout(activeTurn.completionTimer);
      activeTurn.completionTimer = null;
    }
  }

  private bumpActiveTurnTimer(activeTurn: CodexActiveTurnState) {
    this.clearActiveTurnTimer(activeTurn);
    activeTurn.completionTimer = setTimeout(() => {
      activeTurn.completionTimer = null;
      activeTurn.reject(
        new Error(
          `Codex app-server stopped making progress for ${formatDuration(this.activityTimeoutMs)} while waiting for turn completion.`,
        ),
      );
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    }, this.activityTimeoutMs);
  }

  private async openThread(input: AgentTurnInput, workingDirectory: string) {
    const configOverrides: Record<string, unknown> = {};
    if (this.profile) {
      configOverrides.profile = this.profile;
    }

    const threadOverrides = {
      ...(this.model ? { model: this.model } : {}),
      ...(Object.keys(configOverrides).length > 0 ? { config: configOverrides } : {}),
      cwd: workingDirectory,
      persistExtendedHistory: true,
      ...this.resolveApprovalAndSandboxConfig(),
    } as Record<string, unknown>;

    if (input.session.mode === "resume") {
      if (input.metadata?.forkSession) {
        const result = await this.sendAppServerRequest("thread/fork", {
          ...threadOverrides,
          threadId: input.session.handle,
        });
        const threadId = this.readThreadId(result);
        if (!threadId) {
          throw new Error("thread/fork response did not include a thread id.");
        }
        return threadId;
      }

      const result = await this.sendAppServerRequest("thread/resume", {
        ...threadOverrides,
        threadId: input.session.handle,
      });
      const threadId = this.readThreadId(result) ?? input.session.handle;
      if (!threadId) {
        throw new Error("thread/resume response did not include a thread id.");
      }
      return threadId;
    }

    const result = await this.sendAppServerRequest("thread/start", {
      ...threadOverrides,
      experimentalRawEvents: false,
    });
    const threadId = this.readThreadId(result);
    if (!threadId) {
      throw new Error("thread/start response did not include a thread id.");
    }
    return threadId;
  }

  private async startTurn(input: {
    threadId: string;
    prompt: string;
    onEvent?: (event: AgentTurnEvent) => void;
  }) {
    if (this.activeTurn) {
      throw new Error("Codex app-server runtime does not support concurrent turns.");
    }

    let resolveTurn!: (value: { outputText: string }) => void;
    let rejectTurn!: (error: Error) => void;
    const turnResultPromise = new Promise<{ outputText: string }>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const activeTurn: CodexActiveTurnState = {
        threadId: input.threadId,
        turnId: null,
        onEvent: input.onEvent,
        responseText: "",
        responseCompleted: false,
        responseTextsByItemId: new Map(),
        assistantMessageBlocksById: new Map(),
        commandBlocksById: new Map(),
        thinkingBlocksById: new Map(),
        blockOrder: 0,
        completionTimer: null,
        resolve: resolveTurn,
        reject: rejectTurn,
      };

    this.activeTurn = activeTurn;
    this.bumpActiveTurnTimer(activeTurn);

    try {
      const startResult = await this.sendAppServerRequest("turn/start", {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
          },
        ],
      });

      const turn = this.readObject(startResult, "turn");
      const turnId = this.readString(turn, "id");
      if (turnId) {
        activeTurn.turnId = turnId;
      }

      return await turnResultPromise;
    } catch (error) {
      if (this.activeTurn) {
        this.clearActiveTurnTimer(this.activeTurn);
        this.activeTurn = null;
      }
      throw error;
    }
  }

  private async sendAppServerRequest(method: string, params: unknown) {
    const appServer = await this.ensureAppServer();
    const requestId = appServer.nextRequestId;
    appServer.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        appServer.pending.delete(String(requestId));
        reject(new Error(this.appServerLog(`Timed out waiting for method ${method}.`)));
      }, this.requestTimeoutMs);

      appServer.pending.set(String(requestId), {
        method,
        timeout,
        resolve,
        reject,
      });

      this.writeAppServerMessage({
        id: requestId,
        method,
        params,
      });
    });
  }

  private writeAppServerMessage(message: unknown) {
    const appServer = this.appServer;
    const stdin = appServer?.child.stdin;
    if (!appServer || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error(this.appServerLog("stdin is not writable."));
    }

    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private resolveApprovalAndSandboxConfig() {
    if (this.bypassApprovalsAndSandbox) {
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
    }

    if (this.fullAuto) {
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    }

    return {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    };
  }

  private assertCodexVersionSupport() {
    if (!this.binaryPath) {
      throw new Error(
        [
          "Codex binary could not be resolved.",
          ...this.binaryResolution.issues,
          "Install Codex CLI or set CODEX_BINARY_PATH to a valid executable.",
        ].join(" "),
      );
    }

    const version = readRuntimeVersion(this.binaryPath, "codex").version;
    if (!version) {
      return;
    }

    const extractedVersion = this.extractSemver(version);
    if (!extractedVersion) {
      return;
    }

    if (compareRuntimeSemver(extractedVersion, this.minimumCodexVersion) < 0) {
      throw new Error(
        `Codex CLI ${extractedVersion} is too old for app-server mode. Upgrade to ${this.minimumCodexVersion} or newer.`,
      );
    }
  }

  private extractSemver(value: string) {
    const match = value.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/);
    if (!match?.[1]) {
      return null;
    }

    const candidate = match[1];
    const [main = "", prerelease] = candidate.split("-", 2);
    const segments = main.split(".");
    if (segments.length === 2) {
      const normalizedMain = `${main}.0`;
      return prerelease ? `${normalizedMain}-${prerelease}` : normalizedMain;
    }

    return candidate;
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    return (value as Record<string, unknown>)[key];
  }

  private readThreadId(value: unknown) {
    const thread = this.readObject(value, "thread");
    return this.readString(thread, "id") ?? this.readString(value, "threadId");
  }

  private readNotificationTurnId(value: unknown) {
    const turn = this.readObject(value, "turn");
    return this.readString(turn, "id") ?? this.readString(value, "turnId");
  }

  private describeCliConfig() {
    const parts = [
      this.model ? `model=${this.model}` : "model=codex-default",
      this.profile ? `profile=${this.profile}` : "profile=codex-default",
      this.fullAuto ? "full-auto=true" : "full-auto=false",
    ];

    if (this.bypassApprovalsAndSandbox) {
      parts.push("dangerously-bypass-approvals-and-sandbox=true");
    }

    if (this.skipGitRepoCheck) {
      parts.push("skip-git-repo-check=true");
    }

    if (this.addDirs.length > 0) {
      parts.push(`add-dirs=${this.addDirs.join(",")}`);
    }

    return parts.join(", ");
  }
}

type DroidAutoLevel = "low" | "medium" | "high";

class DroidCliRuntime implements AgentRuntimeAdapter {
  private readonly descriptor = createRuntimeDescriptor("droid");
  private readonly binaryResolution = resolveRuntimeBinaryPath("droid");
  private readonly cwdResolution = resolveRuntimeWorkingDirectory();
  private readonly cwd = this.cwdResolution.workingDirectory;
  private readonly binaryPath = this.binaryResolution.binaryPath;
  private readonly machineId = readStringEnv("NETCHAT_MACHINE_ID") ?? "machine_local";
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs("droid");
  private readonly model = readStringEnv("NETCHAT_DROID_MODEL");
  private readonly reasoningEffort = readStringEnv("NETCHAT_DROID_REASONING_EFFORT");
  private readonly autoLevel = readDroidAutoLevelEnv("NETCHAT_DROID_AUTO", "high");
  private readonly skipPermissionsUnsafe = readBooleanEnv("NETCHAT_DROID_SKIP_PERMISSIONS_UNSAFE", true);
  private readonly enabledTools = readListEnv("NETCHAT_DROID_ENABLED_TOOLS");
  private readonly disabledTools = readListEnv("NETCHAT_DROID_DISABLED_TOOLS");

  getDescriptor(): AgentRuntimeDescriptor {
    return this.descriptor;
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async executeTurn(
    input: AgentTurnInput,
    options?: AgentRuntimeExecutionOptions,
  ): Promise<AgentTurnResult> {
    if (!this.binaryPath) {
      throw new Error(
        [
          "Droid binary could not be resolved.",
          ...this.binaryResolution.issues,
          "Install Droid CLI or set DROID_BINARY_PATH to a valid executable.",
        ].join(" "),
      );
    }

    const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);
    const args = this.buildCliArgs(input);
    const startedAtMs = Date.now();
    const kind = input.metadata?.netchatOperation ?? (input.session.mode === "resume" ? "branch-turn" : "root-turn");
    const resumeHandle = input.session.mode === "resume" ? input.session.handle : undefined;

    logRuntime(
      "info",
      `Starting ${kind} via Droid CLI (cwd=${workingDirectory}, resume=${resumeHandle ?? "new"}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
    );

    let stdout = "";
    let stderr = "";
    try {
      const liveState = createDroidStreamState();
      const result = await this.executeCli(args, (line) => {
        this.handleStreamLine(line, liveState, options?.onEvent);
      }, workingDirectory);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      throw this.formatExecutionError(error, {
        kind,
        startedAtMs,
        resumeHandle,
        workingDirectory,
      });
    }

    const parsed = this.parseResult(stdout, stderr, input);
    logRuntime(
      "info",
      `Droid CLI finished ${kind} in ${formatDuration(Date.now() - startedAtMs)} with session ${parsed.handle}.`,
    );

    return {
      handle: parsed.handle,
      machineId: this.machineId,
      outputText: parsed.outputText,
      runtimeId: this.descriptor.runtimeId,
      runtimeKind: this.descriptor.runtimeKind,
    };
  }

  private buildCliArgs(input: AgentTurnInput) {
    const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);
    const args = ["exec", "--output-format", "stream-json", "--cwd", workingDirectory];

    if (this.skipPermissionsUnsafe) {
      args.push("--skip-permissions-unsafe");
    } else if (this.autoLevel) {
      args.push("--auto", this.autoLevel);
    }

    if (this.model) {
      args.push("--model", this.model);
    }

    if (this.reasoningEffort) {
      args.push("--reasoning-effort", this.reasoningEffort);
    }

    if (this.enabledTools.length > 0) {
      args.push("--enabled-tools", this.enabledTools.join(","));
    }

    if (this.disabledTools.length > 0) {
      args.push("--disabled-tools", this.disabledTools.join(","));
    }

    if (input.session.mode === "resume") {
      args.push("--session-id", input.session.handle);
    }

    args.push(input.prompt);
    return args;
  }

  private executeCli(
    args: string[],
    onStdoutLine?: (line: string) => void,
    workingDirectory = this.cwd,
  ): Promise<{ stdout: string; stderr: string }> {
    if (!this.binaryPath) {
      throw new Error("Droid binary path is required.");
    }

    const binaryPath = this.binaryPath;
    const invocation = resolveBinaryInvocation(binaryPath, args);

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: workingDirectory,
        env: createRuntimeProcessEnv(workingDirectory),
        windowsHide: true,
      });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let stdoutLineBuffer = "";
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
        stdoutLineBuffer += chunk;
        noteActivity();
        flushStdoutLines();
        if (Buffer.byteLength(stdout, "utf8") > maxBufferBytes) {
          const error = new Error("Droid CLI stdout exceeded the maximum buffer size.") as ClaudeCliExecutionError;
          child.kill();
          fail(error);
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        noteActivity();
        if (Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
          const error = new Error("Droid CLI stderr exceeded the maximum buffer size.") as ClaudeCliExecutionError;
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
          const error = new Error("Droid CLI execution timed out.") as ClaudeCliExecutionError;
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

        flushStdoutLines(true);

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(
          `Droid CLI exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}.`,
        ) as ClaudeCliExecutionError;
        error.stdout = stdout;
        error.stderr = stderr;
        error.signal = signal;
        reject(error);
      });

      function flushStdoutLines(flushTail = false) {
        let newlineIndex = stdoutLineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
          stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
          if (line) {
            onStdoutLine?.(line);
          }

          newlineIndex = stdoutLineBuffer.indexOf("\n");
        }

        if (flushTail) {
          const tail = stdoutLineBuffer.trim();
          stdoutLineBuffer = "";
          if (tail) {
            onStdoutLine?.(tail);
          }
        }
      }
    });
  }

  private handleStreamLine(
    line: string,
    state: DroidStreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    let event: DroidStreamEvent;
    try {
      event = JSON.parse(line) as DroidStreamEvent;
    } catch {
      return;
    }

    if (typeof event.session_id === "string" && event.session_id.trim().length > 0) {
      state.sessionId = event.session_id.trim();
    }

    if (event.type === "tool_call") {
      const blockId = event.id?.trim() || makeId("droid-tool");
      const existing = state.toolBlocksById.get(blockId);
      const block =
        existing ??
        {
          kind: "tool" as const,
          inputText: formatStructuredBlock(event.parameters),
          order: nextDroidBlockOrder(state),
          outputText: "",
          toolCallId: blockId,
          toolName: event.toolName?.trim() || event.toolId?.trim() || "Tool",
        };

      block.inputText = formatStructuredBlock(event.parameters) || block.inputText;
      block.toolName = event.toolName?.trim() || event.toolId?.trim() || block.toolName;
      state.toolBlocksById.set(blockId, block);
      emitDroidToolUpdate({
        block,
        isComplete: false,
        isError: false,
        onEvent,
      });
      return;
    }

    if (event.type === "tool_result") {
      const blockId = event.id?.trim() || makeId("droid-tool");
      const existing = state.toolBlocksById.get(blockId);
      const block =
        existing ??
        {
          kind: "tool" as const,
          inputText: "",
          order: nextDroidBlockOrder(state),
          outputText: "",
          toolCallId: blockId,
          toolName: event.toolId?.trim() || "Tool",
        };

      block.outputText = formatToolResultContent(event.value);
      block.toolName = event.toolId?.trim() || block.toolName;
      state.toolBlocksById.set(blockId, block);
      emitDroidToolUpdate({
        block,
        isComplete: true,
        isError: Boolean(event.isError),
        onEvent,
      });
      return;
    }

    if (event.type === "message" && event.role === "assistant") {
      const text = event.text?.trimEnd() ?? "";
      if (!text) {
        return;
      }

      state.responseText = text;
      state.responseWasCompleted = false;
      onEvent?.({
        type: "response.update",
        text,
        isComplete: false,
      });
      return;
    }

    if (event.type === "completion") {
      const text = event.finalText?.trimEnd() || state.responseText;
      if (!text) {
        return;
      }

      state.responseText = text;
      state.responseWasCompleted = true;
      onEvent?.({
        type: "response.update",
        text,
        isComplete: true,
      });
    }
  }

  private parseResult(stdout: string, stderr: string, input: AgentTurnInput) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let handle = input.session.mode === "resume" ? input.session.handle : "";
    let outputText = "";

    for (const line of lines) {
      let event: DroidStreamEvent;
      try {
        event = JSON.parse(line) as DroidStreamEvent;
      } catch {
        continue;
      }

      if (typeof event.session_id === "string" && event.session_id.trim().length > 0) {
        handle = event.session_id.trim();
      }

      if (
        event.type === "message" &&
        event.role === "assistant" &&
        typeof event.text === "string" &&
        event.text.trim().length > 0
      ) {
        outputText = event.text.trim();
      }

      if (event.type === "completion" && typeof event.finalText === "string" && event.finalText.trim().length > 0) {
        outputText = event.finalText.trim();
      }
    }

    if (!handle) {
      throw new Error(`Droid CLI output did not include a session id: ${stdout.trim() || stderr.trim() || "empty output"}`);
    }

    if (!outputText) {
      throw new Error(`Droid CLI completed without a final agent message: ${stdout.trim() || stderr.trim() || "empty output"}`);
    }

    return {
      handle,
      outputText,
    };
  }

  private formatExecutionError(
    error: unknown,
    context: {
      kind: "root-turn" | "branch-create" | "branch-turn";
      startedAtMs: number;
      resumeHandle?: string;
      workingDirectory: string;
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
          `Droid CLI stopped making progress for ${formatDuration(this.activityTimeoutMs)} while running ${context.kind}.`,
          execError.hadActivity
            ? `Droid CLI emitted ${execError.activityCount ?? 0} stdout/stderr chunk(s) before going idle.`
            : "Droid CLI did not emit any stdout/stderr activity before the inactivity timeout expired.",
          `Try running \`${this.binaryPath} exec --output-format stream-json --cwd "${context.workingDirectory}" "Reply with exactly: ping"\` manually to verify the local Droid runtime.`,
        ].join(" ")
      : [
          `Droid CLI failed during ${context.kind} after ${duration}.`,
          execError.message?.trim() || "Unknown Droid CLI error.",
          stderr || stdout || "",
        ]
          .join(" ")
          .trim();

    logRuntime(
      didTimeout ? "error" : "warn",
      `${message} (resume=${context.resumeHandle ?? "new"}).`,
    );

    return new Error(message);
  }

  private describeCliConfig() {
    const parts = [
      this.model ? `model=${this.model}` : "model=droid-default",
      this.reasoningEffort ? `reasoning-effort=${this.reasoningEffort}` : "reasoning-effort=droid-default",
      this.skipPermissionsUnsafe
        ? "skip-permissions-unsafe=true"
        : this.autoLevel
          ? `auto=${this.autoLevel}`
          : "auto=read-only",
    ];

    if (this.enabledTools.length > 0) {
      parts.push(`enabled-tools=${this.enabledTools.join(",")}`);
    }

    if (this.disabledTools.length > 0) {
      parts.push(`disabled-tools=${this.disabledTools.join(",")}`);
    }

    return parts.join(", ");
  }
}

class MockRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly descriptor = createRuntimeDescriptor("mock");
  private sessions = new Map<string, SessionState>();
  private readonly cwd = resolveRuntimeWorkingDirectory().workingDirectory;
  private readonly machineId = readStringEnv("NETCHAT_MACHINE_ID") ?? "machine_local";

  getDescriptor(): AgentRuntimeDescriptor {
    return this.descriptor;
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async executeTurn(
    input: AgentTurnInput,
    options?: AgentRuntimeExecutionOptions,
  ): Promise<AgentTurnResult> {
    const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);
    const session = this.ensureSession(
      input.session.mode === "resume" && !input.metadata?.forkSession ? input.session.handle : null,
    );
    session.turns.push(input.prompt);

    const operation = input.metadata?.netchatOperation ?? (input.session.mode === "resume" ? "branch-turn" : "root-turn");
    const outputText =
      operation === "branch-create"
        ? [
            input.metadata?.forkSession ? "Mock native-fork branch" : "Mock replay-backed branch",
            `Handle: ${session.id}`,
            "",
            input.metadata?.forkSession
              ? "The branch started from the current session handle and forked into a new session id."
              : "The branch started in a fresh session with a replay prompt built from the visible path only.",
            "",
            `Prompt:\n${input.prompt}`,
          ].join("\n")
        : operation === "branch-turn"
          ? [
              "Mock branch continuation",
              `Handle: ${session.id}`,
              `Turn count: ${session.turns.length}`,
              "",
              `Follow-up:\n${input.prompt}`,
            ].join("\n")
          : [
              "Mock runtime",
              `Handle: ${session.id}`,
              `Workspace: ${workingDirectory}`,
              "",
              `You asked: ${input.prompt}`,
              "",
              "This is the place where the selected local runtime will execute the root turn.",
            ].join("\n");

    await emitMockRuntimeEvents(options?.onEvent, {
      responseText: outputText,
    });

    return {
      handle: session.id,
      machineId: this.machineId,
      outputText,
      runtimeId: this.descriptor.runtimeId,
      runtimeKind: this.descriptor.runtimeKind,
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

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readListEnv(name: string) {
  const value = readStringEnv(name);
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readBooleanEnv(name: string, defaultValue = false) {
  const value = readStringEnv(name);
  if (value === null) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

function readDroidAutoLevelEnv(
  name: string,
  defaultValue: DroidAutoLevel | null = null,
): DroidAutoLevel | null {
  const value = readStringEnv(name)?.toLowerCase() ?? null;
  if (value === null) {
    return defaultValue;
  }

  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  if (value === "off" || value === "none" || value === "false") {
    return null;
  }

  return defaultValue;
}

const runtimeActivityTimeoutDefaults: Record<AgentRuntimeKind, number> = {
  claude: 60_000,
  codex: 300_000,
  droid: 60_000,
  opencode: 60_000,
  mock: 60_000,
};

const runtimeActivityTimeoutEnvKeys: Record<AgentRuntimeKind, readonly string[]> = {
  claude: ["NETCHAT_CLAUDE_TIMEOUT_MS", "NETCHAT_RUNTIME_TIMEOUT_MS"],
  codex: ["NETCHAT_CODEX_TIMEOUT_MS", "NETCHAT_RUNTIME_TIMEOUT_MS"],
  droid: ["NETCHAT_DROID_TIMEOUT_MS", "NETCHAT_RUNTIME_TIMEOUT_MS"],
  opencode: ["NETCHAT_OPENCODE_TIMEOUT_MS", "NETCHAT_RUNTIME_TIMEOUT_MS"],
  mock: ["NETCHAT_RUNTIME_TIMEOUT_MS"],
};

function resolveRuntimeTimeoutMs(runtimeKind: AgentRuntimeKind) {
  for (const envKey of runtimeActivityTimeoutEnvKeys[runtimeKind]) {
    const rawEnvValue = process.env[envKey];
    if (typeof rawEnvValue !== "string") {
      continue;
    }

    const rawValue = Number(rawEnvValue);
    if (Number.isFinite(rawValue) && rawValue > 0) {
      return rawValue;
    }
  }

  return runtimeActivityTimeoutDefaults[runtimeKind];
}

function logRuntime(level: "info" | "warn" | "error", message: string) {
  if (runtimeLogSink) {
    runtimeLogSink(level, message);
    return;
  }

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

function compareRuntimeSemver(left: string, right: string) {
  const parse = (value: string) => {
    const [main = "", prereleaseRaw] = value.split("-", 2);
    const mainSegments = main
      .split(".")
      .map((segment) => Number.parseInt(segment, 10));
    if (mainSegments.length !== 3 || mainSegments.some((segment) => !Number.isInteger(segment))) {
      return null;
    }

    const prerelease = prereleaseRaw
      ? prereleaseRaw
        .split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
      : [];

    return {
      main: mainSegments as [number, number, number],
      prerelease,
    };
  };

  const leftParsed = parse(left);
  const rightParsed = parse(right);
  if (!leftParsed || !rightParsed) {
    return left.localeCompare(right);
  }

  for (let index = 0; index < 3; index += 1) {
    const leftValue = leftParsed.main[index];
    const rightValue = rightParsed.main[index];
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) {
    return 1;
  }
  if (rightParsed.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftParsed.prerelease[index];
    const rightIdentifier = rightParsed.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const leftIsNumber = /^\d+$/.test(leftIdentifier);
    const rightIsNumber = /^\d+$/.test(rightIdentifier);
    if (leftIsNumber && rightIsNumber) {
      const numberDiff = Number.parseInt(leftIdentifier, 10) - Number.parseInt(rightIdentifier, 10);
      if (numberDiff !== 0) {
        return numberDiff;
      }
      continue;
    }
    if (leftIsNumber) {
      return -1;
    }
    if (rightIsNumber) {
      return 1;
    }

    const textDiff = leftIdentifier.localeCompare(rightIdentifier);
    if (textDiff !== 0) {
      return textDiff;
    }
  }

  return 0;
}

function createRuntimeDescriptor(runtimeKind: AgentRuntimeKind): AgentRuntimeDescriptor {
  return {
    runtimeKind,
    runtimeLabel: resolveRuntimeLabel(runtimeKind),
    runtimeId: readStringEnv("NETCHAT_RUNTIME_ID") ?? `${runtimeKind}_local`,
  };
}

function resolveTurnWorkingDirectory(input: AgentTurnInput, fallbackWorkingDirectory: string) {
  const requestedWorkingDirectory = input.workingDirectory?.trim();
  if (!requestedWorkingDirectory) {
    return fallbackWorkingDirectory;
  }

  const resolvedWorkingDirectory = path.resolve(requestedWorkingDirectory);
  if (!existsSync(resolvedWorkingDirectory) || !statSync(resolvedWorkingDirectory).isDirectory()) {
    throw new Error(`The requested working directory is unavailable: ${requestedWorkingDirectory}`);
  }

  return resolvedWorkingDirectory;
}

function createRuntimeProcessEnv(workingDirectory: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const safeDirectory = workingDirectory.replace(/\\/g, "/");
  const existingCount = Number(env.GIT_CONFIG_COUNT ?? "0");
  const nextIndex = Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;

  env.GIT_CONFIG_COUNT = String(nextIndex + 1);
  env[`GIT_CONFIG_KEY_${nextIndex}`] = "safe.directory";
  env[`GIT_CONFIG_VALUE_${nextIndex}`] = safeDirectory;

  return env;
}

function createStreamState(): StreamState {
  return {
    blockOrder: 0,
    blocksById: new Map(),
    blockIdByIndex: new Map(),
    responseText: "",
    streamMessageOrdinal: -1,
  };
}

function createCodexStreamState(): CodexStreamState {
  return {
    blockOrder: 0,
    commandBlocksById: new Map(),
    responseText: "",
    responseWasCompleted: false,
    threadId: null,
    thinkingBlocksById: new Map(),
  };
}

function createDroidStreamState(): DroidStreamState {
  return {
    blockOrder: 0,
    responseText: "",
    responseWasCompleted: false,
    sessionId: null,
    toolBlocksById: new Map(),
  };
}

function makeStreamIndexKey(state: StreamState, index: number) {
  return `${Math.max(state.streamMessageOrdinal, 0)}:${index}`;
}

function nextBlockOrder(state: StreamState) {
  state.blockOrder += 1;
  return state.blockOrder;
}

function nextCodexBlockOrder(state: CodexStreamState) {
  state.blockOrder += 1;
  return state.blockOrder;
}

function nextDroidBlockOrder(state: DroidStreamState) {
  state.blockOrder += 1;
  return state.blockOrder;
}

function emitThinkingUpdate(
  state: StreamState,
  blockId: string,
  isComplete: boolean,
  onEvent?: (event: AgentTurnEvent) => void,
) {
  const block = state.blocksById.get(blockId);
  if (!block || block.kind !== "thinking") {
    return;
  }

  onEvent?.({
    type: "thinking.update",
    blockId,
    order: block.order,
    text: block.text,
    isComplete,
  });
}

function emitToolUpdate(
  state: StreamState,
  blockId: string,
  isComplete: boolean,
  isError: boolean,
  onEvent?: (event: AgentTurnEvent) => void,
) {
  const block = state.blocksById.get(blockId);
  if (!block || block.kind !== "tool") {
    return;
  }

  onEvent?.({
    type: "tool.update",
    blockId,
    order: block.order,
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    inputText: block.inputText,
    outputText: block.outputText,
    isComplete,
    isError,
  });
}

function emitCodexThinkingUpdate(input: {
  block: ThinkingBlockState;
  isComplete: boolean;
  onEvent?: (event: AgentTurnEvent) => void;
}) {
  input.onEvent?.({
    type: "thinking.update",
    blockId: `codex-thinking-${input.block.order}`,
    order: input.block.order,
    text: input.block.text,
    isComplete: input.isComplete,
  });
}

function emitCodexToolUpdate(input: {
  block: ToolBlockState;
  isComplete: boolean;
  isError: boolean;
  onEvent?: (event: AgentTurnEvent) => void;
}) {
  input.onEvent?.({
    type: "tool.update",
    blockId: input.block.toolCallId,
    order: input.block.order,
    toolCallId: input.block.toolCallId,
    toolName: input.block.toolName,
    inputText: input.block.inputText,
    outputText: input.block.outputText,
    isComplete: input.isComplete,
    isError: input.isError,
  });
}

function emitDroidToolUpdate(input: {
  block: ToolBlockState;
  isComplete: boolean;
  isError: boolean;
  onEvent?: (event: AgentTurnEvent) => void;
}) {
  input.onEvent?.({
    type: "tool.update",
    blockId: input.block.toolCallId,
    order: input.block.order,
    toolCallId: input.block.toolCallId,
    toolName: input.block.toolName,
    inputText: input.block.inputText,
    outputText: input.block.outputText,
    isComplete: input.isComplete,
    isError: input.isError,
  });
}

function isCodexThinkingItem(item: CodexItemPayload) {
  return typeof item.type === "string" && /thinking|reason/i.test(item.type);
}

function isCodexCommandExecutionItem(
  item: CodexItemPayload,
): item is Extract<CodexItemPayload, { type?: "command_execution" }> {
  return item.type === "command_execution";
}

function readCodexThinkingText(item: CodexItemPayload) {
  if ("text" in item && typeof item.text === "string" && item.text.trim().length > 0) {
    return item.text.trim();
  }

  if ("summary" in item && typeof item.summary === "string" && item.summary.trim().length > 0) {
    return item.summary.trim();
  }

  return "";
}

function extractStructuredText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || typeof value === "undefined") {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractStructuredText(entry))
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "delta", "summary", "content", "message", "title"]) {
      const candidate = extractStructuredText(record[key]);
      if (candidate.trim().length > 0) {
        return candidate;
      }
    }
  }

  return "";
}

function formatStructuredBlock(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || typeof value === "undefined") {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }

        return formatStructuredBlock(item);
      })
      .join("\n\n");
  }

  return formatStructuredBlock(content);
}

function formatPlanUpdateText(value: unknown): string {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const explanation = typeof record?.explanation === "string" ? record.explanation.trim() : "";
  const rawPlan = Array.isArray(record?.plan) ? record.plan : [];
  const planLines = rawPlan
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }

      const stepRecord = entry as Record<string, unknown>;
      const stepText = typeof stepRecord.step === "string" ? stepRecord.step.trim() : "";
      if (!stepText) {
        return "";
      }

      const status = typeof stepRecord.status === "string" ? stepRecord.status.trim() : "";
      return status ? `${index + 1}. [${status}] ${stepText}` : `${index + 1}. ${stepText}`;
    })
    .filter((entry) => entry.length > 0);

  return [explanation, ...planLines].filter((entry) => entry.length > 0).join("\n");
}

async function emitMockRuntimeEvents(
  onEvent: ((event: AgentTurnEvent) => void) | undefined,
  input: { responseText: string },
) {
  if (!onEvent) {
    return;
  }

  const thinkingText = "Planning the mock response before emitting the final answer.";
  const responseParts = chunkText(input.responseText, 48);

  onEvent({
    type: "thinking.update",
    blockId: "mock-thinking",
    order: 1,
    text: thinkingText,
    isComplete: false,
  });
  await waitForMockStreamStep();
  onEvent({
    type: "thinking.update",
    blockId: "mock-thinking",
    order: 1,
    text: thinkingText,
    isComplete: true,
  });

  let responseText = "";
  for (const part of responseParts) {
    responseText += part;
    await waitForMockStreamStep();
    onEvent({
      type: "response.update",
      text: responseText,
      isComplete: false,
    });
  }

  onEvent({
    type: "response.update",
    text: input.responseText,
    isComplete: true,
  });
}

function waitForMockStreamStep() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 24);
  });
}

function chunkText(value: string, size: number) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }

  return chunks.length > 0 ? chunks : [value];
}
