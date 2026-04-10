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
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs();

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

    logRuntime(
      "info",
      `Starting ${kind} via Claude CLI (cwd=${workingDirectory}, resume=${resumeHandle ?? "new"}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
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
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs();
  private readonly model = readStringEnv("NETCHAT_CODEX_MODEL");
  private readonly profile = readStringEnv("NETCHAT_CODEX_PROFILE");
  private readonly addDirs = readListEnv("NETCHAT_CODEX_ADD_DIRS");
  private readonly fullAuto = readBooleanEnv("NETCHAT_CODEX_FULL_AUTO", true);
  private readonly bypassApprovalsAndSandbox = readBooleanEnv("NETCHAT_CODEX_BYPASS", true);
  private readonly skipGitRepoCheck = readBooleanEnv("NETCHAT_CODEX_SKIP_GIT_REPO_CHECK", false);

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
          "Codex binary could not be resolved.",
          ...this.binaryResolution.issues,
          "Install Codex CLI or set CODEX_BINARY_PATH to a valid executable.",
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
      `Starting ${kind} via Codex CLI (cwd=${workingDirectory}, resume=${resumeHandle ?? "new"}, idle-timeout=${formatDuration(this.activityTimeoutMs)}, config=${this.describeCliConfig()}).`,
    );

    let stdout = "";
    let stderr = "";
    try {
      const liveState = createCodexStreamState();
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
      `Codex CLI finished ${kind} in ${formatDuration(Date.now() - startedAtMs)} with thread ${parsed.handle}.`,
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
    const args = ["exec"];
    const workingDirectory = resolveTurnWorkingDirectory(input, this.cwd);

    if (input.session.mode === "resume") {
      args.push("resume");
    }

    args.push("--json");

    if (this.bypassApprovalsAndSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (this.fullAuto) {
      args.push("--full-auto");
    }

    if (this.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.model) {
      args.push("--model", this.model);
    }

    if (this.profile) {
      args.push("--profile", this.profile);
    }

    for (const addDir of this.addDirs) {
      args.push("--add-dir", addDir);
    }

    if (input.session.mode === "resume") {
      args.push(input.session.handle, input.prompt);
      return args;
    }

    args.push("--cd", workingDirectory, input.prompt);
    return args;
  }

  private executeCli(
    args: string[],
    onStdoutLine?: (line: string) => void,
    workingDirectory = this.cwd,
  ): Promise<{ stdout: string; stderr: string }> {
    if (!this.binaryPath) {
      throw new Error("Codex binary path is required.");
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
          const error = new Error("Codex CLI stdout exceeded the maximum buffer size.") as ClaudeCliExecutionError;
          child.kill();
          fail(error);
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        noteActivity();
        if (Buffer.byteLength(stderr, "utf8") > maxBufferBytes) {
          const error = new Error("Codex CLI stderr exceeded the maximum buffer size.") as ClaudeCliExecutionError;
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
          const error = new Error("Codex CLI execution timed out.") as ClaudeCliExecutionError;
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
          `Codex CLI exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}.`,
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
    state: CodexStreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      return;
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim().length > 0) {
      state.threadId = event.thread_id.trim();
      return;
    }

    if (
      (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
      event.item
    ) {
      this.handleItemEvent(event.type, event.item, state, onEvent);
      return;
    }

    if (event.type === "turn.completed" && state.responseText.trim().length > 0 && !state.responseWasCompleted) {
      state.responseWasCompleted = true;
      onEvent?.({
        type: "response.update",
        text: state.responseText,
        isComplete: true,
      });
    }
  }

  private handleItemEvent(
    eventType: "item.started" | "item.updated" | "item.completed",
    item: CodexItemPayload,
    state: CodexStreamState,
    onEvent?: (event: AgentTurnEvent) => void,
  ) {
    if (item.type === "agent_message") {
      const text = item.text?.trimEnd() ?? "";
      if (!text) {
        return;
      }

      state.responseText = text;
      state.responseWasCompleted = eventType === "item.completed";
      onEvent?.({
        type: "response.update",
        text,
        isComplete: eventType === "item.completed",
      });
      return;
    }

    if (isCodexCommandExecutionItem(item)) {
      const blockId = item.id?.trim() || makeId("codex-tool");
      const existing = state.commandBlocksById.get(blockId);
      const block =
        existing ??
        {
          kind: "tool" as const,
          inputText: item.command?.trim() || "",
          order: nextCodexBlockOrder(state),
          outputText: "",
          toolCallId: blockId,
          toolName: "Shell command",
        };

      block.inputText = item.command?.trim() || block.inputText;
      block.outputText = item.aggregated_output ?? block.outputText;
      state.commandBlocksById.set(blockId, block);
      emitCodexToolUpdate({
        block,
        isComplete: eventType === "item.completed",
        isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
        onEvent,
      });
      return;
    }

    if (!isCodexThinkingItem(item)) {
      return;
    }

    const text = readCodexThinkingText(item);
    if (!text) {
      return;
    }

    const blockId = item.id?.trim() || makeId("codex-thinking");
    const existing = state.thinkingBlocksById.get(blockId);
    const block =
      existing ??
      {
        kind: "thinking" as const,
        order: nextCodexBlockOrder(state),
        text,
      };

    block.text = text;
    state.thinkingBlocksById.set(blockId, block);
    emitCodexThinkingUpdate({
      block,
      isComplete: eventType === "item.completed",
      onEvent,
    });
  }

  private parseResult(stdout: string, stderr: string, input: AgentTurnInput) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let handle = "";
    let outputText = "";

    for (const line of lines) {
      let event: CodexJsonEvent;
      try {
        event = JSON.parse(line) as CodexJsonEvent;
      } catch {
        continue;
      }

      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim().length > 0) {
        handle = event.thread_id.trim();
      }

      if (event.item?.type === "agent_message" && typeof event.item.text === "string" && event.item.text.trim().length > 0) {
        outputText = event.item.text.trim();
      }
    }

    if (!handle && input.session.mode === "resume") {
      handle = input.session.handle;
    }

    if (!handle) {
      throw new Error(`Codex CLI output did not include a thread id: ${stdout.trim() || stderr.trim() || "empty output"}`);
    }

    if (!outputText) {
      throw new Error(`Codex CLI completed without a final agent message: ${stdout.trim() || stderr.trim() || "empty output"}`);
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
          `Codex CLI stopped making progress for ${formatDuration(this.activityTimeoutMs)} while running ${context.kind}.`,
          execError.hadActivity
            ? `Codex CLI emitted ${execError.activityCount ?? 0} stdout/stderr chunk(s) before going idle.`
            : "Codex CLI did not emit any stdout/stderr activity before the inactivity timeout expired.",
          `Try running \`${this.binaryPath} exec --json --cd "${context.workingDirectory}" "Reply with exactly: ping"\` manually to verify the local Codex runtime.`,
        ].join(" ")
      : [
          `Codex CLI failed during ${context.kind} after ${duration}.`,
          execError.message?.trim() || "Unknown Codex CLI error.",
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
  private readonly activityTimeoutMs = resolveRuntimeTimeoutMs();
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
    const session = this.ensureSession(input.session.mode === "resume" ? input.session.handle : null);
    session.turns.push(input.prompt);

    const operation = input.metadata?.netchatOperation ?? (input.session.mode === "resume" ? "branch-turn" : "root-turn");
    const outputText =
      operation === "branch-create"
        ? [
            "Mock replay-backed branch",
            `Handle: ${session.id}`,
            "",
            "The branch started in a fresh session with a replay prompt built from the visible path only.",
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
