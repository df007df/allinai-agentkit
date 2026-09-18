import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGitClient,
  isAllowedGitOrigin,
  isProductionGitUrl,
} from "./git.js";

describe("plugin git boundary", () => {
  it("accepts only HTTPS and SSH Git origins in production", () => {
    for (const value of [
      "https://github.com/allin-ai/demo.git",
      "ssh://git@github.com/allin-ai/demo.git",
      "git@github.com:allin-ai/demo.git",
    ]) {
      assert.equal(isProductionGitUrl(value), true);
    }
    for (const value of [
      "/tmp/demo",
      "file:///tmp/demo",
      "http://github.com/allin-ai/demo.git",
      "https://github.com/allin-ai/demo.git --upload-pack=unsafe",
    ]) {
      assert.equal(isProductionGitUrl(value), false);
    }
  });

  it("requires an explicit local origin allowlist before activating a remote plugin", () => {
    const url = "https://github.com/allin-ai/demo.git";
    assert.equal(isAllowedGitOrigin(url, []), false);
    assert.equal(isAllowedGitOrigin(url, ["gitlab.com"]), false);
    assert.equal(isAllowedGitOrigin(url, ["github.com"]), true);
    assert.equal(isAllowedGitOrigin(url, ["https://github.com"]), true);
    assert.equal(
      isAllowedGitOrigin("git@github.com:allin-ai/demo.git", [
        "ssh://git@github.com",
      ]),
      true,
    );
  });

  it("uses an argument vector with shell disabled", async () => {
    const calls: Array<{ file: string; args: string[]; shell: boolean }> = [];
    const git = createGitClient({
      execFile: async (file, args, options) => {
        calls.push({ file, args, shell: options.shell });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    assert.equal(await git.run(["rev-parse", "HEAD"]), "ok");
    assert.deepEqual(calls, [
      { file: "git", args: ["rev-parse", "HEAD"], shell: false },
    ]);
  });
});
