import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePluginManifest } from "./manifest.js";

describe("plugin manifest", () => {
  it("accepts a declared id, runtimes, and named capability declarations", () => {
    const capability = {
      id: "demo.publish",
      entry: "bin/publish.mjs",
      inputSchema: { type: "object", additionalProperties: false },
      contextKeys: ["execution"],
      permissions: [],
      timeoutSeconds: 30,
    };
    assert.deepEqual(
      parsePluginManifest({
        id: "demo.plugin",
        runtimes: ["codex", "claude"],
        capabilities: [capability],
      }),
      {
        id: "demo.plugin",
        runtimes: ["codex", "claude"],
        capabilities: [capability],
      },
    );
  });

  it("rejects unsafe ids, unknown runtimes, and malformed capability declarations", () => {
    for (const manifest of [
      { id: "../escape" },
      { id: "demo", runtimes: ["unknown"] },
      { id: "demo", capabilities: [{ id: "" }] },
      {
        id: "demo",
        capabilities: [
          {
            id: "one",
            entry: "bin/a",
            inputSchema: { type: "object" },
            contextKeys: [],
            permissions: [],
            timeoutSeconds: 1,
          },
          {
            id: "one",
            entry: "bin/b",
            inputSchema: { type: "object" },
            contextKeys: [],
            permissions: [],
            timeoutSeconds: 1,
          },
        ],
      },
    ]) {
      assert.equal(parsePluginManifest(manifest), null);
    }
  });
});
