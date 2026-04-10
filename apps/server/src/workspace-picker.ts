import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function canPickWorkspaceFolder() {
  switch (process.platform) {
    case "win32":
    case "darwin":
      return true;
    case "linux":
      return commandExists("zenity");
    default:
      return false;
  }
}

export async function pickWorkspaceFolder() {
  switch (process.platform) {
    case "win32":
      return pickWorkspaceFolderOnWindows();
    case "darwin":
      return pickWorkspaceFolderOnMac();
    case "linux":
      return pickWorkspaceFolderOnLinux();
    default:
      throw new Error("This platform does not support the native workspace folder picker.");
  }
}

async function pickWorkspaceFolderOnWindows() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Open folder as workspace'",
    "$dialog.UseDescriptionForTitle = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: true,
  });
  return normalizeSelectedPath(stdout);
}

async function pickWorkspaceFolderOnMac() {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'set chosenFolder to choose folder with prompt "Open folder as workspace"',
      "-e",
      "POSIX path of chosenFolder",
    ]);
    return normalizeSelectedPath(stdout);
  } catch (error) {
    if (isPickerCancellation(error)) {
      return null;
    }

    throw new Error("The native macOS folder picker failed to open.");
  }
}

async function pickWorkspaceFolderOnLinux() {
  if (!commandExists("zenity")) {
    throw new Error("The native folder picker requires zenity to be installed on Linux.");
  }

  try {
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Open folder as workspace"]);
    return normalizeSelectedPath(stdout);
  } catch (error) {
    if (isPickerCancellation(error)) {
      return null;
    }

    throw new Error("The native Linux folder picker failed to open.");
  }
}

function commandExists(command: string) {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeSelectedPath(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isPickerCancellation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    code?: number | string;
    stderr?: string;
    message?: string;
  };
  const normalizedMessage = `${candidate.message ?? ""} ${candidate.stderr ?? ""}`.toLowerCase();
  return candidate.code === 1 || normalizedMessage.includes("user canceled");
}
