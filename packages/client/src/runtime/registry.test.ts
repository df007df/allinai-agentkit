import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlatformAdapterRegistry } from "./registry.js";

describe("platform adapter registry", () => {
  it("registers every adapter without any optional SDK surface", async () => {
    const registry = createPlatformAdapterRegistry();

    assert.deepEqual(
      registry.list().map((adapter) => adapter.id),
      ["codex", "claude", "pi", "zcode"],
    );
    assert.deepEqual(await registry.get("zcode").probe(), {
      installed: false,
      version: null,
      reason: "zcode adapter is not configured",
    });
  });
});
