import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClaudePrintArgs,
  mapClaudeCliEvent,
  claudeCliRunInput,
} from "./claude-cli.js";

describe("claude CLI executor", () => {
  it("builds print args with stream-json, verbose, bypass permissions, and prompt", () => {
    assert.deepEqual(buildClaudePrintArgs({ prompt: "hello" }), [
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "1",
    ]);
  });

  it("passes model, add-dir, resume, and plugin dirs", () => {
    const args = buildClaudePrintArgs({
      prompt: "go",
      cwd: "/work",
      resumeSessionId: "sess-1",
      model: "sonnet",
      pluginDirs: ["/plugins/a", "/plugins/b"],
    });
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("sess-1"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("sonnet"));
    assert.deepEqual(
      args.filter((arg, index) => arg === "--plugin-dir" || index > 0 && args[index - 1] === "--plugin-dir"),
      ["--plugin-dir", "/plugins/a", "--plugin-dir", "/plugins/b"],
    );
    assert.ok(args.includes("--add-dir"));
  });

  it("maps system/init to init with runtimeSessionId", () => {
    const event = mapClaudeCliEvent({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "glm",
    });
    assert.deepEqual(event, {
      type: "init",
      payload: { runtimeSessionId: "s-1", model: "glm" },
    });
  });

  it("maps assistant text blocks to text_delta", () => {
    const event = mapClaudeCliEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi there" }] },
    });
    assert.deepEqual(event, { type: "text_delta", payload: { text: "hi there" } });
  });

  it("maps result to done or error by is_error", () => {
    const done = mapClaudeCliEvent({
      type: "result",
      is_error: false,
      result: "HELLO",
    });
    assert.deepEqual(done, { type: "done", payload: { text: "HELLO" } });

    const error = mapClaudeCliEvent({
      type: "result",
      is_error: true,
      result: "model not found",
    });
    assert.equal(error?.type, "error");
    assert.match(String((error?.payload as Record<string, unknown>).message), /model not found/);
  });

  it("derives resume session id from the transport session id", () => {
    const spawnInput = claudeCliRunInput({
      platform: "claude",
      prompt: "go",
      sessionId: "sess-7",
    });
    assert.equal(spawnInput.resumeSessionId, "sess-7");
    assert.match(
      buildClaudePrintArgs(spawnInput).join(" "),
      /--resume sess-7/,
    );
  });
});
