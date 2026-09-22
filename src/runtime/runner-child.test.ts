import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { encodeJsonLine } from "./runner-wire.js";

const childEntrypoint = fileURLToPath(
  new URL("./runner-child.ts", import.meta.url),
);

type ChildProcessLike = ReturnType<typeof spawn>;

function startChild(): {
  child: ChildProcessLike;
  lines: Promise<string[]>;
} {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    childEntrypoint,
  ]);
  let pending = "";
  const lines: string[] = [];
  let notify: (() => void) | null = null;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
    notify?.();
    notify = null;
  });
  const lines_ = {
    then(onFulfilled: () => void) {
      if (lines.length > 0) onFulfilled();
      else notify = onFulfilled;
    },
  };
  return { child, lines: lines_ as unknown as Promise<string[]> };
}

function runStartLine(platform: string): string {
  return encodeJsonLine({
    type: "run.start",
    executionId: "exec-1",
    input: {
      platform,
      prompt: "say hi",
    },
  });
}

async function readEventLines(child: ChildProcessLike): Promise<unknown[]> {
  const deadline = Date.now() + 10_000;
  const events: unknown[] = [];
  let raw = "";
  while (Date.now() < deadline) {
    const [chunk] = await Promise.race([
      once(child.stdout!, "data") as Promise<[string]>,
      new Promise<[]>((resolve) =>
        setTimeout(() => resolve([]), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk) raw += String(chunk);
    let index = raw.indexOf("\n");
    while (index >= 0) {
      const line = raw.slice(0, index);
      raw = raw.slice(index + 1);
      if (line.trim()) events.push(JSON.parse(line));
      index = raw.indexOf("\n");
    }
    if (events.length > 0 && child.exitCode !== null) break;
    if (events.length > 0 && events.some((event) => "type" in (event as object)))
      break;
  }
  return events;
}

describe("runner child", () => {
  it("streams adapter events for a registered platform until a terminal event", async () => {
    const { child } = startChild();
    child.stdin!.write(runStartLine("claude"));
    child.stdin!.end();
    const events = await readEventLines(child);
    const kinds = events.map(
      (event) => (event as { event?: { type?: string } }).event?.type,
    );
    // The installed optional SDK boundary is importable in this workspace, so
    // the child reaches the adapter; whether the provider call itself succeeds
    // is adapter concern, but the child must stream JSONL events either way.
    assert.ok(kinds.length > 0, "child must emit JSONL events");
    assert.ok(
      kinds.every((kind) =>
        [
          "init",
          "text_delta",
          "thinking_delta",
          "tool",
          "vendor",
          "done",
          "error",
        ].includes(kind as string),
      ),
      `unexpected event kinds: ${JSON.stringify(kinds)}`,
    );
    child.kill();
  });

  it("reports a terminal error for input the wire rejects", async () => {
    const { child } = startChild();
    // Unknown platform ids never reach the child: the runner-wire validator
    // rejects the start message, and the child fails closed.
    child.stdin!.write(runStartLine("definitely-not-a-platform"));
    child.stdin!.end();
    const events = await readEventLines(child);
    const last = events.at(-1) as { event?: { payload?: { reason?: string } } };
    assert.equal(last?.event?.payload?.reason, "runner_protocol_error");
    child.kill();
  });
});
