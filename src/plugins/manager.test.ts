import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createGitClient, type GitClient } from "./git.js";
import { PluginManager } from "./manager.js";
import type { PluginConfig } from "./types.js";
import type { PlatformDispatcherDeps } from "./dispatch.js";
import { ClientStateStore } from "../client/state-store.js";

type Fixture = {
  root: string;
  goodCommit: string;
  badCommit: string;
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-fixture-"));
  directories.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "agent-client@example.test"]);
  git(root, ["config", "user.name", "Agent Client Test"]);
  writeFileSync(
    path.join(root, "allinai-plugin.json"),
    JSON.stringify({ id: "demo", runtimes: ["codex"] }),
  );
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "bin", "placeholder.mjs"), "export {};\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "good plugin"]);
  const goodCommit = git(root, ["rev-parse", "HEAD"]);

  writeFileSync(
    path.join(root, "allinai-plugin.json"),
    JSON.stringify({ id: "other", runtimes: ["codex"] }),
  );
  git(root, ["add", "allinai-plugin.json"]);
  git(root, ["commit", "-m", "invalid plugin"]);
  return { root, goodCommit, badCommit: git(root, ["rev-parse", "HEAD"]) };
}

function desired(repo: string, ref: string): PluginConfig {
  return {
    id: "demo",
    gitUrl: repo,
    ref,
    enabled: true,
    runtimes: ["codex"],
  };
}

function createManager(
  pluginsRoot: string,
  options: { git?: GitClient } = {},
): PluginManager {
  return new PluginManager({
    pluginsRoot,
    git: options.git,
    // Local repositories are permitted only by this explicit test transport.
    validateGitUrl: () => true,
  });
}

/** Stub dispatcher deps whose CLI is a real exit-0 script. */
function stubDispatcher(): PlatformDispatcherDeps {
  const dir = mkdtempSync(path.join(tmpdir(), "plugin-dispatch-stub-"));
  directories.push(dir);
  const stub = (name: string): string => {
    const script = path.join(dir, name);
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return script;
  };
  return {
    which: async () => "/usr/bin/stub",
    codexCommand: stub("codex"),
    piCommand: stub("pi"),
  };
}

