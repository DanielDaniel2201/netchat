import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import zlib from "node:zlib";

type MineruCreateBatchResponse = {
  code?: number;
  msg?: string;
  data?: {
    batch_id?: unknown;
    file_urls?: unknown;
  };
};

type MineruBatchResultResponse = {
  code?: number;
  msg?: string;
  data?: {
    batch_id?: unknown;
    extract_result?: unknown;
  };
};

type MineruExtractResult = {
  file_name: string;
  state: string;
  full_zip_url: string | null;
  err_msg: string | null;
  data_id: string | null;
};

const mineruApiBaseUrl = "https://mineru.net/api/v4";
const mineruBatchPollIntervalMs = 2500;
const mineruBatchPollTimeoutMs = 8 * 60 * 1000;
const mineruMaxPdfBytes = 200 * 1024 * 1024;

export async function convertPdfToMarkdownWithMineru(input: {
  filePath: string;
  token: string;
}): Promise<{
  markdownFilePath: string;
}> {
  const absolutePdfPath = path.resolve(input.filePath);
  const pdfStats = await stat(absolutePdfPath);
  if (!pdfStats.isFile()) {
    throw new Error("The selected PDF path is not a file.");
  }

  if (pdfStats.size === 0) {
    throw new Error("The selected PDF is empty.");
  }

  if (pdfStats.size > mineruMaxPdfBytes) {
    throw new Error("MinerU supports PDFs up to 200 MB.");
  }

  const uploadReservation = await reserveUploadUrl({
    fileName: path.basename(absolutePdfPath),
    token: input.token,
  });
  await uploadPdfFile({
    filePath: absolutePdfPath,
    uploadUrl: uploadReservation.uploadUrl,
  });

  const extractResult = await waitForBatchResult({
    batchId: uploadReservation.batchId,
    dataId: uploadReservation.dataId,
    token: input.token,
  });

  if (extractResult.state !== "done") {
    throw new Error(extractResult.err_msg || `MinerU finished in unexpected state "${extractResult.state}".`);
  }

  if (!extractResult.full_zip_url) {
    throw new Error("MinerU completed without returning a result archive.");
  }

  const markdownContent = await downloadFullMarkdown(extractResult.full_zip_url);
  const markdownFilePath = await buildSiblingMarkdownPath(absolutePdfPath);
  await writeFile(markdownFilePath, markdownContent, "utf8");

  return {
    markdownFilePath,
  };
}

async function reserveUploadUrl(input: {
  fileName: string;
  token: string;
}) {
  const dataId = buildMineruDataId(input.fileName);
  const response = await fetch(`${mineruApiBaseUrl}/file-urls/batch`, {
    method: "POST",
    headers: buildMineruHeaders(input.token),
    body: JSON.stringify({
      files: [
        {
          name: input.fileName,
          data_id: dataId,
        },
      ],
      model_version: "vlm",
    }),
  });

  const payload = (await response.json().catch(() => null)) as MineruCreateBatchResponse | null;
  if (!response.ok) {
    throw new Error(resolveMineruErrorMessage(payload?.msg, `MinerU upload reservation failed with HTTP ${response.status}.`));
  }

  if ((payload?.code ?? -1) !== 0) {
    throw new Error(resolveMineruErrorMessage(payload?.msg, "MinerU rejected the upload reservation request."));
  }

  const batchId = typeof payload?.data?.batch_id === "string" ? payload.data.batch_id.trim() : "";
  const fileUrls = Array.isArray(payload?.data?.file_urls)
    ? payload?.data?.file_urls.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (!batchId) {
    throw new Error("MinerU did not return a batch id.");
  }

  const uploadUrl = fileUrls[0] ?? "";
  if (!uploadUrl) {
    throw new Error("MinerU did not return an upload URL.");
  }

  return {
    batchId,
    dataId,
    uploadUrl,
  };
}

async function uploadPdfFile(input: {
  filePath: string;
  uploadUrl: string;
}) {
  const fileBuffer = await readFile(input.filePath);
  const response = await fetch(input.uploadUrl, {
    method: "PUT",
    body: fileBuffer,
  });

  if (!response.ok) {
    const payload = (await response.text().catch(() => "")).trim();
    throw new Error(payload || `MinerU file upload failed with HTTP ${response.status}.`);
  }
}

