import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig } from "./types.js";
import type { CliManual } from "../cli/docs.js";
import {
  claudeHookScriptSource,
  claudeHooksSettingsFragment,
} from "../claude-hooks.js";
import {
  codexHookScriptSource,
  codexHooksJsonSource,
} from "../codex-hooks.js";
import { piApprovalExtensionSource } from "../pi-approval-extension.js";

/**
 * The built-in agentkit-system plugin: a local (non-git) plugin that ships
 * with the package and teaches an agent how to operate the client it runs
 * on — the allinai-agentkit command surface and the filesystem layout
 * (logs, state database, session records). It is written into the plugins
 * root idempotently on daemon start and synced like any other plugin, but
 * it has no gitUrl: its content is generated from the CLI manual data and
 * refreshed whenever the package version changes.
 *
 * The plugin also carries per-platform tool ask-user hooks (claude
 * hooks/hooks.json + script, codex hooks/hooks.json + script) so gating is
 * delivered by enabling the plugin — scoped to the plugin, never installed
 * at user level.
 */

export const SYSTEM_PLUGIN_ID = "agentkit-system";

/** Loopback approval bridge URL; the daemon listens on this fixed port. */
export const DEFAULT_APPROVAL_ENDPOINT = "http://127.0.0.1:8787";

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
  /** Loopback approval bridge URL baked into the generated hook scripts. */
  approvalEndpoint?: string;
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
 *
 * Generated layout:
 * - skills/client-control/SKILL.md        — client-operation guidance
 * - hooks/hooks.json + hooks/pre-tool-use.sh — claude plugin hooks component
 * - codex/hooks/hooks.json + codex/hooks/pre-tool-use.sh — codex plugin hooks
 *   (referenced from .codex-plugin/plugin.json "hooks")
 */
export function installSystemPlugin(
  input: InstallSystemPluginInput,
): InstallSystemPluginResult {
  const repo = join(input.pluginsRoot, SYSTEM_PLUGIN_ID, "repo");
  const skillMd = join(repo, "skills", "client-control", "SKILL.md");
  const next = renderSystemSkill(input.manual, input.version);
  const endpoint = input.approvalEndpoint ?? DEFAULT_APPROVAL_ENDPOINT;

  // Claude hooks component: hooks/hooks.json (plugin-scoped) + script.
  // ${CLAUDE_PLUGIN_ROOT} resolves to this repo at platform load time.
  const claudeHookScript = join("${CLAUDE_PLUGIN_ROOT}", "hooks", "pre-tool-use.sh");
  const claudeHooksJson = `${JSON.stringify(
    claudeHooksSettingsFragment(claudeHookScript),
    null,
    2,
  )}\n`;
  const claudeScriptBody = claudeHookScriptSource(endpoint);
  const codexHooksJson = codexHooksJsonSource(
    join("${PLUGIN_ROOT}", "codex", "hooks", "pre-tool-use.sh"),
  );
  const codexScriptBody = codexHookScriptSource(endpoint);
  const piExtensionBody = piApprovalExtensionSource(endpoint);
  const piPackageJson = `${JSON.stringify(
    {
      name: "agentkit-system-bundle",
      keywords: ["pi-package"],
      pi: {
        skills: ["./skills"],
        extensions: ["./pi/extension.ts"],
      },
    },
    null,
    2,
  )}\n`;

  const generated: Array<{ path: string; body: string; mode?: number }> = [
    { path: skillMd, body: next },
    { path: join(repo, "hooks", "hooks.json"), body: claudeHooksJson },
    {
      path: join(repo, "hooks", "pre-tool-use.sh"),
      body: claudeScriptBody,
      mode: 0o755,
    },
    { path: join(repo, "codex", "hooks", "hooks.json"), body: codexHooksJson },
    {
      path: join(repo, "codex", "hooks", "pre-tool-use.sh"),
      body: codexScriptBody,
      mode: 0o755,
    },
    { path: join(repo, "pi", "extension.ts"), body: piExtensionBody },
    { path: join(repo, "package.json"), body: piPackageJson },
    // Codex plugin manifest: registers skills + the bundled hooks component
    // (plugin-scoped; trust still happens once in the codex TUI, or the
    // runner passes --dangerously-bypass-hook-trust for headless runs).
    {
      path: join(repo, ".codex-plugin", "plugin.json"),
      body: `${JSON.stringify(
        {
          name: SYSTEM_PLUGIN_ID,
          version: input.version,
          description: "AllInAI AgentKit built-in system plugin",
          author: { name: "AllInAI AgentKit" },
          skills: "./skills/",
          hooks: "./codex/hooks/hooks.json",
        },
        null,
        2,
      )}\n`,
    },
  ];

  const changed = generated.filter(
    (file) =>
      !existsSync(file.path) || readFileSync(file.path, "utf8") !== file.body,
  );
  const updated = changed.length > 0 || !existsSync(join(repo, ".git"));
  if (changed.length > 0) {
    for (const file of changed) {
      mkdirSync(join(file.path, ".."), { recursive: true });
      writeFileSync(file.path, file.body, { mode: file.mode ?? 0o644 });
    }
  }
  // The repo must be a git repo with a HEAD: the plugin manager resolves
  // resolvedCommit from it on every sync.
  ensureGitCommit(repo);
  return { repo, updated };
}
