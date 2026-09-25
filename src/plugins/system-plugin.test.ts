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
      logger: () => undefined,
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
