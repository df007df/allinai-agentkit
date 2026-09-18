import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlatformAdapterRegistry } from "./registry.js";

describe("platform adapter registry", () => {
  it("registers every adapter without loading optional SDKs", async () => {
    let codexLoads = 0;
    let claudeLoads = 0;
    let piLoads = 0;
    const registry = createPlatformAdapterRegistry({
      codex: {
        loadCodex: async () => {
          codexLoads += 1;
          return { Codex: class {} } as never;
        },
      },
      claude: {
        loadClaude: async () => {
          claudeLoads += 1;
          return { query: (() => undefined) as never };
        },
      },
      pi: {
        loadPi: async () => {
          piLoads += 1;
          return {
            VERSION: "test",
            createAgentSession: (() => undefined) as never,
          };
        },
      },
    });

    assert.deepEqual(
      registry.list().map((adapter) => adapter.id),
      ["codex", "claude", "pi", "zcode"],
    );
    assert.deepEqual([codexLoads, claudeLoads, piLoads], [0, 0, 0]);
    assert.deepEqual(await registry.get("zcode").probe(), {
      installed: false,
      version: null,
      reason: "zcode adapter is not configured",
    });
  });
});
