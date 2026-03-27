import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "dist");
const webSourceDistPath = path.join(repoRoot, "apps", "web", "dist");
const webTargetDistPath = path.join(distRoot, "web");

await main();

async function main() {
  rmSync(distRoot, { recursive: true, force: true });
  mkdirSync(distRoot, { recursive: true });

  await runCommand(resolveNpmCommand(), ["run", "build:web"], {
    cwd: repoRoot,
  });

  if (!existsSync(webSourceDistPath)) {
    throw new Error(`Expected built web assets at ${webSourceDistPath}.`);
  }

  copyDirectoryContents(webSourceDistPath, webTargetDistPath);

  await Promise.all([
    bundleNodeEntry("apps/server/src/index.ts", "dist/apps/server/index.mjs"),
    bundleNodeEntry("apps/server/src/local-app.ts", "dist/apps/local-app/index.mjs"),
    bundleNodeEntry("apps/daemon/src/index.ts", "dist/apps/daemon/index.mjs"),
  ]);
}

async function bundleNodeEntry(entryPoint, outputFile) {
  await build({
    entryPoints: [path.join(repoRoot, entryPoint)],
    outfile: path.join(repoRoot, outputFile),
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    bundle: true,
    format: "esm",
    legalComments: "none",
    minify: false,
    platform: "node",
    sourcemap: false,
    target: "node20",
  });
}

function resolveNpmCommand() {
  const npmCliPath = process.env.npm_execpath?.trim();
  if (npmCliPath) {
    return {
      command: process.execPath,
      prefixArgs: [npmCliPath],
      shell: false,
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
    shell: process.platform === "win32",
  };
}

function runCommand(
  npmCommand,
  args,
  options,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand.command, [...npmCommand.prefixArgs, ...args], {
      cwd: options.cwd,
      env: process.env,
      shell: npmCommand.shell,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${npmCommand.command} ${args.join(" ")} failed with ${code !== null ? `exit code ${code}` : `signal ${signal}`}.`,
        ),
      );
    });
  });
}

function copyDirectoryContents(sourcePath, targetPath) {
  mkdirSync(targetPath, { recursive: true });
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (entry.isFile()) {
      const mode = statSync(sourceEntryPath).mode;
      writeFileSync(targetEntryPath, readFileSync(sourceEntryPath), { mode });
    }
  }
}
