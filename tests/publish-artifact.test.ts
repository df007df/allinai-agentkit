import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publicationAction, transformManifest } from "../scripts/publish-stage.mjs";

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

test("release publishes an absent version", () => {
  assert.equal(publicationAction({ status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }, "abc123"), "publish");
});

test("release retries skip a version published from the same commit", () => {
  assert.equal(publicationAction({ status: 0, stdout: JSON.stringify({ gitHead: "abc123" }) }, "abc123"), "skip");
});

test("release refuses an existing version from another or unknown commit", () => {
  for (const manifest of [{ gitHead: "other" }, {}]) {
    assert.throws(() => publicationAction({ status: 0, stdout: JSON.stringify(manifest) }, "abc123"), /different or unknown commit/);
  }
});

test("release never interprets registry or authentication failures as an absent version", () => {
  for (const code of ["E401", "E403", "E429", "ETIMEDOUT"]) {
    assert.throws(() => publicationAction({ status: 1, stdout: JSON.stringify({ error: { code } }) }, "abc123"), /Registry lookup failed/);
  }
});

test("release rejects a failed process or malformed registry response", () => {
  assert.throws(() => publicationAction({ status: null, stdout: "", error: new Error("spawn failed") }, "abc123"), /spawn failed/);
  assert.throws(() => publicationAction({ status: 0, stdout: "bad response" }, "abc123"), /Registry lookup failed/);
});
