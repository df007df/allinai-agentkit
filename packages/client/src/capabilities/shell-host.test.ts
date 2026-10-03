import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { chmod, cp, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ShellCapabilityHost, type CapabilitySpawn } from "./shell-host.js";
import type { ShellCapability } from "./types.js";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "allinai-shell-host-"));
  temporaryDirectories.push(root);
  return root;
}

async function fixture(root: string, name: string): Promise<string> {
  const target = path.join(root, name);
  await cp(path.join(fixtureDirectory, "fixtures", name), target);
  await chmod(target, 0o700);
  return target;
}

function capability(entry: string): ShellCapability {
  return {
    id: "demo.publish",
    entry,
    inputSchema: { type: "object" },
    contextKeys: ["workspace"],
    permissions: [],
    timeoutSeconds: 5,
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("ShellCapabilityHost", () => {
  it("passes input/context as one JSON stdin document and forwards JSONL progress", async () => {
    const root = await pluginRoot();
    await fixture(root, "progress.sh");
    const priorSecret = process.env.ALLINAI_SECRET_FOR_TEST;
    process.env.ALLINAI_SECRET_FOR_TEST = "never-forward-this";
    try {
      const host = new ShellCapabilityHost({ pluginRoot: root });
      const events = await collect(
        host.invoke(
          capability("progress.sh"),
          { branch: "main" },
          { workspace: "/tmp/work" },
          new AbortController().signal,
        ),
      );

      assert.deepEqual(events, [
        { type: "progress", payload: { phase: "started" } },
        { type: "result", payload: { published: true } },
      ]);
    } finally {
      if (priorSecret === undefined) delete process.env.ALLINAI_SECRET_FOR_TEST;
      else process.env.ALLINAI_SECRET_FOR_TEST = priorSecret;
    }
  });

  it("rejects non-JSONL output as a terminal error and never runs through sh -c", async () => {
    const root = await pluginRoot();
    await fixture(root, "invalid-output.sh");
    let spawnOptions: Parameters<CapabilitySpawn>[2] | undefined;
    const spawn: CapabilitySpawn = (entry, args, options) => {
      spawnOptions = options;
      return nodeSpawn(entry, args, options);
    };

    const host = new ShellCapabilityHost({ pluginRoot: root, spawn });
    const events = await collect(
      host.invoke(
        capability("invalid-output.sh"),
        {},
        {},
        new AbortController().signal,
      ),
    );

    assert.equal(events.at(-1)?.type, "error");
    assert.equal(events.at(-1)?.payload.reason, "capability_output_invalid");
    assert.equal(spawnOptions?.shell, false);
  });

  it("re-checks realpath containment immediately before spawn", async () => {
    const root = await pluginRoot();
    const outside = await mkdtemp(
      path.join(tmpdir(), "allinai-shell-outside-"),
    );
    temporaryDirectories.push(outside);
    const outsideScript = path.join(outside, "outside.sh");
    await writeFile(
      outsideScript,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","payload":{}}\'\n',
      {
        mode: 0o700,
      },
    );
    await symlink(outsideScript, path.join(root, "escaped.sh"));

    const events = await collect(
      new ShellCapabilityHost({ pluginRoot: root }).invoke(
        capability("escaped.sh"),
        {},
        {},
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events, [
      {
        type: "error",
        payload: { reason: "capability_entry_outside_plugin_root" },
      },
    ]);
  });

  it("preserves a UTF-8 frame split over stdout chunks", async () => {
    const root = await pluginRoot();
    const entry = path.join(root, "split-output.mjs");
    await writeFile(
      entry,
      `#!${process.execPath}\nconst output = Buffer.from('{"type":"log","payload":{"message":"雪"}}\\n{"type":"result","payload":{"ok":true}}\\n');\nprocess.stdout.write(output.subarray(0, 41));\nsetTimeout(() => process.stdout.write(output.subarray(41)), 5);\n`,
      { mode: 0o700 },
    );

    const events = await collect(
      new ShellCapabilityHost({ pluginRoot: root }).invoke(
        capability("split-output.mjs"),
        {},
        {},
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events, [
      { type: "log", payload: { message: "雪" } },
      { type: "result", payload: { ok: true } },
    ]);
  });

  it("terminates a running process group after abort without accepting a terminal result", async () => {
    const root = await pluginRoot();
    await fixture(root, "wait-after-progress.sh");
    const controller = new AbortController();
    const iterator = new ShellCapabilityHost({
      pluginRoot: root,
      killGraceMs: 10,
    })
      .invoke(capability("wait-after-progress.sh"), {}, {}, controller.signal)
      [Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "progress", payload: { phase: "waiting" } },
    });
    controller.abort();
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "error", payload: { reason: "capability_cancelled" } },
    });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });
});
