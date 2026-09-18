import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZCODE_UNAVAILABLE_REASON, createZCodeAdapter } from "./zcode.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("ZCode adapter", () => {
  it("is explicitly unavailable and rejects before any executable can run", async () => {
    const adapter = createZCodeAdapter();

    assert.deepEqual(await adapter.probe(), {
      installed: false,
      version: null,
      reason: ZCODE_UNAVAILABLE_REASON,
    });
    await assert.rejects(
      () =>
        collect(
          adapter.start(
            { platform: "zcode", prompt: "do not run a guessed command" },
            new AbortController().signal,
          ),
        ),
      /zcode adapter is not configured/,
    );
  });
});
