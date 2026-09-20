import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("memory Hub helpers are available only from the testkit subpath", async () => {
  const hub = await import("@allin-ai/agentkit/hub");
  const root = await import("@allin-ai/agentkit");
  const testkit = await import("@allin-ai/agentkit/hub/testkit");

  assert.equal("createMemoryHub" in hub, false);
  assert.equal("createMemoryHub" in root, false);
  assert.equal(typeof testkit.createMemoryHub, "function");
});

test("published manifest keeps the testkit subpath", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { publishConfig: { exports: Record<string, unknown> } };
  assert.deepEqual(manifest.publishConfig.exports["./hub/testkit"], {
    types: "./dist/hub/testkit/index.d.ts",
    import: "./dist/hub/testkit/index.js",
    default: "./dist/hub/testkit/index.js",
  });
});
