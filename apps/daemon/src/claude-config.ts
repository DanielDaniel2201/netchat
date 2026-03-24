import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { HostPlatform } from "@netchat/shared";

export type ClaudeBinaryResolution = {
  binaryPath: string | null;
  issues: string[];
};

export type ClaudeWorkingDirectoryResolution = {
  issue: string | null;
  workingDirectory: string;
};

export function resolveClaudeBinaryPath(platform = detectHostPlatform()): ClaudeBinaryResolution {
  const configuredPath = process.env.CLAUDE_BINARY_PATH?.trim();
  const issues: string[] = [];

  if (configuredPath) {
    if (existsSync(configuredPath)) {
      return { binaryPath: configuredPath, issues };
    }

    issues.push(`CLAUDE_BINARY_PATH does not exist: ${configuredPath}`);
  }

  const discoveredFromPath = findClaudeOnPath(platform);
  if (discoveredFromPath) {
    return { binaryPath: discoveredFromPath, issues };
  }

  const fallbackPath = findClaudeInDefaultLocations(platform);
  if (fallbackPath) {
    issues.push("Resolved Claude from a default install location.");
    return { binaryPath: fallbackPath, issues };
  }

  return { binaryPath: null, issues };
}

export function readClaudeVersion(binaryPath: string): {
  error: string | null;
  version: string | null;
} {
  const attempts = [["--version"], ["-v"]];

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
        return { error: null, version };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown version detection error";
      if (args[0] === "-v") {
        return { error: message, version: null };
      }
    }
  }

  return { error: "Claude version detection returned empty output.", version: null };
}

export function resolveClaudeWorkingDirectory(): ClaudeWorkingDirectoryResolution {
  const configuredDirectory = process.env.CLAUDE_PROJECT_CWD?.trim();
  if (configuredDirectory && existsSync(configuredDirectory)) {
    return {
      issue: null,
      workingDirectory: configuredDirectory,
    };
  }

  return {
    issue: configuredDirectory
      ? `CLAUDE_PROJECT_CWD does not exist: ${configuredDirectory}`
      : null,
    workingDirectory: process.cwd(),
  };
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

function findClaudeOnPath(platform: HostPlatform) {
  try {
    const command = platform === "windows" ? "where.exe" : "which";
    const args = platform === "windows" ? ["claude"] : ["claude"];
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });

    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"|"$/g, ""))
        .find((candidate) => candidate.length > 0 && existsSync(candidate)) ?? null
    );
  } catch {
    return null;
  }
}

function findClaudeInDefaultLocations(platform: HostPlatform) {
  const candidates =
    platform === "windows"
      ? [
          path.join(os.homedir(), ".local", "bin", "claude.exe"),
          path.join(os.homedir(), ".local", "bin", "claude.cmd"),
          path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.exe"),
          path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
        ]
      : [
          path.join(os.homedir(), ".local", "bin", "claude"),
          "/usr/local/bin/claude",
          "/opt/homebrew/bin/claude",
        ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