async function waitForBatchResult(input: {
  batchId: string;
  dataId: string;
  token: string;
}) {
  const deadline = Date.now() + mineruBatchPollTimeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${mineruApiBaseUrl}/extract-results/batch/${encodeURIComponent(input.batchId)}`, {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "*/*",
      },
    });
    const payload = (await response.json().catch(() => null)) as MineruBatchResultResponse | null;

    if (!response.ok) {
      throw new Error(resolveMineruErrorMessage(payload?.msg, `MinerU status polling failed with HTTP ${response.status}.`));
    }

    if ((payload?.code ?? -1) !== 0) {
      throw new Error(resolveMineruErrorMessage(payload?.msg, "MinerU status polling failed."));
    }

    const extractResults = Array.isArray(payload?.data?.extract_result)
      ? payload?.data?.extract_result.map(normalizeExtractResult).filter((value): value is MineruExtractResult => value !== null)
      : [];
    const matchedResult =
      extractResults.find((candidate) => candidate.data_id === input.dataId) ??
      extractResults[0] ??
      null;

    if (!matchedResult) {
      await delay(mineruBatchPollIntervalMs);
      continue;
    }

    switch (matchedResult.state) {
      case "done":
        return matchedResult;
      case "failed":
        throw new Error(matchedResult.err_msg || "MinerU failed to parse the PDF.");
      case "waiting-file":
      case "pending":
      case "running":
      case "converting":
        await delay(mineruBatchPollIntervalMs);
        continue;
      default:
        throw new Error(`MinerU returned an unknown task state "${matchedResult.state}".`);
    }
  }

  throw new Error("Timed out while waiting for MinerU to finish parsing the PDF.");
}

function normalizeExtractResult(value: unknown): MineruExtractResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    file_name?: unknown;
    state?: unknown;
    full_zip_url?: unknown;
    err_msg?: unknown;
    data_id?: unknown;
  };
  if (typeof record.state !== "string" || record.state.trim().length === 0) {
    return null;
  }

  return {
    file_name: typeof record.file_name === "string" ? record.file_name : "",
    state: record.state.trim(),
    full_zip_url: typeof record.full_zip_url === "string" && record.full_zip_url.trim().length > 0 ? record.full_zip_url.trim() : null,
    err_msg: typeof record.err_msg === "string" && record.err_msg.trim().length > 0 ? record.err_msg.trim() : null,
    data_id: typeof record.data_id === "string" && record.data_id.trim().length > 0 ? record.data_id.trim() : null,
  };
}

async function downloadFullMarkdown(archiveUrl: string) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "netchat-mineru-"));
  const archivePath = path.join(tempDirectory, "result.zip");

  try {
    const response = await fetch(archiveUrl);
    if (!response.ok) {
      throw new Error(`MinerU result download failed with HTTP ${response.status}.`);
    }

    const archiveBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(archivePath, archiveBuffer);
    const extractedEntries = await unzipArchiveToDirectory({
      archivePath,
      outputDirectory: path.join(tempDirectory, "unzipped"),
    });
    const markdownEntry = extractedEntries.find((entry) => path.basename(entry).toLowerCase() === "full.md") ?? null;
    if (!markdownEntry) {
      throw new Error("MinerU result archive did not contain full.md.");
    }

    const markdownContent = await readFile(markdownEntry, "utf8");
    if (!markdownContent.trim()) {
      throw new Error("MinerU generated an empty markdown file.");
    }

    return markdownContent;
  } finally {
    await rm(tempDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function unzipArchiveToDirectory(input: {
  archivePath: string;
  outputDirectory: string;
}) {
  await mkdir(input.outputDirectory, { recursive: true });
  const archiveBuffer = await readFile(input.archivePath);
  const extractedFiles: string[] = [];
  let offset = 0;

  while (offset + 30 <= archiveBuffer.length) {
    const signature = archiveBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = archiveBuffer.readUInt16LE(offset + 8);
    const compressedSize = archiveBuffer.readUInt32LE(offset + 18);
    const fileNameLength = archiveBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = archiveBuffer.readUInt16LE(offset + 28);
    const fileName = archiveBuffer.subarray(offset + 30, offset + 30 + fileNameLength).toString("utf8");
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const entryData = archiveBuffer.subarray(dataStart, dataEnd);
    const normalizedName = fileName.replace(/\\/g, "/");

    if (!normalizedName.includes("..") && normalizedName.length > 0) {
      const targetPath = path.join(input.outputDirectory, normalizedName);
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedOutputDirectory = path.resolve(input.outputDirectory);

      if (
        resolvedTargetPath === resolvedOutputDirectory ||
        resolvedTargetPath.startsWith(`${resolvedOutputDirectory}${path.sep}`)
      ) {
        if (normalizedName.endsWith("/")) {
          await mkdir(resolvedTargetPath, { recursive: true });
        } else {
          await mkdir(path.dirname(resolvedTargetPath), { recursive: true });
          const fileBuffer = decompressZipEntry(entryData, compressionMethod);
          await writeFile(resolvedTargetPath, fileBuffer);
          extractedFiles.push(resolvedTargetPath);
        }
      }
    }

    offset = dataEnd;
  }

  return extractedFiles;
}

function decompressZipEntry(buffer: Buffer, compressionMethod: number) {
  switch (compressionMethod) {
    case 0:
      return buffer;
    case 8:
      return zlib.inflateRawSync(buffer);
    default:
      throw new Error(`MinerU result archive used unsupported zip compression method ${compressionMethod}.`);
  }
}

function buildMineruDataId(fileName: string) {
  const baseName = fileName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "pdf";
  return `${baseName}-${randomUUID().slice(0, 12)}`;
}

function buildMineruHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "*/*",
  };
}

function resolveMineruErrorMessage(message: string | undefined, fallback: string) {
  const normalized = message?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

async function buildSiblingMarkdownPath(pdfPath: string) {
  const directoryPath = path.dirname(pdfPath);
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const preferredPath = path.join(directoryPath, `${baseName}.md`);
  if (!(await pathExists(preferredPath))) {
    return preferredPath;
  }

  const mineruPath = path.join(directoryPath, `${baseName}.mineru.md`);
  if (!(await pathExists(mineruPath))) {
    return mineruPath;
  }

  for (let index = 2; index <= 99; index += 1) {
    const candidatePath = path.join(directoryPath, `${baseName}.mineru-${index}.md`);
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
  }

  throw new Error("Could not determine an available markdown output path for the parsed PDF.");
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
