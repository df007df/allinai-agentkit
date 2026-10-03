import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLATFORM_IDS, type PlatformId } from "../runtime/types.js";
import { validateCapabilityEntries } from "../capabilities/manifest.js";
import { createGitClient, isAllowedGitOrigin, type GitClient } from "./git.js";
import { isValidPluginId, parsePluginManifest } from "./manifest.js";
import { validateDelivery } from "./delivery.js";
import {
  dispatchToPlatform,
  targetPlatforms,
  type PlatformDispatcherDeps,
  type PlatformDispatchResult,
} from "./dispatch.js";
import type {
  ActivePluginSnapshot,
  InstalledPlugin,
  InstalledPluginWithOutcome,
  PluginConfig,
  PluginDeliveryEntry,
  PluginManifest,
  PluginStateStore,
  PluginSyncOutcome,
  PluginWarning,
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
  /**
   * Platform delivery dispatcher deps. When absent (or when
   * installedPlatforms is empty) no platform dispatch runs.
   */
  dispatcher?: PlatformDispatcherDeps;
  /** Platforms detected on this machine (probe results); drives filtering. */
  installedPlatforms?: ReadonlySet<string>;
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

/**
 * One persistent clone per plugin id. The active "directory" is this
 * repository's working tree; untracked files (runtime scratch caches) live
 * in it and survive every update because updates never recreate the tree.
 */
function repositoryPath(pluginsRoot: string, id: string): string {
  return path.join(pluginRoot(pluginsRoot, id), "repo");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isKnownCommit(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

const LOCAL_PLUGIN_URL = /^local:\/\//;

/** Built-in plugins use a sentinel URL and are never fetched. */
function isLocalPluginUrl(gitUrl: string): boolean {
  return LOCAL_PLUGIN_URL.test(gitUrl);
}

/**
 * The wire allows a full 40-hex commit in the legacy `ref` slot. Treat it
 * exactly like `commit`: a pinned target compared by hash, not a branch to
 * resolve through refs/remotes.
 */
function pinnedTarget(config: PluginConfig): string | undefined {
  if (config.commit) return config.commit;
  if (config.ref && isKnownCommit(config.ref.trim())) return config.ref.trim().toLowerCase();
  return undefined;
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
  if (
    config.commit !== undefined &&
    (typeof config.commit !== "string" ||
      !isKnownCommit(config.commit.trim()) ||
      config.commit.includes("\0"))
  ) {
    throw new TypeError(
      `Plugin ${config.id} commit must be a full 40-hex commit`,
    );
  }
  if (
    config.updatePolicy !== undefined &&
    config.updatePolicy !== "auto" &&
    config.updatePolicy !== "force"
  ) {
    throw new TypeError(
      `Plugin ${config.id} updatePolicy must be "auto" or "force"`,
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
    commit: config.commit?.trim().toLowerCase(),
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

/** Secret signatures that must never be installed, mirroring import-time scans. */
const BARE_SECRET = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})/;
const ASSIGNED_SECRET = /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?([^\s"',}]{12,})/i;

async function scanForSecrets(
  git: GitClient,
  repo: string,
  commit: string,
): Promise<void> {
  // Scan only tracked files at the target commit: untracked runtime scratch
  // files are the client's own data, not plugin content.
  const files = (await git.run(["-C", repo, "ls-tree", "-r", "--name-only", commit]))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const file of files) {
    const content = await git.run([
      "-C",
      repo,
      "show",
      "--end-of-options",
      `${commit}:${file}`,
    ]);
    if (BARE_SECRET.test(content) || ASSIGNED_SECRET.test(content)) {
      throw new Error(
        `Possible credential in ${file}; remove it from the plugin repository before installing`,
      );
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles Hub Git desired state into one local clone per plugin id.
 * Updates fetch and re-checkout the existing repository so untracked runtime
 * files survive; the working tree is only switched after the target commit's
 * manifest and capabilities validate, otherwise it is checked back.
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

  async sync(desired: PluginConfig[]): Promise<InstalledPluginWithOutcome[]> {
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
      if (ids.has(id)) continue;
      // Locally registered plugins are owned by this machine: a Hub
      // full-state push that simply omits them must not uninstall them.
      if (this.statuses.get(id)?.origin === "local") continue;
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

  /**
   * Report-only reconciliation: fetch and compare against the desired state
   * without switching commits. Used by CLI `check` and the Hub inventory.
   */
  async check(
    desired: PluginConfig[],
  ): Promise<Array<{ id: string } & Partial<PluginSyncOutcome> & { error?: string }>> {
    const results: Array<{ id: string } & Partial<PluginSyncOutcome> & { error?: string }> = [];
    for (const input of desired) {
      const id = input.id;
      try {
        const config = normalizeConfig(input);
        const repo = repositoryPath(this.options.pluginsRoot, config.id);
        if (!(await exists(repo))) {
          results.push({ id, error: "not installed" });
          continue;
        }
        const outcome = await this.inspect(config, repo);
        results.push({ id, ...outcome });
      } catch (error) {
        results.push({ id, error: errorMessage(error) });
      }
    }
    return results;
  }

  /**
   * Force-switch a plugin to an explicit commit, bypassing divergence checks.
   * The prior commit stays reachable in the repository history. Validation
   * failures roll the working tree back and surface as a failed record.
   */
  async forceTo(id: string, commit?: string): Promise<InstalledPlugin> {
    return this.withPluginLock(id, async () => {
      const current = this.statuses.get(id);
      if (!current) throw new Error(`Plugin ${id} is not installed`);
      const repo = repositoryPath(this.options.pluginsRoot, id);
      if (!(await exists(repo))) {
        throw new Error(`Plugin ${id} has no local repository to switch`);
      }
      const target = commit ?? current.resolvedCommit;
      if (!isKnownCommit(target)) {
        throw new TypeError("forceTo requires a full 40-hex commit");
      }
      const normalized = target.toLowerCase();
      const priorCommit = await this.resolveCommit(repo);
      await this.git.run([
        "-C",
        repo,
        "checkout",
        "--detach",
        "--force",
        normalized,
      ]);
      try {
        const manifest = await this.readManifest(repo);
        await validateCapabilityEntries(repo, manifest.capabilities ?? []);
        assertManifestCompatibility(current, manifest);
      } catch (error) {
        await this.git.run([
          "-C",
          repo,
          "checkout",
          "--detach",
          "--force",
          priorCommit,
        ]);
        const failed = this.failed(current, errorMessage(error));
        this.save({ plugin: failed, active: this.activePlugins.get(id) ?? null });
        return failed;
      }
      const plugin: InstalledPlugin = {
        ...current,
        resolvedCommit: normalized,
        status: "active",
        lastError: undefined,
      };
      await this.writePointer(id, plugin);
      this.save({ plugin, active: plugin });
      return plugin;
    });
  }

  /**
   * Unregisters one plugin: deactivate (which dispatches per-platform
   * removals and records the outcome) and drop it from active state. The
   * on-disk repository stays — a later install of the same id reuses it,
   * mirroring how Hub-removed plugins are handled.
   */
  async remove(id: string): Promise<InstalledPlugin | null> {
    return this.withPluginLock(id, async () => {
      const current = this.statuses.get(id);
      if (!current) return null;
      if (current.origin === undefined || current.origin === "hub") {
        // Registered on the Hub: local remove must not silently fight the
        // Hub's desired state — the Hub push would reinstall it.
        throw new Error(
          `Plugin ${id} is registered on the Hub; remove it from the Hub desired state instead`,
        );
      }
      await this.deactivate(id, "removed by local registration");
      return this.statuses.get(id) ?? null;
    });
  }

  private async syncOne(
    input: PluginConfig,
  ): Promise<InstalledPluginWithOutcome> {
    let config: PluginConfig | undefined;
    try {
      config = normalizeConfig(input);
      if (
        !isLocalPluginUrl(config.gitUrl) &&
        !this.validateGitUrl(config.gitUrl)
      ) {
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

      const repo = repositoryPath(this.options.pluginsRoot, config.id);
      if (!(await exists(repo))) {
        await this.initialClone(config, repo);
      } else {
        const outcome = await this.inspect(config, repo);
        // Local-only commits are never silently discarded, whatever the
        // policy says: force is an explicit operator action.
        if (outcome.aheadCount > 0) {
          return this.divergedResult(config, outcome);
        }
        const target = pinnedTarget(config);
        const onTarget =
          target !== undefined
            ? outcome.localHead === target
            : outcome.behind === false;
        // Tracked edits diverge under "auto"; under "force" only local-only
        // commits above still block, tracked dirt is overwritten by the
        // force checkout below.
        if (outcome.dirty && config.updatePolicy !== "force") {
          return this.divergedResult(config, outcome);
        }
        if (onTarget && !outcome.diverged) {
          const prior = this.activePlugins.get(config.id);
          const current: InstalledPluginWithOutcome = {
            ...(prior ?? config),
            resolvedCommit: outcome.resolvedCommit,
            localHead: outcome.localHead,
            diverged: undefined,
            aheadCount: 0,
            status: "active",
            installedAt: prior?.installedAt ?? now(),
          };
          this.save({ plugin: current, active: current });
          return { ...current, outcome: { ...outcome, diverged: false } };
        }
        await this.fetchTarget(config, repo);
      }

      const outcome = await this.checkoutValidated(config, repo);
      const active = await this.activate(config, outcome, repo);
      this.save({ plugin: active, active });
      return active;
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

  /**
   * Three-way comparison against the fetched remote state: untracked files
   * are the client's own runtime data and never count as divergence; only
   * tracked edits or local-only commits do.
   */
  private async inspect(
    config: PluginConfig,
    repo: string,
  ): Promise<PluginSyncOutcome & { dirty: boolean; behind: boolean }> {
    const localHead = await this.resolveCommit(repo);
    const status = await this.git.run(["-C", repo, "status", "--porcelain"]);
    const dirty = status
      .split("\n")
      .some((line) => line.length > 2 && !line.startsWith("??"));
    const pinned = pinnedTarget(config);
    if (pinned) {
      await this.git.run(["-C", repo, "fetch", "--force", "origin", pinned]);
      // A detached HEAD can carry local-only commits relative to the pinned
      // target just like a branch can; count them instead of assuming zero.
      const aheadCount = Number(
        await this.git.run([
          "-C",
          repo,
          "rev-list",
          "--count",
          `${pinned}..${localHead}`,
        ]),
      );
      const behind = aheadCount === 0 && localHead !== pinned;
      return {
        resolvedCommit: localHead,
        localHead,
        diverged: dirty || aheadCount > 0,
        aheadCount: Number.isSafeInteger(aheadCount) ? aheadCount : 0,
        dirty,
        behind,
      };
    }
    const ref = config.ref;
    if (isLocalPluginUrl(config.gitUrl)) {
      // Local (built-in) plugins: no remote to fetch; HEAD is current.
      return {
        resolvedCommit: localHead,
        localHead,
        diverged: dirty,
        aheadCount: 0,
        dirty,
        behind: false,
      };
    }
    if (!ref) {
      // No ref configured: fetch all branches so origin's HEAD is reachable.
      await this.git.run(["-C", repo, "fetch", "--force", "origin"]);
      const fetched = await this.git.run([
        "-C",
        repo,
        "rev-parse",
        "--verify",
        "--end-of-options",
        "FETCH_HEAD^{commit}",
      ]);
      return this.compareAgainst(config, repo, localHead, dirty, fetched);
    }
    await this.git.run(["-C", repo, "fetch", "--force", "origin", ref]);
    const fetched = await this.git.run([
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/remotes/origin/${ref}^{commit}`,
    ]);
    return this.compareAgainst(config, repo, localHead, dirty, fetched);
  }

  /** ahead/behind counts of localHead against the fetched remote commit. */
  private async compareAgainst(
    config: PluginConfig,
    repo: string,
    localHead: string,
    dirty: boolean,
    fetched: string,
  ): Promise<PluginSyncOutcome & { dirty: boolean; behind: boolean }> {
    const aheadCount = Number(
      await this.git.run([
        "-C",
        repo,
        "rev-list",
        "--count",
        `${fetched}..${localHead}`,
      ]),
    );
    const behindCount = Number(
      await this.git.run([
        "-C",
        repo,
        "rev-list",
        "--count",
        `${localHead}..${fetched}`,
      ]),
    );
    return {
      resolvedCommit: localHead,
      localHead,
      diverged: dirty || aheadCount > 0,
      aheadCount: Number.isSafeInteger(aheadCount) ? aheadCount : 0,
      dirty,
      behind: behindCount > 0,
    };
  }

  private divergedResult(
    config: PluginConfig,
    outcome: PluginSyncOutcome & { dirty: boolean },
  ): InstalledPluginWithOutcome {
    const prior = this.activePlugins.get(config.id);
    const plugin: InstalledPlugin = {
      ...(prior ?? config),
      resolvedCommit: outcome.resolvedCommit,
      localHead: outcome.localHead,
      diverged: true,
      aheadCount: outcome.aheadCount,
      status: prior?.status ?? "active",
      lastError: prior?.status === "active" ? undefined : prior?.lastError,
      installedAt: prior?.installedAt ?? now(),
      enabled: config.enabled,
      gitUrl: config.gitUrl,
      ref: config.ref,
      commit: config.commit,
      runtimes: config.runtimes,
      updatePolicy: config.updatePolicy,
    };
    this.save({ plugin, active: prior ?? null });
    return {
      ...plugin,
      outcome: {
        resolvedCommit: outcome.resolvedCommit,
        localHead: outcome.localHead,
        diverged: true,
        aheadCount: outcome.aheadCount,
      },
    };
  }

  private async initialClone(
    config: PluginConfig,
    repo: string,
  ): Promise<void> {
    await mkdir(path.dirname(repo), { recursive: true });
    // Local (built-in) plugins are materialized by the daemon, not cloned.
    if (isLocalPluginUrl(config.gitUrl)) {
      await mkdir(repo, { recursive: true });
      return;
    }
    try {
      await this.git.run(["clone", "--no-checkout", "--", config.gitUrl, repo]);
      await this.fetchTarget(config, repo);
    } catch (error) {
      await rm(repo, { recursive: true, force: true });
      throw error;
    }
  }

  private async fetchTarget(
    config: PluginConfig,
    repo: string,
  ): Promise<void> {
    // Local (built-in) plugins have no remote: their content is materialized
    // in place by the daemon, and HEAD is already current.
    if (isLocalPluginUrl(config.gitUrl)) return;
    const pinned = pinnedTarget(config);
    // fetch takes the REMOTE-side ref: pinned commits fetch by hash, branch
    // refs by their remote name. (checkoutTarget is the local counterpart.)
    await this.git.run([
      "-C",
      repo,
      "fetch",
      "--force",
      "origin",
      pinned ?? config.ref ?? "HEAD",
    ]);
  }

  /**
   * Switch the working tree to the desired commit only after the target's
   * manifest, capabilities, and secret scan validate; a failure checks the
   * prior commit back so the working tree is never left on an unvalidated
   * state. Non-fatal delivery warnings are collected for reporting.
   */
  private async checkoutValidated(
    config: PluginConfig,
    repo: string,
  ): Promise<PluginSyncOutcome & { warnings?: PluginWarning[] }> {
    const priorCommit = await this.resolveCommit(repo);
    // Resolve the branch target through origin BEFORE checkout: a bare
    // branch name in a detached repo resolves to the stale local
    // refs/heads/<ref>, silently re-checking out the old commit.
    const target = await this.checkoutTarget(config, repo);
    await this.git.run(["-C", repo, "checkout", "--detach", "--force", target]);
    try {
      const resolvedCommit = await this.resolveCommit(repo);
      const manifest = await this.readManifest(repo);
      await validateCapabilityEntries(repo, manifest.capabilities ?? []);
      assertManifestCompatibility(config, manifest);
      await scanForSecrets(this.git, repo, resolvedCommit);
      const warnings = await validateDelivery(repo, manifest);
      return {
        resolvedCommit,
        localHead: resolvedCommit,
        diverged: false,
        aheadCount: 0,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      await this.git.run([
        "-C",
        repo,
        "checkout",
        "--detach",
        "--force",
        priorCommit,
      ]);
      throw error;
    }
  }

  /**
   * The exact ref to hand to git checkout: pinned commits pass through,
   * branch refs resolve through their origin remote-tracking ref. Must be
   * called after fetchTarget has refreshed that remote-tracking ref.
   */
  private async checkoutTarget(
    config: PluginConfig,
    repo: string,
  ): Promise<string> {
    const pinned = pinnedTarget(config);
    if (pinned) return pinned;
    if (config.ref) return `refs/remotes/origin/${config.ref}`;
    if (isLocalPluginUrl(config.gitUrl)) return "HEAD";
    return "FETCH_HEAD";
  }

  private async resolveCommit(repo: string): Promise<string> {
    const commit = await this.git.run([
      "-C",
      repo,
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

  private async readManifest(repo: string): Promise<PluginManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(path.join(repo, "allinai-plugin.json"), "utf8"),
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
    outcome: PluginSyncOutcome & { warnings?: PluginWarning[] },
    repo: string,
  ): Promise<InstalledPluginWithOutcome> {
    const prior = this.activePlugins.get(config.id);
    const plugin: InstalledPlugin = {
      ...config,
      resolvedCommit: outcome.resolvedCommit,
      localHead: outcome.localHead,
      // A successful switch clears any prior divergence marks.
      diverged: undefined,
      aheadCount: 0,
      installedAt: prior?.installedAt ?? now(),
      status: "active",
      lastError: undefined,
      ...(outcome.warnings ? { warnings: outcome.warnings } : { warnings: undefined }),
    };
    // Platform delivery: install on every desired+installed platform.
    // Failures are warnings, not sync failures — the repo itself is already
    // validated and active — but every platform outcome is persisted so the
    // inventory (and the console) can show per-platform delivery state.
    const dispatchResults = await this.dispatchToPlatforms(
      config,
      repo,
      "install",
    );
    const dispatchWarnings = dispatchResults
      .filter((result) => result.state === "failed")
      .map((result) => ({
        platform: result.platform,
        code: "manifest_unknown_fields" as const,
        message: `Plugin ${config.id}: ${result.platform} dispatch failed: ${result.detail ?? "unknown error"}`,
      }));
    const pluginWithDelivery: InstalledPlugin = {
      ...plugin,
      ...(dispatchResults.length > 0 ? { delivery: dispatchResults } : {}),
    };
    await this.writePointer(config.id, pluginWithDelivery);
    this.activePlugins.set(config.id, pluginWithDelivery);
    const mergedOutcome: PluginSyncOutcome & { warnings?: PluginWarning[] } = {
      ...outcome,
      ...(dispatchWarnings.length > 0
        ? { warnings: [...(outcome.warnings ?? []), ...dispatchWarnings] }
        : {}),
    };
    return { ...pluginWithDelivery, outcome: mergedOutcome };
  }

  /**
   * Runs the platform dispatcher for the desired∩installed platforms.
   * Never throws: a failing platform install is a warning, not a sync
   * failure — the repo itself is already validated and active.
   */
  private async dispatchToPlatforms(
    config: PluginConfig,
    repo: string,
    op: "install" | "remove",
  ): Promise<PluginDeliveryEntry[]> {
    const { dispatcher, installedPlatforms } = this.options;
    if (!dispatcher || !installedPlatforms || installedPlatforms.size === 0) {
      return [];
    }
    const platforms = targetPlatforms(config.runtimes, installedPlatforms);
    const results: PlatformDispatchResult[] = [];
    for (const platform of platforms) {
      results.push(
        await dispatchToPlatform(
          platform,
          op,
          { id: config.id, repo },
          dispatcher,
        ),
      );
    }
    return results;
  }

  private async writePointer(
    id: string,
    plugin: InstalledPlugin,
  ): Promise<void> {
    const root = pluginRoot(this.options.pluginsRoot, id);
    await mkdir(root, { recursive: true });
    const pointer = activePointerPath(this.options.pluginsRoot, id);
    const temporaryPointer = path.join(
      root,
      `.active-${process.pid}-${Date.now()}.json`,
    );
    await writeFile(
      temporaryPointer,
      JSON.stringify({ plugin } satisfies ActivePointer),
      { encoding: "utf8", mode: 0o600 },
    );
    // Rename within the same directory keeps the pointer swap atomic.
    await rename(temporaryPointer, pointer);
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
    // Best-effort platform removal: the repo may already be gone (cleanup
    // path), and a failing uninstall must not block the state transition.
    // Outcomes replace the install-time delivery record so the inventory
    // reflects what is actually left on each platform.
    const repo = repositoryPath(this.options.pluginsRoot, id);
    let delivery: PluginDeliveryEntry[] | undefined;
    try {
      delivery = await this.dispatchToPlatforms(active, repo, "remove");
    } catch {
      // Deactivation proceeds regardless.
    }
    this.save({
      plugin: {
        ...active,
        enabled: false,
        status: "blocked",
        lastError: reason,
        ...(delivery && delivery.length > 0 ? { delivery } : { delivery: undefined }),
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

