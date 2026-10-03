import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiPrintArgs, mapPiCliEvent, piCliRunInput } from "./pi-cli.js";

describe("pi CLI executor", () => {
  it("builds print args with json mode and prompt", () => {
    assert.deepEqual(buildPiPrintArgs({ prompt: "hello" }), [
      "-p",
      "--mode",
      "json",
      "hello",
    ]);
  });

  it("passes model, cwd, and session resume before the prompt", () => {
    const args = buildPiPrintArgs({
      prompt: "go",
      cwd: "/work",
      resumeSessionId: "sess-5",
      model: "glm-5.3",
    });
    assert.deepEqual(args, [
      "-p",
      "--mode",
      "json",
      "--model",
      "glm-5.3",
      "--cwd",
      "/work",
      "--session",
      "sess-5",
      "go",
    ]);
  });

  it("maps session to init with runtimeSessionId", () => {
    const event = mapPiCliEvent({
      type: "session",
      version: 3,
      id: "01a0d647",
      cwd: "/tmp",
    });
    assert.deepEqual(event, {
      type: "init",
      payload: { runtimeSessionId: "01a0d647", cwd: "/tmp" },
    });
  });

  it("maps message_update text_delta to text_delta", () => {
    const event = mapPiCliEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "HE" },
    });
    assert.deepEqual(event, { type: "text_delta", payload: { text: "HE" } });
    assert.equal(
      mapPiCliEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      }),
      null,
    );
  });

  it("maps assistant message_end to done", () => {
    const done = mapPiCliEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "HELLO_PI" }],
      },
    });
    assert.deepEqual(done, { type: "done", payload: { text: "HELLO_PI" } });
    // user message_end is ignored
    assert.equal(
      mapPiCliEvent({ type: "message_end", message: { role: "user", content: [] } }),
      null,
    );
  });

  it("maps toolcall events to vendor with tool name", () => {
    const event = mapPiCliEvent({
      type: "toolcall_start",
      toolCall: { name: "bash", arguments: {} },
    });
    assert.equal(event?.type, "vendor");
    assert.equal((event.payload as Record<string, unknown>).toolName, "bash");
  });

  it("derives resume session id from the transport session id", () => {
    const spawnInput = piCliRunInput({
      platform: "pi",
      prompt: "go",
      sessionId: "sess-8",
    });
    assert.equal(spawnInput.resumeSessionId, "sess-8");
    assert.match(buildPiPrintArgs(spawnInput).join(" "), /--session sess-8/);
  });
});