describe("PluginManager", () => {
  it("records an immutable resolved commit and exposes an active runtime snapshot", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    const installed = await manager.sync([
      desired(fixture.root, fixture.goodCommit),
    ]);

    assert.equal(installed[0]?.resolvedCommit, fixture.goodCommit);
    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
    assert.deepEqual(manager.snapshotActivePlugins(), [
      { id: "demo", resolvedCommit: fixture.goodCommit },
    ]);
  });

  it("persists installation status and the active snapshot in the client state database", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const state = new ClientStateStore(path.join(root, "state.db"));
    try {
      const manager = new PluginManager({
        pluginsRoot: path.join(root, "plugins"),
        stateStore: state,
        validateGitUrl: () => true,
      });
      await manager.sync([desired(fixture.root, fixture.goodCommit)]);

      assert.equal(
        state.listPluginStates()[0]?.plugin.resolvedCommit,
        fixture.goodCommit,
      );
      assert.equal(state.listPluginStates()[0]?.active?.status, "active");
      const restarted = new PluginManager({
        pluginsRoot: path.join(root, "plugins"),
        stateStore: state,
        validateGitUrl: () => true,
      });
      assert.deepEqual(restarted.snapshotActivePlugins(), [
        { id: "demo", resolvedCommit: fixture.goodCommit },
      ]);
    } finally {
      state.close();
    }
  });

  it("keeps the prior active commit when a fetched revision has no valid manifest", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    await manager.sync([desired(fixture.root, fixture.goodCommit)]);
    const result = await manager.sync([
      desired(fixture.root, fixture.badCommit),
    ]);

    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
    assert.equal(manager.status("demo")?.status, "failed");
    assert.equal(result[0]?.status, "failed");
    assert.equal(result[0]?.resolvedCommit, fixture.goodCommit);
  });

  it("keeps the prior activation when a capability entry resolves through a symlink escape", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    const outside = mkdtempSync(path.join(tmpdir(), "allinai-plugin-outside-"));
    directories.push(root, outside);
    git(fixture.root, ["checkout", "--detach", fixture.goodCommit]);
    writeFileSync(path.join(outside, "escape.mjs"), "export {};\n");
    symlinkSync(
      path.join(outside, "escape.mjs"),
      path.join(fixture.root, "bin", "escape.mjs"),
    );
    writeFileSync(
      path.join(fixture.root, "allinai-plugin.json"),
      JSON.stringify({
        id: "demo",
        runtimes: ["codex"],
        capabilities: [
          {
            id: "demo.escape",
            entry: "bin/escape.mjs",
            inputSchema: { type: "object" },
            contextKeys: [],
            permissions: [],
            timeoutSeconds: 30,
          },
        ],
      }),
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "capability symlink escape"]);
    const escapingCommit = git(fixture.root, ["rev-parse", "HEAD"]);
    const manager = createManager(root);

    await manager.sync([desired(fixture.root, fixture.goodCommit)]);
    const result = await manager.sync([desired(fixture.root, escapingCommit)]);

    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
    assert.equal(result[0]?.status, "failed");
    assert.match(
      result[0]?.lastError ?? "",
      /resolves outside the plugin root/,
    );
  });

  it("serializes concurrent updates for one plugin id", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const realGit = createGitClient();
    let inFlight = 0;
    let peak = 0;
    const gitClient: GitClient = {
      async run(args, options) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return await realGit.run(args, options);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const manager = createManager(root, { git: gitClient });

    await Promise.all([
      manager.sync([desired(fixture.root, fixture.goodCommit)]),
      manager.sync([desired(fixture.root, fixture.goodCommit)]),
    ]);

    assert.equal(peak, 1);
    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
  });

  it("rejects a local Git path unless a test transport explicitly overrides production validation", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = new PluginManager({ pluginsRoot: root });

    const result = await manager.sync([
      desired(fixture.root, fixture.goodCommit),
    ]);

    assert.equal(result[0]?.status, "failed");
    assert.match(result[0]?.lastError ?? "", /HTTPS or SSH/);
    assert.deepEqual(manager.active("codex"), []);
  });

  it("rejects option-looking refs before invoking Git", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    let calls = 0;
    const manager = new PluginManager({
      pluginsRoot: root,
      validateGitUrl: () => true,
      git: {
        async run(): Promise<string> {
          calls += 1;
          return "";
        },
      },
    });

    const result = await manager.sync([
      desired("https://github.com/allin-ai/demo.git", "--unsafe"),
    ]);

    assert.equal(calls, 0);
    assert.equal(result[0]?.status, "failed");
    assert.match(result[0]?.lastError ?? "", /non-option/);
  });

  it("reuses one repository per plugin id and keeps untracked files across updates", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    await manager.sync([desired(fixture.root, fixture.goodCommit)]);
    const repo = path.join(root, "demo", "repo");
    writeFileSync(path.join(repo, "runtime-cache.tmp"), "scratch");
    git(repo, ["checkout", "--detach", fixture.badCommit]);
    // Put the tree back on the good commit so the next sync sees a clean state.
    git(repo, ["checkout", "--detach", "--force", fixture.goodCommit]);

    const result = await manager.sync([desired(fixture.root, fixture.goodCommit)]);

    assert.equal(result[0]?.outcome?.diverged, false);
    assert.equal(result[0]?.resolvedCommit, fixture.goodCommit);
    assert.equal(
      readFileSync(path.join(repo, "runtime-cache.tmp"), "utf8"),
      "scratch",
    );
  });

  it("reports divergence for local-only commits and refuses to overwrite", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);
    await manager.sync([desired(fixture.root, fixture.goodCommit)]);

    // Advance upstream while the client carries a local commit of its own.
    const repo = path.join(root, "demo", "repo");
    writeFileSync(path.join(repo, "local-note.txt"), "agent edit");
    git(repo, ["add", "local-note.txt"]);
    git(repo, ["commit", "-m", "local tweak"]);

    const result = await manager.sync([desired(fixture.root, fixture.goodCommit)]);

    assert.equal(result[0]?.outcome?.diverged, true);
    assert.equal(result[0]?.outcome?.aheadCount, 1);
    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
  });

  it("forceTo switches an explicit commit and validates the working tree", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);
    await manager.sync([desired(fixture.root, fixture.goodCommit)]);

    const plugin = await manager.forceTo("demo", fixture.badCommit);
    assert.equal(plugin.status, "failed");
    assert.match(plugin.lastError ?? "", /does not match configured id/);

    const restored = await manager.forceTo("demo", fixture.goodCommit);
    assert.equal(restored.status, "active");
    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
  });

  it("rejects a target commit containing credential-looking content", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);
    await manager.sync([desired(fixture.root, fixture.goodCommit)]);

    writeFileSync(
      path.join(fixture.root, "allinai-plugin.json"),
      JSON.stringify({ id: "demo", runtimes: ["codex"] }),
    );
    writeFileSync(path.join(fixture.root, "config.env"), "token = sk-abcdefghijklmnop1234\n");
    git(fixture.root, ["add", "config.env", "allinai-plugin.json"]);
    git(fixture.root, ["commit", "-m", "leak"]);
    const leakCommit = git(fixture.root, ["rev-parse", "HEAD"]);

    const result = await manager.sync([desired(fixture.root, leakCommit)]);
    assert.equal(result[0]?.status, "failed");
    assert.match(result[0]?.lastError ?? "", /credential/i);
    assert.equal(
      manager.active("codex")[0]?.resolvedCommit,
      fixture.goodCommit,
    );
  });

  it("pins an exact commit ahead of the configured ref", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    const result = await manager.sync([
      { ...desired(fixture.root, "main"), commit: fixture.goodCommit },
    ]);

    assert.equal(result[0]?.status, "active");
    assert.equal(result[0]?.resolvedCommit, fixture.goodCommit);
  });

  it("persists per-platform delivery outcomes and reports them in the sync outcome", async () => {
    const fixture = createFixture();
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-delivery-"));
    directories.push(root);
    const state = new ClientStateStore(path.join(root, "state.db"));
    try {
      const manager = new PluginManager({
        pluginsRoot: path.join(root, "plugins"),
        stateStore: state,
        validateGitUrl: () => true,
        installedPlatforms: new Set(["codex", "pi", "claude"]),
        dispatcher: stubDispatcher(),
      });
      const [installed] = await manager.sync([
        desired(fixture.root, fixture.goodCommit),
      ]);
      assert.equal(installed?.status, "active");

      // The outcome and the persisted state both carry the dispatch result
      // for every targeted platform. The fixture declares runtimes: ["codex"],
      // so codex installs (stub CLI) and that is the only target.
      const expected = [{ platform: "codex", state: "installed" }];
      assert.deepEqual(installed?.delivery, expected);
      assert.deepEqual(state.listPluginStates()[0]?.plugin.delivery, expected);
    } finally {
      state.close();
    }
  });
});

