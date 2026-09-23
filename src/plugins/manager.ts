import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PLATFORM_IDS, type PlatformId } from "../runtime/types.js";
import { validateCapabilityEntries } from "../capabilities/manifest.js";
import { createGitClient, isAllowedGitOrigin, type GitClient } from "./git.js";
import { isValidPluginId, parsePluginManifest } from "./manifest.js";
import type {
  ActivePluginSnapshot,
  InstalledPlugin,
  PluginConfig,
  PluginManifest,
  PluginStateStore,
} from "./types.js";

type ActivePointer = {
  plugin: InstalledPlugin;
};

export type PluginManagerOptions = {
  pluginsRoot: string;
  git?: GitClient;
  /** Empty means any production HTTPS/SSH origin is trusted until tightened locally. */
  allowedGitOrigins?: readonly string[];
  /** Tests must inject this to use a local fixture repository. */
  validateGitUrl?: (gitUrl: string) => boolean;
  stateStore?: PluginStateStore;
};

function now(): string {
  return new Date().toISOString();
}

function hasRuntime(value: unknown): value is PlatformId {
  return (
    typeof value === "string" && PLATFORM_IDS.includes(value as PlatformId)
  );
}

function pluginRoot(pluginsRoot: string, id: string): string {
  return path.join(pluginsRoot, id);
}

function activePointerPath(pluginsRoot: string, id: string): string {
  return path.join(pluginRoot(pluginsRoot, id), "active.json");
}

