import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRuntimeKind, HostPlatform } from "@netchat/shared";

export type RuntimeBinaryResolution = {
  binaryPath: string | null;
  issues: string[];
};

export type RuntimeWorkingDirectoryResolution = {
  issue: string | null;
  workingDirectory: string;
};

type RuntimeBinaryConfig = {
  envKeys: string[];
  executableNames: string[];
  versionArgs: string[][];
  windowsFallbacks: string[];
  posixFallbacks: string[];
};

const runtimeBinaryConfig = {
  claude: {
    envKeys: ["CLAUDE_BINARY_PATH"],
    executableNames: ["claude"],
    versionArgs: [["--version"], ["-v"]],
    windowsFallbacks: [
      path.join(os.homedir(), ".local", "bin", "claude.exe"),
      path.join(os.homedir(), ".local", "bin", "claude.cmd"),
      path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.exe"),
      path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
    ],
    posixFallbacks: [
      path.join(os.homedir(), ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ],
  },
  codex: {
    envKeys: ["CODEX_BINARY_PATH", "NETCHAT_CODEX_BINARY_PATH"],
    executableNames: ["codex"],
    versionArgs: [["-V"], ["--version"]],
    windowsFallbacks: buildWindowsNodeCliFallbacks("codex"),
    posixFallbacks: buildPosixCliFallbacks("codex"),
  },
  droid: {
    envKeys: ["DROID_BINARY_PATH", "NETCHAT_DROID_BINARY_PATH"],
    executableNames: ["droid"],
    versionArgs: [["--version"], ["-v"]],
    windowsFallbacks: buildWindowsNodeCliFallbacks("droid"),
    posixFallbacks: buildPosixCliFallbacks("droid"),
  },
  opencode: {
    envKeys: ["OPENCODE_BINARY_PATH", "NETCHAT_OPENCODE_BINARY_PATH"],
    executableNames: ["opencode"],
    versionArgs: [["--version"], ["-v"]],
    windowsFallbacks: buildWindowsNodeCliFallbacks("opencode"),
    posixFallbacks: buildPosixCliFallbacks("opencode"),
  },
} satisfies Record<Exclude<AgentRuntimeKind, "mock">, RuntimeBinaryConfig>;

export function resolveRuntimeLabel(runtimeKind: AgentRuntimeKind) {
  switch (runtimeKind) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "mock":
      return "Mock runtime";
  }
}

export function resolveRuntimeKind(): AgentRuntimeKind {
  const value = process.env.NETCHAT_RUNTIME?.trim().toLowerCase();
  if (!value) {
    return "claude";
  }

  if (isAgentRuntimeKind(value)) {
    return value;
  }

  throw new Error(
    `Unsupported NETCHAT_RUNTIME value "${value}". Expected one of: claude, codex, droid, opencode, mock.`,
  );
}

export function detectHostPlatform(): HostPlatform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

export function resolveRuntimeBinaryPath(
  runtimeKind: AgentRuntimeKind,
  platform = detectHostPlatform(),
): RuntimeBinaryResolution {
  if (runtimeKind === "mock") {
    return {
      binaryPath: null,
      issues: [],
    };
  }

  const config = runtimeBinaryConfig[runtimeKind];
  const issues: string[] = [];

  for (const envKey of config.envKeys) {
    const configuredPath = process.env[envKey]?.trim();
    if (!configuredPath) {
      continue;
    }

    if (existsSync(configuredPath)) {
      return {
        binaryPath: configuredPath,
        issues,
      };
    }

    issues.push(`${envKey} does not exist: ${configuredPath}`);
  }

  const discoveredFromPath = findExecutableOnPath(config.executableNames, platform);
  if (discoveredFromPath) {
    return {
      binaryPath: discoveredFromPath,
      issues,
    };
  }

  const fallbackPath = findRuntimeInDefaultLocations(runtimeKind, platform);
  if (fallbackPath) {
    issues.push(`Resolved ${resolveRuntimeLabel(runtimeKind)} from a default install location.`);
    return {
      binaryPath: fallbackPath,
      issues,
    };
  }

  return {
    binaryPath: null,
    issues,
  };
}

export function readRuntimeVersion(
  binaryPath: string,
  runtimeKind: AgentRuntimeKind,
): {
  error: string | null;
  version: string | null;
} {
  if (runtimeKind === "mock") {
    return {
      error: null,
      version: "built-in",
    };
  }

  const attempts = runtimeBinaryConfig[runtimeKind].versionArgs;

  for (const args of attempts) {
    try {
      const output = execFileSync(binaryPath, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        windowsHide: true,
      });

      const version = output.trim();
      if (version.length > 0) {
        return {
          error: null,
          version,
        };
      }
    } catch (error) {
      if (args === attempts.at(-1)) {
        return {
          error: error instanceof Error ? error.message : "Unknown version detection error",
          version: null,
        };
      }
    }
  }

  return {
    error: `${resolveRuntimeLabel(runtimeKind)} version detection returned empty output.`,
    version: null,
  };
}

export function resolveRuntimeWorkingDirectory(): RuntimeWorkingDirectoryResolution {
  const configuredDirectory =
    process.env.NETCHAT_RUNTIME_CWD?.trim() ?? process.env.CLAUDE_PROJECT_CWD?.trim();

  if (configuredDirectory && existsSync(configuredDirectory)) {
    return {
      issue: null,
      workingDirectory: configuredDirectory,
    };
  }

  return {
    issue: configuredDirectory ? `NETCHAT_RUNTIME_CWD does not exist: ${configuredDirectory}` : null,
    workingDirectory: process.cwd(),
  };
}

function findExecutableOnPath(executableNames: string[], platform: HostPlatform) {
  for (const executableName of executableNames) {
    try {
      const command = platform === "windows" ? "where.exe" : "which";
      const output = execFileSync(command, [executableName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        windowsHide: true,
      });

      const resolved = output
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"|"$/g, ""))
        .find((candidate) => candidate.length > 0 && existsSync(candidate));

      if (resolved) {
        return resolved;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function findRuntimeInDefaultLocations(runtimeKind: Exclude<AgentRuntimeKind, "mock">, platform: HostPlatform) {
  const config = runtimeBinaryConfig[runtimeKind];
  const candidates = platform === "windows" ? config.windowsFallbacks : config.posixFallbacks;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function buildWindowsNodeCliFallbacks(commandName: string) {
  const nvmSymlink = process.env.NVM_SYMLINK?.trim() || path.join("C:", "nvm4w", "nodejs");
  return [
    path.join(os.homedir(), ".local", "bin", `${commandName}.exe`),
    path.join(os.homedir(), ".local", "bin", `${commandName}.cmd`),
    path.join(os.homedir(), "AppData", "Roaming", "npm", `${commandName}.exe`),
    path.join(os.homedir(), "AppData", "Roaming", "npm", `${commandName}.cmd`),
    path.join(nvmSymlink, commandName),
    path.join(nvmSymlink, `${commandName}.cmd`),
    path.join(nvmSymlink, `${commandName}.exe`),
  ];
}

function buildPosixCliFallbacks(commandName: string) {
  return [
    path.join(os.homedir(), ".local", "bin", commandName),
    "/usr/local/bin/" + commandName,
    "/opt/homebrew/bin/" + commandName,
  ];
}

function isAgentRuntimeKind(value: string): value is AgentRuntimeKind {
  return value === "claude" || value === "codex" || value === "droid" || value === "opencode" || value === "mock";
}
