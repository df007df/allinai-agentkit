import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CliManual } from "../cli/docs.js";
import { PluginManager } from "./manager.js";
import {
  SYSTEM_PLUGIN_ID,
  installSystemPlugin,
  renderSystemSkill,
  systemPluginConfig,
} from "./system-plugin.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const manual: Pick<CliManual, "commands" | "filesystem"> = {
  commands: [
    { name: "status", summary: "Show daemon status" },
    { name: "plugins | list", summary: "List plugins with | pipes" },
  ],
  filesystem: [
    { path: "~/.allinai/agent", description: "Agent home" },
  ],
} as unknown as Pick<CliManual, "commands" | "filesystem">;

describe("system plugin", () => {
  it("renders a SKILL.md with command and filesystem tables", () => {
    const markdown = renderSystemSkill(manual, "9.9.9");
    assert.match(markdown, /^---\nname: client-control\n/);
    assert.match(
      markdown,
      /description: [^\n]*Generated from CLI v9\.9\.9\./,
    );
    assert.match(markdown, /`allinai-agentkit status` \| Show daemon status/);
    // Pipe characters inside cell content must be escaped to keep the table.
    assert.match(
      markdown,
      /`allinai-agentkit plugins \\| list` \| List plugins with \\\| pipes/,
    );
    assert.match(markdown, /`~\/\.allinai\/agent` \| Agent home/);
  });

  it("materializes the repo with a git HEAD and is idempotent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-system-plugin-"));
    directories.push(root);

    const first = installSystemPlugin({
      pluginsRoot: root,
      manual,
      version: "1.0.0",
    });
    const skillMd = path.join(
      first.repo,
      "skills",
      "client-control",
      "SKILL.md",
    );
    assert.ok(existsSync(skillMd));
    assert.equal(first.updated, true);
    // The manager resolves resolvedCommit from git, so a HEAD must exist.
    assert.match(git(first.repo, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/);

    const before = git(first.repo, ["rev-parse", "HEAD"]);
    const second = installSystemPlugin({
      pluginsRoot: root,
      manual,
      version: "1.0.0",
    });
    assert.equal(second.updated, false);
    assert.equal(git(second.repo, ["rev-parse", "HEAD"]), before);

    // A version bump rewrites the generated content and leaves a new commit.
    const third = installSystemPlugin({
      pluginsRoot: root,
      manual,
      version: "2.0.0",
    });
    assert.equal(third.updated, true);
    assert.match(
      readFileSync(skillMd, "utf8"),
      /Generated from CLI v2\.0\.0\./,
    );
    assert.notEqual(git(third.repo, ["rev-parse", "HEAD"]), before);
  });

  it("syncs through the plugin manager end to end via its sentinel URL", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-system-plugin-"));
    directories.push(root);

    const installed = installSystemPlugin({
      pluginsRoot: root,
      manual,
      version: "1.0.0",
    });
    const manager = new PluginManager({
      pluginsRoot: root,
      // local:// sentinel URLs are exempt from HTTPS/SSH origin policy; the
      // validator would reject them if it were consulted.
      validateGitUrl: () => false,
    });
    const outcome = (await manager.sync([systemPluginConfig()]))[0];
    assert.ok(outcome, "sync must return one outcome");
    assert.equal(outcome.status, "active");
    assert.equal(outcome.id, SYSTEM_PLUGIN_ID);
    // On-target syncs carry no divergence marker; the outcome extension is
    // only set when the manager actually diverged.
    assert.notEqual(outcome.diverged, true);
    assert.match(outcome.resolvedCommit, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(path.join(installed.repo, "skills", "client-control", "SKILL.md")));
  });
});

describe("system plugin hooks delivery", () => {
  const manual: Pick<CliManual, "commands" | "filesystem"> = {
    commands: [{ name: "status", summary: "Show daemon status" }],
    filesystem: [],
  } as unknown as Pick<CliManual, "commands" | "filesystem">;

  it("materializes claude and codex hook components with the approval endpoint", () => {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-system-hooks-"));
    directories.push(root);
    const result = installSystemPlugin({
      pluginsRoot: root,
      manual,
      version: "1.0.0",
      approvalEndpoint: "http://127.0.0.1:8787",
    });

    const claudeHooks = JSON.parse(
      readFileSync(path.join(result.repo, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    assert.equal(
      claudeHooks.hooks.PreToolUse[0]?.hooks[0]?.command,
      "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.sh",
    );
    const claudeScript = readFileSync(
      path.join(result.repo, "hooks", "pre-tool-use.sh"),
      "utf8",
    );
    assert.match(claudeScript, /http:\/\/127\.0\.0\.1:8787\/control\/tool-approval/);

    const codexHooks = JSON.parse(
      readFileSync(path.join(result.repo, "codex", "hooks", "hooks.json"), "utf8"),
    ) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    assert.match(
      codexHooks.hooks.PreToolUse[0]?.hooks[0]?.command ?? "",
      /PLUGIN_ROOT/,
    );
    const codexScript = readFileSync(
      path.join(result.repo, "codex", "hooks", "pre-tool-use.sh"),
      "utf8",
    );
    assert.match(codexScript, /control\/tool-approval/);

    const manifest = JSON.parse(
      readFileSync(path.join(result.repo, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { hooks: string; skills: string };
    assert.equal(manifest.hooks, "./codex/hooks/hooks.json");
    assert.equal(manifest.skills, "./skills/");
  });

  it("is idempotent across boots (no content churn)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-system-hooks-"));
    directories.push(root);
    const first = installSystemPlugin({ pluginsRoot: root, manual, version: "1.0.0" });
    const second = installSystemPlugin({ pluginsRoot: root, manual, version: "1.0.0" });
    assert.equal(first.updated, true);
    assert.equal(second.updated, false);
  });
});
