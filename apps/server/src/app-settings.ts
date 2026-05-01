import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AppSettings, UpdateAppSettingsInput } from "@netchat/shared";

import { resolveWorkspaceRegistryRootDirectory } from "./workspace-store.js";

type AppSettingsSnapshot = {
  mineruApiToken?: unknown;
};

type PersistedAppSettings = {
  mineruApiToken: string | null;
};

export class AppSettingsStore {
  private readonly settingsPath: string;
  private settings: PersistedAppSettings;

  constructor() {
    const registryRoot = resolveWorkspaceRegistryRootDirectory();
    mkdirSync(registryRoot, { recursive: true });
    this.settingsPath = path.join(registryRoot, "app-settings.json");
    this.settings = this.readSettings();
  }

  getPublicSettings(): AppSettings {
    return {
      mineruApiTokenConfigured: Boolean(this.settings.mineruApiToken),
      mineruApiToken: this.settings.mineruApiToken ?? "",
    };
  }

  update(input: UpdateAppSettingsInput): AppSettings {
    this.settings = {
      mineruApiToken: normalizeToken(input.mineruApiToken),
    };
    this.writeSettings();
    return this.getPublicSettings();
  }

  getMineruApiToken() {
    return this.settings.mineruApiToken;
  }

  private readSettings(): PersistedAppSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        mineruApiToken: null,
      };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as AppSettingsSnapshot;
      return {
        mineruApiToken: normalizeToken(typeof parsed.mineruApiToken === "string" ? parsed.mineruApiToken : ""),
      };
    } catch {
      return {
        mineruApiToken: null,
      };
    }
  }

  private writeSettings() {
    writeFileSync(
      this.settingsPath,
      `${JSON.stringify(
        {
          mineruApiToken: this.settings.mineruApiToken,
        } satisfies PersistedAppSettings,
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

function normalizeToken(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
