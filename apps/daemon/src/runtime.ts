import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ContinueBranchRuntimeRequest,
  ForkBranchRuntimeRequest,
  RootTurnRuntimeRequest,
  RuntimeResponse,
  makeId,
} from "@netchat/shared";

import { resolveClaudeBinaryPath, resolveClaudeWorkingDirectory } from "./claude-config.js";

const execFileAsync = promisify(execFile);

type SessionState = {
  id: string;
  turns: string[];
};

type ClaudePrintResult = {
  errors?: string[];
  result?: string;
  session_id?: string;
  subtype?: string;
  type?: string;
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
  forkBranch(input: ForkBranchRuntimeRequest): Promise<RuntimeResponse>;
  continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse>;
  getMode(): "mock" | "claude";
  getWorkingDirectory(): string;
}

export function createRuntimeAdapter(): RuntimeAdapter {
  if ((process.env.NETCHAT_RUNTIME ?? "mock") === "claude") {
    return new ClaudeCliRuntime();
  }

  return new MockRuntimeAdapter();
}

class ClaudeCliRuntime implements RuntimeAdapter {
  private readonly binaryResolution = resolveClaudeBinaryPath();
  private readonly cwdResolution = resolveClaudeWorkingDirectory();
  private readonly cwd = this.cwdResolution.workingDirectory;
  private readonly binaryPath = this.binaryResolution.binaryPath;
  private readonly permissionMode = process.env.NETCHAT_PERMISSION_MODE ?? "bypassPermissions";
  private readonly allowDangerouslySkipPermissions =
    (process.env.NETCHAT_ALLOW_DANGEROUS ?? "true").toLowerCase() === "true";
  private readonly settingSources = process.env.NETCHAT_SETTING_SOURCES ?? "user,project,local";
  private readonly machineId = process.env.NETCHAT_MACHINE_ID?.trim() || "machine_local";

  getMode(): "claude" {
    return "claude";
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  async runRootTurn(input: RootTurnRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt(input.prompt, {
      resume: input.sessionId ?? undefined,
    });
  }

  async forkBranch(input: ForkBranchRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt(input.prompt, {
      forkSession: true,
      resume: input.sourceSessionId,
    });
  }

  async continueBranch(input: ContinueBranchRuntimeRequest): Promise<RuntimeResponse> {
    return this.executePrompt(input.prompt, {
      resume: input.sessionId,
    });
  }

  private async executePrompt(
    prompt: string,
    options: {
      resume?: string;
      forkSession?: boolean;
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
    const { stdout, stderr } = await execFileAsync(this.binaryPath, args, {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });

    const parsed = this.parsePrintResult(stdout, stderr);
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
      forkSession?: boolean;
    },
  ) {
    const args = ["-p", "--output-format", "json", "--setting-sources", this.settingSources];

    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }

    if (this.permissionMode === "bypassPermissions" && this.allowDangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    if (options.resume) {
      args.push("--resume", options.resume);
    }

    if (options.forkSession) {
      args.push("--fork-session");
    }

    args.push(prompt);
    return args;
  }

  private parsePrintResult(stdout: string, stderr: string): ClaudePrintResult {
    const output = stdout.trim();
    if (!output) {
      throw new Error(stderr.trim() || "Claude CLI returned empty stdout.");
    }

    try {
      return JSON.parse(output) as ClaudePrintResult;
    } catch {
      throw new Error(`Claude CLI returned non-JSON output: ${output}`);
    }
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

  async forkBranch(input: ForkBranchRuntimeRequest): Promise<RuntimeResponse> {
    const source = this.ensureSession(input.sourceSessionId);
    const session = this.ensureSession(null);
    session.turns.push(...source.turns);
    session.turns.push(input.prompt);

    return {
      machineId: this.machineId,
      sessionId: session.id,
      assistantMessage: [
        "Mock forked branch",
        `Forked from session: ${source.id}`,
        `Selected text: ${input.selectedText}`,
        "",
        "The branch inherited the source session history and then received the fork prompt.",
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
