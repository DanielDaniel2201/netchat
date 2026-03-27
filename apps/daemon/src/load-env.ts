import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadLocalEnv() {
  const protectedKeys = new Set(Object.keys(process.env));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const envFiles = [path.join(repoRoot, ".env.local")];

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
      continue;
    }

    const content = readFileSync(envFile, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (protectedKeys.has(key)) {
        continue;
      }

      let value = line.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }

  const claudeBinaryPath = process.env.CLAUDE_BINARY_PATH?.trim();
  if (!claudeBinaryPath || !existsSync(claudeBinaryPath)) {
    return;
  }

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const claudeDir = path.dirname(claudeBinaryPath);
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);

  if (!pathEntries.includes(claudeDir)) {
    process.env[pathKey] = [claudeDir, ...pathEntries].join(path.delimiter);
  }
}
