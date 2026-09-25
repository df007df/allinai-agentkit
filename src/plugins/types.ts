import type { PlatformId } from "../runtime/types.js";
import type { ShellCapability } from "../capabilities/types.js";

export type PluginConfig = {
  id: string;
  gitUrl: string;
  ref?: string;
  /** Pin an exact commit; takes precedence over ref when both are present. */
  commit?: string;
  /**
   * What to do when the local repository has diverged (tracked edits or
   * local commits ahead of the fetched ref). "auto" (default) keeps the
   * local state and reports it; "force" overwrites with the desired state.
   */
  updatePolicy?: "auto" | "force";
  enabled: boolean;
  runtimes?: PlatformId[];
};

export type PluginCapabilityDeclaration = ShellCapability;

export type PluginManifest = {
  id: string;
  runtimes?: PlatformId[];
  capabilities?: PluginCapabilityDeclaration[];
  /**
   * Skill entries this plugin delivers to agent runtimes. Directory paths
   * relative to the plugin root, each containing a SKILL.md; a directory
   * path itself also works when it holds the conventional skills/ layout.
   */
  skills?: string[];
};

/** Non-fatal delivery problems found while validating a synced plugin. */
export type PluginWarning = {
  /** Which platform delivery the issue affects; "all" means every runtime. */
  platform: "claude" | "codex" | "pi" | "zcode" | "all";
  /** Machine-readable issue code for upstream filtering. */
  code:
    | "skill_missing"
    | "skill_missing_description"
    | "skill_name_mismatch"
    | "skill_name_invalid"
    | "skill_empty_dir"
    | "manifest_unknown_fields";
  /** Human-readable reminder shown on the client and reported to the hub. */
  message: string;
};

/** One platform's dispatch outcome for a synced plugin. */
export type PluginDeliveryEntry = {
  platform: "claude" | "codex" | "pi" | "zcode";
  state: "installed" | "removed" | "skipped" | "failed";
  detail?: string;
};

export type InstalledPlugin = PluginConfig & {
  resolvedCommit: string;
  installedAt: string;
  status: "active" | "blocked" | "failed";
  lastError?: string;
  /** Local working-repository HEAD; equals resolvedCommit unless diverged. */
  localHead?: string;
  /** True when tracked edits or local commits blocked the last sync. */
  diverged?: boolean;
  /** Commits the local HEAD was ahead of the target at the last sync. */
  aheadCount?: number;
  /** Non-fatal entry-file problems; a synced plugin still runs. */
  warnings?: PluginWarning[];
  /** Per-platform dispatch outcome of the last sync (one entry per platform). */
  delivery?: PluginDeliveryEntry[];
};

export type ActivePluginSnapshot = {
  id: string;
  resolvedCommit: string;
};

/** Outcome of reconciling one plugin against the desired state. */
export type PluginSyncOutcome = {
  /** Commit the working tree is on after this sync (unchanged when diverged). */
  resolvedCommit: string;
  /** Where the local HEAD actually is (differs from resolvedCommit when diverged). */
  localHead: string;
  /** True when tracked edits or local commits blocked an automatic update. */
  diverged: boolean;
  /** Commits the local HEAD is ahead of the fetched ref (0 when not ahead). */
  aheadCount: number;
  /** Non-fatal delivery entry-file problems found on the synced tree. */
  warnings?: PluginWarning[];
};

export type InstalledPluginWithOutcome = InstalledPlugin & {
  outcome?: PluginSyncOutcome;
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
