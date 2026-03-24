import { RuntimeEnvironment } from "@netchat/shared";

import {
  detectHostPlatform,
  readClaudeVersion,
  resolveClaudeBinaryPath,
} from "./claude-config.js";

export async function detectRuntimeEnvironment(
  runtimeMode: "mock" | "claude",
  workingDirectory: string,
): Promise<RuntimeEnvironment> {
  const platform = detectHostPlatform();
  const resolution = resolveClaudeBinaryPath(platform);

  if (!resolution.binaryPath) {
    return {
      platform,
      arch: process.arch,
      claudeInstalled: false,
      claudeVersion: null,
      claudePath: null,
      workingDirectory,
      runtimeMode,
      detectionError:
        resolution.issues.join("; ") ||
        "Claude binary was not found on PATH or in the default install locations.",
    };
  }

  const versionResult = readClaudeVersion(resolution.binaryPath);
  const issues = [...resolution.issues];
  if (versionResult.error) {
    issues.push(versionResult.error);
  }

  return {
    platform,
    arch: process.arch,
    claudeInstalled: true,
    claudeVersion: versionResult.version,
    claudePath: resolution.binaryPath,
    workingDirectory,
    runtimeMode,
    detectionError: issues.length > 0 ? issues.join("; ") : null,
  };
}
