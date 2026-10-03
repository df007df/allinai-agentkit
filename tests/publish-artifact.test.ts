import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { transformManifest } from "../scripts/publish-stage.mjs";

for (const side of ["hub", "client"]) {
  test(`${side} stages compiled exports without workspace dependencies`, () => {
    const source = JSON.parse(readFileSync(new URL(`../packages/${side}/package.json`, import.meta.url), "utf8"));
    const staged = transformManifest(source) as Record<string, any>;
    assert.equal(staged.name, `@allin-ai/agentkit-${side}`);
    assert.equal(staged.scripts, undefined);
    assert.equal(staged.devDependencies, undefined);
    assert.equal(staged.files, undefined);
    assert.equal(staged.exports, source.publishConfig.exports);
    assert.deepEqual(staged.dependencies, source.dependencies);
    assert.equal(staged.publishConfig.access, "public");
    assert.equal(staged.exports[side === "hub" ? "./client" : "./hub"], undefined);
    for (const value of Object.values(staged.exports)) {
      const targets = typeof value === "string" ? [value] : Object.values(value as object);
      for (const target of targets) assert.match(String(target), /^\.\/dist\//);
    }
  });
}

test("staging rejects a source-only manifest", () => {
  assert.throws(() => transformManifest({ name: "invalid", exports: { ".": "./src/index.ts" } }), /publishConfig/);
});
