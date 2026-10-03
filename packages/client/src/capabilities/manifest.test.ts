import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseShellCapability, validateCapabilityEntries } from "./manifest.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function validCapability() {
  return {
    id: "demo.publish",
    entry: "bin/publish.mjs",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
      additionalProperties: false,
    },
    contextKeys: ["execution", "workspace"],
    permissions: ["workspace:write"],
    timeoutSeconds: 30,
  };
}

describe("shell capability manifest", () => {
  it("accepts a bounded named capability with an object input schema", () => {
    assert.deepEqual(
      parseShellCapability(validCapability()),
      validCapability(),
    );
  });

  it("rejects duplicate or unsafe capability declarations", () => {
    const valid = validCapability();
    for (const invalid of [
      { ...valid, id: "../escape" },
      { ...valid, entry: "/usr/bin/env" },
      { ...valid, entry: "bin/../publish.mjs" },
      { ...valid, timeoutSeconds: 0 },
      { ...valid, timeoutSeconds: 901 },
      { ...valid, inputSchema: { type: "string" } },
      { ...valid, inputSchema: { type: "object", properties: [] } },
      { ...valid, contextKeys: ["execution", "environment"] },
      { ...valid, permissions: ["network", "network"] },
    ]) {
      assert.equal(parseShellCapability(invalid), null);
    }
  });

  it("rejects every pattern declaration, including safe and adjacent quantifiers", () => {
    for (const pattern of ["^(a+)+$", "^[a-z0-9._-]+$", "^a++$"]) {
      const capability = validCapability();
      (capability.inputSchema.properties as Record<string, unknown>).branch = {
        type: "string",
        maxLength: 32,
        pattern,
      };
      assert.equal(parseShellCapability(capability), null);
    }
  });

  it("resolves each entry inside the real plugin root and rejects a symlink escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "allinai-capability-root-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "allinai-capability-outside-"),
    );
    directories.push(root, outside);
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "publish.mjs"), "export {};\n");

    const capability = parseShellCapability(validCapability());
    assert.ok(capability);
    await assert.doesNotReject(validateCapabilityEntries(root, [capability]));

    await writeFile(path.join(outside, "escape.mjs"), "export {};\n");
    await symlink(
      path.join(outside, "escape.mjs"),
      path.join(root, "bin", "escape.mjs"),
    );
    const escaping = parseShellCapability({
      ...validCapability(),
      entry: "bin/escape.mjs",
    });
    assert.ok(escaping);
    await assert.rejects(
      validateCapabilityEntries(root, [escaping]),
      /resolves outside the plugin root/,
    );
  });
});
