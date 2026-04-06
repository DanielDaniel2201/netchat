import { AgentRuntimeEnvironment, AgentRuntimeKind } from "@netchat/shared";

import {
  detectHostPlatform,
  readRuntimeVersion,
  resolveRuntimeBinaryPath,
  resolveRuntimeLabel,
} from "./runtime-config.js";

export async function detectRuntimeEnvironment(
  runtimeKind: AgentRuntimeKind,
  workingDirectory: string,
): Promise<AgentRuntimeEnvironment> {
  const platform = detectHostPlatform();
  const runtimeLabel = resolveRuntimeLabel(runtimeKind);

  if (runtimeKind === "mock") {
    return {
      platform,
      arch: process.arch,
      runtimeKind,
      runtimeLabel,
      installed: true,
      version: "built-in",
      executablePath: null,
      workingDirectory,
      detectionError: null,
    };
  }

  const resolution = resolveRuntimeBinaryPath(runtimeKind, platform);

  if (!resolution.binaryPath) {
    return {
      platform,
      arch: process.arch,
      runtimeKind,
      runtimeLabel,
      installed: false,
      version: null,
      executablePath: null,
      workingDirectory,
      detectionError:
        resolution.issues.join("; ") ||
        `${runtimeLabel} binary was not found on PATH or in the default install locations.`,
    };
  }

  const versionResult = readRuntimeVersion(resolution.binaryPath, runtimeKind);
  const issues = [...resolution.issues];
  if (versionResult.error) {
    issues.push(versionResult.error);
  }

  return {
    platform,
    arch: process.arch,
    runtimeKind,
    runtimeLabel,
    installed: true,
    version: versionResult.version,
    executablePath: resolution.binaryPath,
    workingDirectory,
    detectionError: issues.length > 0 ? issues.join("; ") : null,
  };
}
