import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { PlatformId } from "../runtime/types.js";
import type { PluginWarning } from "./types.js";

export type PlatformDispatchPlatform = "claude" | "codex" | "pi" | "zcode";

export type PlatformDispatchResult = {
  platform: PlatformDispatchPlatform;
  state: "installed" | "removed" | "skipped" | "failed";
  detail?: string;
};

export type PlatformDispatcherDeps = {
  /** Command existence probe (mirrors the runtime probe semantics). */
  which: (name: string) => Promise<string | null>;
  /** Codex CLI command; defaults to "codex". Tests inject a stub. */
  codexCommand?: string;
  /** Pi CLI command; defaults to "pi". Tests inject a stub. */
  piCommand?: string;
};

/**
 * Installs or removes a synced plugin repository on one platform's
 * marketplace/package system. Claude is intentionally absent: its plugin
 * loading is a per-run `--plugin-dir` argument (handled by the adapter),
 * so there is nothing to install here and nothing to clean up.
 */
export async function dispatchToPlatform(
  platform: PlatformDispatchPlatform,
  op: "install" | "remove",
  plugin: { id: string; repo: string },
  deps: PlatformDispatcherDeps,
): Promise<PlatformDispatchResult> {
  if (platform === "claude") {
    // Nothing to do: claude consumes the repo path at run time.
    return { platform, state: "skipped", detail: "runtime_plugin_dir" };
  }
  if (platform === "zcode") {
    // Native skill directory delivery not wired yet.
    return { platform, state: "skipped", detail: "not_wired" };
  }

  if (platform === "codex") {
    const cli = deps.codexCommand ?? "codex";
    if (!(await deps.which(cli))) {
      return { platform, state: "skipped", detail: "platform_not_installed" };
    }
    if (op === "install") {
      // Marketplace registration is idempotent per path; plugin add is
      // idempotent per (name, marketplace). Re-run on every sync so a new
      // resolvedCommit gets re-installed into the cache (codex copies).
      const addMarketplace = await runCli(cli, [
        "plugin",
        "marketplace",
        "add",
        plugin.repo,
      ]);
      if (addMarketplace.code !== 0) {
        return {
          platform,
          state: "failed",
          detail: addMarketplace.stderr.trim() || "marketplace add failed",
        };
      }
      const add = await runCli(cli, [
        "plugin",
        "add",
        `${plugin.id}@${plugin.id}-repo`,
      ]);
      if (add.code !== 0) {
        return {
          platform,
          state: "failed",
          detail: add.stderr.trim() || "plugin add failed",
        };
      }
      return { platform, state: "installed" };
    }
    const remove = await runCli(cli, [
      "plugin",
      "remove",
      `${plugin.id}@${plugin.id}-repo`,
    ]);
    // remove on a never-installed plugin fails; treat as already-clean.
    return {
      platform,
      state: remove.code === 0 ? "removed" : "removed",
      detail: remove.code === 0 ? undefined : remove.stderr.trim(),
    };
  }

  // pi: local-path install registers the repo in settings.json without
  // copying, so a repo update is live on the next session automatically.
  const cli = deps.piCommand ?? "pi";
  if (!(await deps.which(cli))) {
    return { platform, state: "skipped", detail: "platform_not_installed" };
  }
  if (op === "install") {
    const install = await runCli(cli, ["install", plugin.repo]);
    if (install.code !== 0) {
      return {
        platform,
        state: "failed",
        detail: install.stderr.trim() || "pi install failed",
      };
    }
    return { platform, state: "installed" };
  }
  const remove = await runCli(cli, ["remove", plugin.repo]);
  return {
    platform,
    state: remove.code === 0 ? "removed" : "removed",
    detail: remove.code === 0 ? undefined : remove.stderr.trim(),
  };
}

function runCli(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Convenience wrapper: the set of platforms a plugin should be dispatched
 * to, given the desired runtimes (undefined = all) and the machine's
 * installed-platform probe results.
 */
export function targetPlatforms(
  desired: PlatformId[] | undefined,
  installed: ReadonlySet<string>,
): PlatformDispatchPlatform[] {
  const all: PlatformDispatchPlatform[] = ["claude", "codex", "pi"];
  const wanted = desired
    ? all.filter((platform) => desired.includes(platform as PlatformId))
    : all;
  return wanted.filter(
    (platform) => platform === "claude" || installed.has(platform),
  );
}

/** Warn helper shared with delivery validation messages. */
export function dispatchWarning(
  pluginId: string,
  result: PlatformDispatchResult,
): PluginWarning | null {
  if (result.state !== "failed") return null;
  return {
    platform: result.platform,
    code: "manifest_unknown_fields",
    message: `Plugin ${pluginId}: ${result.platform} dispatch failed: ${result.detail ?? "unknown error"}`,
  };
}

/** True when the repo directory looks like a synced plugin checkout. */
export function isSyncedRepo(pluginsRoot: string, id: string): boolean {
  return existsSync(join(pluginsRoot, id, "repo"));
}
