import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunnerChildMessage, parseRunnerStart } from "./runner-wire.js";

describe("runner wire validation", () => {
  it("rejects unknown keys in a start frame and its declared input", () => {
    const base = {
      type: "run.start",
      executionId: "execution-1",
      input: { platform: "codex", prompt: "hello" },
    };

    assert.notEqual(parseRunnerStart(base), null);
    assert.equal(parseRunnerStart({ ...base, command: "sh" }), null);
    assert.equal(
      parseRunnerStart({
        ...base,
        input: { ...base.input, executable: "codex" },
      }),
      null,
    );
  });

  it("rejects unknown keys in child frames and normalized events", () => {
    const base = {
      type: "event",
      event: { type: "text_delta", payload: { text: "hello" } },
    };

    assert.notEqual(parseRunnerChildMessage(base), null);
    assert.equal(parseRunnerChildMessage({ ...base, shell: true }), null);
    assert.equal(
      parseRunnerChildMessage({
        ...base,
        event: { ...base.event, executable: "codex" },
      }),
      null,
    );
  });
});