function revisionPath(pluginsRoot: string, id: string, commit: string): string {
  return path.join(pluginRoot(pluginsRoot, id), "revisions", commit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownCommit(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function normalizeConfig(config: PluginConfig): PluginConfig {
  if (!isValidPluginId(config.id)) {
    throw new TypeError(`Plugin id ${String(config.id)} is invalid`);
  }
  if (typeof config.gitUrl !== "string" || config.gitUrl.length === 0) {
    throw new TypeError(`Plugin ${config.id} must declare a Git URL`);
  }
  if (
    config.ref !== undefined &&
    (typeof config.ref !== "string" ||
      !config.ref.trim() ||
      config.ref.trim().startsWith("-") ||
      config.ref.includes("\0"))
  ) {
    throw new TypeError(
      `Plugin ${config.id} ref must be a nonempty non-option string`,
    );
  }
  if (typeof config.enabled !== "boolean") {
    throw new TypeError(`Plugin ${config.id} enabled must be a boolean`);
  }
  if (
    config.runtimes !== undefined &&
    (!Array.isArray(config.runtimes) ||
      !config.runtimes.every(hasRuntime) ||
      new Set(config.runtimes).size !== config.runtimes.length)
  ) {
    throw new TypeError(`Plugin ${config.id} has invalid runtimes`);
  }
  return {
    ...config,
    ref: config.ref?.trim(),
    runtimes: config.runtimes ? [...config.runtimes] : undefined,
  };
}

function assertManifestCompatibility(
  config: PluginConfig,
  manifest: PluginManifest,
): void {
  if (manifest.id !== config.id) {
    throw new Error(
      `Plugin manifest id ${manifest.id} does not match configured id ${config.id}`,
    );
  }
  if (
    config.runtimes &&
    manifest.runtimes &&
    config.runtimes.some((runtime) => !manifest.runtimes?.includes(runtime))
  ) {
    throw new Error(
      `Plugin ${config.id} requests runtimes not declared by its manifest`,
    );
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles Hub Git desired state into local, immutable plugin revisions.
 * Activation changes a small same-directory pointer only after the complete
 * checkout and its manifest have been validated.
 */
export class PluginManager {
  private readonly git: GitClient;
  private readonly validateGitUrl: (gitUrl: string) => boolean;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly statuses = new Map<string, InstalledPlugin>();
  private readonly activePlugins = new Map<string, InstalledPlugin>();

  constructor(private readonly options: PluginManagerOptions) {
    this.git = options.git ?? createGitClient();
    this.validateGitUrl =
      options.validateGitUrl ??
      ((gitUrl) => isAllowedGitOrigin(gitUrl, options.allowedGitOrigins ?? []));
    for (const state of options.stateStore?.listPluginStates() ?? []) {
      this.statuses.set(state.plugin.id, state.plugin);
      if (state.active) this.activePlugins.set(state.active.id, state.active);
    }
  }

  async sync(desired: PluginConfig[]): Promise<InstalledPlugin[]> {
    const ids = new Set<string>();
    for (const config of desired) {
      if (ids.has(config.id)) {
        throw new TypeError(
          `Duplicate plugin id in desired state: ${config.id}`,
        );
      }
      ids.add(config.id);
    }

    const results = await Promise.all(
      desired.map((config) =>
        this.withPluginLock(config.id, () => this.syncOne(config)),
      ),
    );

    for (const id of [...this.activePlugins.keys()]) {
      if (!ids.has(id))
        await this.withPluginLock(id, () =>
          this.deactivate(id, "removed from desired state"),
        );
    }
    return results;
  }

  active(runtime: PlatformId): InstalledPlugin[] {
    return [...this.activePlugins.values()]
      .filter(
        (plugin) =>
          plugin.status === "active" &&
          plugin.enabled &&
          (plugin.runtimes === undefined || plugin.runtimes.includes(runtime)),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  status(id: string): InstalledPlugin | null {
    return this.statuses.get(id) ?? null;
  }

  snapshotActivePlugins(runtime?: PlatformId): ActivePluginSnapshot[] {
    const plugins = runtime
      ? this.active(runtime)
      : [...this.activePlugins.values()].filter(
          (plugin) => plugin.status === "active" && plugin.enabled,
        );
    return plugins
      .map(({ id, resolvedCommit }) => ({ id, resolvedCommit }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async syncOne(input: PluginConfig): Promise<InstalledPlugin> {
    let config: PluginConfig | undefined;
    try {
      config = normalizeConfig(input);
      if (!this.validateGitUrl(config.gitUrl)) {
        throw new TypeError(
          "Plugin Git URL must use HTTPS or SSH and pass local origin policy",
        );
      }
      if (!config.enabled) {
        await this.deactivate(config.id, "disabled by desired state");
        const prior = this.statuses.get(config.id);
        if (prior) return prior;
        const blocked: InstalledPlugin = {
          ...config,
          resolvedCommit: "unresolved",
          installedAt: now(),
          status: "blocked",
          lastError: "disabled by desired state",
        };
        this.save({ plugin: blocked, active: null });
        return blocked;
      }

      const staging = await this.createStagingDirectory();
      try {
        await this.checkout(staging, config);
        const manifest = await this.readManifest(staging);
        await validateCapabilityEntries(staging, manifest.capabilities ?? []);
        assertManifestCompatibility(config, manifest);
        const resolvedCommit = await this.resolveCommit(staging);
        const active = await this.activate(config, resolvedCommit, staging);
        this.save({ plugin: active, active });
        return active;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      const configForFailure = config ?? input;
      const failed = this.failed(configForFailure, errorMessage(error));
      this.save({
        plugin: failed,
        active: this.activePlugins.get(configForFailure.id) ?? null,
      });
      return failed;
    }
  }

  private async checkout(staging: string, config: PluginConfig): Promise<void> {
    await this.git.run([
      "clone",
      "--no-checkout",
      "--",
      config.gitUrl,
      staging,
    ]);
    if (config.ref) {
      await this.git.run([
        "-C",
        staging,
        "fetch",
        "--force",
        "origin",
        config.ref,
      ]);
      await this.git.run([
        "-C",
        staging,
        "checkout",
        "--detach",
        "--force",
        config.ref,
      ]);
    } else {
      await this.git.run([
        "-C",
        staging,
        "checkout",
        "--detach",
        "--force",
        "HEAD",
      ]);
    }
  }

  private async resolveCommit(staging: string): Promise<string> {
    const commit = await this.git.run([
      "-C",
      staging,
      "rev-parse",
      "--verify",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
    if (!isKnownCommit(commit)) {
      throw new Error(
        "Git did not resolve the plugin revision to a full commit",
      );
    }
    return commit.toLowerCase();
  }

  private async readManifest(staging: string): Promise<PluginManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(path.join(staging, "allinai-plugin.json"), "utf8"),
      ) as unknown;
    } catch (error) {
      throw new Error(
        `Plugin manifest could not be read: ${errorMessage(error)}`,
      );
    }
    const manifest = parsePluginManifest(raw);
    if (!manifest) throw new Error("Plugin manifest is invalid");
    return manifest;
  }

  private async activate(
    config: PluginConfig,
    resolvedCommit: string,
    staging: string,
  ): Promise<InstalledPlugin> {
    const root = pluginRoot(this.options.pluginsRoot, config.id);
    const revision = revisionPath(
      this.options.pluginsRoot,
      config.id,
      resolvedCommit,
    );
    await mkdir(path.dirname(revision), { recursive: true });
    if (await exists(revision)) {
      await rm(staging, { recursive: true, force: true });
    } else {
      await rename(staging, revision);
    }

    const plugin: InstalledPlugin = {
      ...config,
      resolvedCommit,
      installedAt: now(),
      status: "active",
    };
    const pointer = activePointerPath(this.options.pluginsRoot, config.id);
    const temporaryPointer = path.join(
      root,
      `.active-${process.pid}-${Date.now()}.json`,
    );
    await writeFile(
      temporaryPointer,
      JSON.stringify({ plugin } satisfies ActivePointer),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await rename(temporaryPointer, pointer);
    this.activePlugins.set(config.id, plugin);
    return plugin;
  }

  private failed(config: PluginConfig, lastError: string): InstalledPlugin {
    const previous =
      this.activePlugins.get(config.id) ?? this.statuses.get(config.id);
    return {
      ...config,
      resolvedCommit: previous?.resolvedCommit ?? "unresolved",
      installedAt: previous?.installedAt ?? now(),
      status: "failed",
      lastError,
    };
  }

  private async deactivate(id: string, reason: string): Promise<void> {
    const active = this.activePlugins.get(id);
    if (!active) return;
    await rm(activePointerPath(this.options.pluginsRoot, id), { force: true });
    this.activePlugins.delete(id);
    this.save({
      plugin: {
        ...active,
        enabled: false,
        status: "blocked",
        lastError: reason,
      },
      active: null,
    });
  }

  private save(state: {
    plugin: InstalledPlugin;
    active: InstalledPlugin | null;
  }): void {
    this.statuses.set(state.plugin.id, state.plugin);
    if (state.active) this.activePlugins.set(state.active.id, state.active);
    this.options.stateStore?.savePluginState(state);
  }

  private async createStagingDirectory(): Promise<string> {
    await mkdir(this.options.pluginsRoot, { recursive: true });
    const base = path.join(this.options.pluginsRoot, ".staging-");
    const { mkdtemp } = await import("node:fs/promises");
    return mkdtemp(base);
  }

  private async withPluginLock<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}
