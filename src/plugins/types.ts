import type { PlatformId } from "../runtime/types.js";
import type { ShellCapability } from "../capabilities/types.js";

export type PluginConfig = {
  id: string;
  gitUrl: string;
  ref?: string;
  enabled: boolean;
  runtimes?: PlatformId[];
};

export type PluginCapabilityDeclaration = ShellCapability;

export type PluginManifest = {
  id: string;
  runtimes?: PlatformId[];
  capabilities?: PluginCapabilityDeclaration[];
};

export type InstalledPlugin = PluginConfig & {
  resolvedCommit: string;
  installedAt: string;
  status: "active" | "blocked" | "failed";
  lastError?: string;
};

export type ActivePluginSnapshot = {
  id: string;
  resolvedCommit: string;
};

/**
 * Durable plugin records are intentionally separate from an active pointer:
 * a failed update must be visible while the last validated checkout remains
 * runnable.
 */
export type StoredPluginState = {
  plugin: InstalledPlugin;
  active: InstalledPlugin | null;
};

export type PluginStateStore = {
  listPluginStates(): StoredPluginState[];
  savePluginState(state: StoredPluginState): void;
};
