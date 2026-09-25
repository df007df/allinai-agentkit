import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig } from "./types.js";
import type { CliManual } from "../cli/docs.js";

/**
 * The built-in agentkit-system plugin: a local (non-git) plugin that ships
 * with the package and teaches an agent how to operate the client it runs
 * on — the allinai-agentkit command surface and the filesystem layout
 * (logs, state database, session records). It is written into the plugins
 * root idempotently on daemon start and synced like any other plugin, but
 * it has no gitUrl: its content is generated from the CLI manual data and
 * refreshed whenever the package version changes.
 */

export const SYSTEM_PLUGIN_ID = "agentkit-system";

export function systemPluginConfig(): PluginConfig {
  return {
    id: SYSTEM_PLUGIN_ID,
    // Sentinel gitUrl: never fetched — installSystemPlugin materializes the
    // repo locally before sync sees it, and the manager treats an existing
    // repository as a no-clone update target.
    gitUrl: "local://agentkit-system",
    enabled: true,
  };
}

export function renderSystemSkill(
  manual: Pick<CliManual, "commands" | "filesystem">,
  version: string,
): string {
  const commandTable = manual.commands
    .map(
      (command) =>
        `| \`allinai-agentkit ${command.name.replaceAll("|", "\\|")}\` | ${command.summary.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  const fsTable = manual.filesystem
    .map(
      (entry) =>
        `| \`${entry.path}\` | ${entry.description.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  return `---
name: client-control
description: Operate the AllInAI AgentKit client this agent runs on. Use when the user asks to install/remove or check plugins and skills, inspect daemon status or logs, list projects, or find where session records and state live. Generated from CLI v${version}.
---

# Client control (agentkit-system)

This client is managed by the AllInAI AgentKit daemon. You are running on
the same machine, so you can operate it with the \`allinai-agentkit\` CLI
and read its files directly.

## Command surface

| Command | Purpose |
| --- | --- |
${commandTable}

## Filesystem layout

| Path | Purpose |
| --- | --- |
${fsTable}

## Notes

- Daemon commands (\`status\`, \`plugins\`, \`projects\`, \`logs\`) talk to the
  running daemon over a local Unix socket; they fail if it is stopped.
- \`docs\` prints this manual in full — run it when you need details beyond
  the tables above.
- Plugin and skill delivery is git-based: plugin content lives under
  \`~/.allinai/agent/plugins/<id>/repo/\` and is updated by the daemon, not
  by manual edits.
`;
}

export type InstallSystemPluginInput = {
  pluginsRoot: string;
  manual: Pick<CliManual, "commands" | "filesystem">;
  version: string;
};

export type InstallSystemPluginResult = {
  repo: string;
  /** True when the content changed and was rewritten. */
  updated: boolean;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Ensures the materialized repo is a git repository with one commit on main. */
function ensureGitCommit(repo: string): void {
  const gitDir = join(repo, ".git");
  if (!existsSync(gitDir)) {
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "agentkit-system"]);
    git(repo, ["config", "user.email", "agentkit-system@local.invalid"]);
  }
  // Stage everything, then commit only when the index actually differs from
  // HEAD: repeated boots must leave HEAD untouched so an unchanged plugin
  // reports on-target instead of drifting forward on empty commits.
  git(repo, ["add", "-A"]);
  try {
    git(repo, ["diff", "--cached", "--quiet", "HEAD"]);
  } catch {
    git(repo, ["commit", "-m", "agentkit-system snapshot", "-q"]);
  }
}

/**
 * Materializes the built-in plugin repository under
 * `<pluginsRoot>/agentkit-system/repo/`. Idempotent: rewrites only when the
 * generated content differs (package upgrade), leaves runtime scratch files
 * alone, and never touches git — the manager treats an existing repo as an
 * update target and this plugin's sentinel gitUrl is never fetched.
 */
export function installSystemPlugin(
  input: InstallSystemPluginInput,
): InstallSystemPluginResult {
  const repo = join(input.pluginsRoot, SYSTEM_PLUGIN_ID, "repo");
  const skillMd = join(repo, "skills", "client-control", "SKILL.md");
  const next = renderSystemSkill(input.manual, input.version);

  const updated =
    !existsSync(skillMd) || readFileSync(skillMd, "utf8") !== next;
  if (updated || !existsSync(join(repo, ".git"))) {
    if (existsSync(skillMd)) {
      // Content changed (package upgrade): replace generated files only.
      rmSync(join(repo, "skills"), { recursive: true, force: true });
    }
    mkdirSync(join(repo, "skills", "client-control"), { recursive: true });
    writeFileSync(skillMd, next);
  }
  // The repo must be a git repo with a HEAD: the plugin manager resolves
  // resolvedCommit from it on every sync.
  ensureGitCommit(repo);
  return { repo, updated };
}
