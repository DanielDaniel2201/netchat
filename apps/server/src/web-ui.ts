import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function registerLocalWebUi(
  app: FastifyInstance,
  diagnostics?: {
    log: (level: "info" | "warn" | "error", message: string) => void;
  },
) {
  const webDistPath = resolveWebDistPath();
  if (!webDistPath) {
    return false;
  }

  const indexPath = path.join(webDistPath, "index.html");
  if (!existsSync(indexPath)) {
    diagnostics?.log("warn", `Local web UI is enabled, but ${indexPath} does not exist yet.`);
    return false;
  }

  diagnostics?.log("info", `Serving the local web UI from ${webDistPath}.`);

  app.get("/", async (_request, reply) => {
    return sendFile(reply, indexPath);
  });

  app.get("/assets/*", async (request, reply) => {
    const pathname = getPathname(request);
    const filePath = resolveSafeFilePath(webDistPath, pathname);
    if (!filePath) {
      return reply.status(404).send({ message: "Asset not found." });
    }

    return sendFile(reply, filePath);
  });

  app.get("/*", async (request, reply) => {
    const pathname = getPathname(request);
    if (pathname.startsWith("/api/") || pathname === "/health") {
      return reply.status(404).send({ message: "Route not found." });
    }

    const filePath = resolveSafeFilePath(webDistPath, pathname);
    if (filePath) {
      return sendFile(reply, filePath);
    }

    return sendFile(reply, indexPath);
  });

  return true;
}

function resolveWebDistPath() {
  const configuredPath = process.env.NETCHAT_WEB_DIST_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const defaultPath = path.join(repoRoot, "apps", "web", "dist");
  return existsSync(defaultPath) ? defaultPath : null;
}

function getPathname(request: FastifyRequest) {
  return new URL(request.raw.url ?? "/", "http://127.0.0.1").pathname;
}

function resolveSafeFilePath(rootPath: string, pathname: string) {
  const relativePath = pathname.replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }

  const resolvedPath = path.resolve(rootPath, relativePath);
  const normalizedRoot = `${path.resolve(rootPath)}${path.sep}`;
  if (!resolvedPath.startsWith(normalizedRoot)) {
    return null;
  }

  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    return null;
  }

  return resolvedPath;
}

function sendFile(reply: FastifyReply, filePath: string) {
  reply.type(getContentType(filePath));
  return reply.send(readFileSync(filePath));
}

function getContentType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
