import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  dispatchToPlatform,
  targetPlatforms,
} from "./dispatch.js";

const directories: string[] = [];
const installedMarker = new Map<string, string[]>();

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Stub CLI that succeeds (exit 0) and records its argv. */
function stubOk(name: string, argvFile: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-stub-"));
  directories.push(dir);
  const script = path.join(dir, name);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s ' "$@" >> ${JSON.stringify(argvFile)}`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

/** Stub CLI that always fails with a stderr message. */
function stubFail(name: string, message: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-stub-"));
  directories.push(dir);
  const script = path.join(dir, name);
  const b64 = Buffer.from(message, "utf8").toString("base64");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s' "$(printf '%s' ${b64} | (base64 -d 2>/dev/null || base64 -D))" >&2`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

async function readArgv(argvFile: string): Promise<string[]> {
  const { readFileSync } = await import("node:fs");
  try {
    return readFileSync(argvFile, "utf8").split(" ").filter(Boolean);
  } catch {
    return [];
  }
}

describe("platform dispatcher", () => {
  it("claude is always skipped (adapter consumes the repo at run time)", async () => {
    const result = await dispatchToPlatform(
      "claude",
      "install",
      { id: "demo", repo: "/tmp/whatever" },
      { which: async () => null },
    );
    assert.deepEqual(result, {
      platform: "claude",
      state: "skipped",
      detail: "runtime_plugin_dir",
    });
  });

  it("codex install runs marketplace add then plugin add", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    directories.push(dir);
    const argvFile = path.join(dir, "args.txt");
    const codex = stubOk("codex", argvFile);

    const result = await dispatchToPlatform(
      "codex",
      "install",
      { id: "demo", repo: "/repos/demo" },
      { which: async () => "/usr/bin/codex", codexCommand: codex },
    );

    assert.equal(result.state, "installed");
    const args = await readArgv(argvFile);
    assert.ok(args.includes("marketplace"));
    assert.ok(args.includes("/repos/demo"));
    assert.ok(args.includes("demo@demo-repo"));
  });

  it("codex install reports failed with stderr when plugin add rejects", async () => {
    const codex = stubFail("codex", "missing plugin.json");
    const result = await dispatchToPlatform(
      "codex",
      "install",
      { id: "demo", repo: "/repos/demo" },
      { which: async () => "/usr/bin/codex", codexCommand: codex },
    );
    assert.equal(result.state, "failed");
    assert.match(result.detail ?? "", /missing plugin\.json/);
  });

  it("codex/pi skip cleanly when the platform CLI is not installed", async () => {
    const codex = await dispatchToPlatform(
      "codex",
      "install",
      { id: "demo", repo: "/r" },
      { which: async () => null },
    );
    const pi = await dispatchToPlatform(
      "pi",
      "install",
      { id: "demo", repo: "/r" },
      { which: async () => null },
    );
    assert.equal(codex.state, "skipped");
    assert.equal(codex.detail, "platform_not_installed");
    assert.equal(pi.state, "skipped");
    assert.equal(pi.detail, "platform_not_installed");
  });

  it("pi install runs `pi install <repo>` and remove runs `pi remove <repo>`", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatch-"));
    directories.push(dir);
    const argvFile = path.join(dir, "args.txt");
    const pi = stubOk("pi", argvFile);

    const installed = await dispatchToPlatform(
      "pi",
      "install",
      { id: "demo", repo: "/repos/demo" },
      { which: async () => "/usr/bin/pi", piCommand: pi },
    );
    const removed = await dispatchToPlatform(
      "pi",
      "remove",
      { id: "demo", repo: "/repos/demo" },
      { which: async () => "/usr/bin/pi", piCommand: pi },
    );

    assert.equal(installed.state, "installed");
    assert.equal(removed.state, "removed");
    const args = await readArgv(argvFile);
    // The stub appends across both invocations: install first, remove last.
    const installIndex = args.indexOf("install");
    const removeIndex = args.indexOf("remove");
    assert.ok(installIndex >= 0 && args[installIndex + 1] === "/repos/demo");
    assert.ok(removeIndex > installIndex && args[removeIndex + 1] === "/repos/demo");
  });
});

describe("targetPlatforms", () => {
  it("intersects desired runtimes with installed platforms", () => {
    const installed = new Set(["codex"]);
    assert.deepEqual(targetPlatforms(["codex", "claude"], installed), [
      "claude",
      "codex",
    ]);
  });

  it("drops desired platforms that are not installed on this machine", () => {
    assert.deepEqual(
      targetPlatforms(["codex", "pi"], new Set(["pi"])),
      ["pi"],
    );
  });

  it("defaults to all platforms when runtimes is undefined", () => {
    const all = targetPlatforms(undefined, new Set(["codex", "pi", "claude"]));
    assert.deepEqual(all, ["claude", "codex", "pi"]);
  });
});