describe("PluginManager delivery validation", () => {
  function gitFixture(): { root: string; commit: () => string } {
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-dlv-"));
    directories.push(root);
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "T"]);
    return { root, commit: () => git(root, ["rev-parse", "HEAD"]) };
  }

  it("warns when skills/ exists but the manifest declares no skills field", async () => {
    const fixture = gitFixture();
    mkdirSync(path.join(fixture.root, "skills", "demo"), { recursive: true });
    writeFileSync(
      path.join(fixture.root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nbody\n",
    );
    writeFileSync(
      path.join(fixture.root, "allinai-plugin.json"),
      JSON.stringify({ id: "demo", runtimes: ["codex"] }),
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "v"]);
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    const result = await manager.sync([desired(fixture.root, fixture.commit())]);

    assert.equal(result[0]?.status, "active");
    const warnings = result[0]?.outcome?.warnings ?? [];
    assert.equal(warnings[0]?.code, "skill_empty_dir");
    assert.match(warnings[0]?.message ?? "", /skills.*contains 1 skill/);
  });

  it("warns per platform when delivery entry files are missing", async () => {
    const fixture = gitFixture();
    writeFileSync(
      path.join(fixture.root, "allinai-plugin.json"),
      JSON.stringify({ id: "demo", runtimes: ["codex"], skills: [] }),
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "v"]);
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);

    const result = await manager.sync([desired(fixture.root, fixture.commit())]);

    const warnings = result[0]?.outcome?.warnings ?? [];
    const platforms = warnings.map((warning) => warning.platform).sort();
    assert.deepEqual(platforms, ["claude", "codex", "codex", "pi"]);
    assert.match(warnings[0]?.message ?? "", /delivery will not work/);
  });

  it("clears warnings once the entry files exist", async () => {
    const fixture = gitFixture();
    mkdirSync(path.join(fixture.root, "skills", "demo"), { recursive: true });
    writeFileSync(
      path.join(fixture.root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nbody\n",
    );
    writeFileSync(
      path.join(fixture.root, "allinai-plugin.json"),
      JSON.stringify({ id: "demo", runtimes: ["codex"], skills: ["skills/demo"] }),
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "v1"]);
    const root = mkdtempSync(path.join(tmpdir(), "allinai-plugin-store-"));
    directories.push(root);
    const manager = createManager(root);
    await manager.sync([desired(fixture.root, fixture.commit())]);

    mkdirSync(path.join(fixture.root, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(fixture.root, ".claude-plugin", "marketplace.json"), "{}");
    mkdirSync(path.join(fixture.root, ".codex-plugin"), { recursive: true });
    writeFileSync(path.join(fixture.root, ".codex-plugin", "plugin.json"), "{}");
    mkdirSync(path.join(fixture.root, ".agents", "plugins"), { recursive: true });
    writeFileSync(path.join(fixture.root, ".agents", "plugins", "marketplace.json"), "{}");
    writeFileSync(path.join(fixture.root, "package.json"), "{}");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "v2"]);
    const result = await manager.sync([desired(fixture.root, fixture.commit())]);

    assert.equal(result[0]?.outcome?.warnings, undefined);
    assert.equal(manager.status("demo")?.warnings, undefined);
  });
});
