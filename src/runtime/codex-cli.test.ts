import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCodexExecArgs,
  mapCodexCliEvent,
  readJsonl,
  codexCliRunInput,
} from "./codex-cli.js";

async function* lines(lines: string[]): AsyncIterable<string> {
  yield lines.join("\n");
}

describe("codex CLI executor", () => {
  it("builds exec args with json output, sandbox, and prompt", () => {
    assert.deepEqual(
      buildCodexExecArgs({ args: [], prompt: "hello" }),
      ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "hello"],
    );
  });

  it("passes -C cwd and resume before the prompt", () => {
    const args = buildCodexExecArgs({
      args: [],
      cwd: "/work/project",
      resumeThreadId: "thread-1",
      prompt: "continue",
    });
    assert.deepEqual(args, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-C",
      "/work/project",
      "resume",
      "thread-1",
      "continue",
    ]);
  });

  it("parses JSONL lines and skips non-JSON banner noise", async () => {
    const seen: Record<string, unknown>[] = [];
    for await (const event of readJsonl(
      lines([
        "Reading additional input from stdin...",
        '{"type":"thread.started","thread_id":"t1"}',
        "not json at all",
        '{"type":"turn.started"}',
      ]),
    )) {
      seen.push(event);
    }
    assert.deepEqual(seen, [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
    ]);
  });

  it("handles JSON split across chunks", async () => {
    const seen: Record<string, unknown>[] = [];
    for await (const event of readJsonl(
      (async function* () {
        yield '{"type":"thread.star';
        yield 'ted","thread_id":"split"}\n{"type":"turn.started"}\n';
      })(),
    )) {
      seen.push(event);
    }
    assert.deepEqual(seen, [
      { type: "thread.started", thread_id: "split" },
      { type: "turn.started" },
    ]);
  });

  it("maps thread.started to init with runtimeSessionId", () => {
    const event = mapCodexCliEvent(
      { type: "thread.started", thread_id: "abc" },
      undefined,
    );
    assert.deepEqual(event, {
      type: "init",
      payload: { runtimeSessionId: "abc" },
    });
  });

  it("maps completed agent_message to done and drops turn events", () => {
    const done = mapCodexCliEvent(
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "OK" } },
      undefined,
    );
    assert.deepEqual(done, { type: "done", payload: { text: "OK" } });
    assert.equal(mapCodexCliEvent({ type: "turn.started" }, undefined), null);
    assert.equal(mapCodexCliEvent({ type: "turn.completed" }, undefined), null);
  });

  it("maps non-message items to vendor passthrough", () => {
    const event = mapCodexCliEvent(
      {
        type: "item.completed",
        item: { id: "i1", type: "command_execution", text: "ls" },
      },
      undefined,
    );
    assert.equal(event?.type, "vendor");
    assert.equal(
      (event.payload as Record<string, unknown>).itemType,
      "command_execution",
    );
  });

  it("derives resume thread id from the transport session id", () => {
    const spawnInput = codexCliRunInput({
      platform: "codex",
      prompt: "go",
      cwd: "/w",
      sessionId: "sess-9",
    });
    assert.equal(spawnInput.resumeThreadId, "sess-9");
    assert.match(
      buildCodexExecArgs(spawnInput).join(" "),
      /resume sess-9/,
    );
  });
});
