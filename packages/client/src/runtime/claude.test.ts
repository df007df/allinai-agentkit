import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createClaudeAdapter } from "./claude.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("Claude adapter", () => {
  it("reports installed when the claude CLI exists on PATH", async () => {
    const adapter = createClaudeAdapter({
      which: async (name) => `/usr/local/bin/${name}`,
    });

    assert.deepEqual(await adapter.probe(), {
      installed: true,
      version: null,
      reason: "/usr/local/bin/claude",
    });
  });

  it("reports not installed when the claude CLI is missing", async () => {
    const adapter = createClaudeAdapter({ which: async () => null });

    const probe = await adapter.probe();
    assert.equal(probe.installed, false);
    assert.match(probe.reason ?? "", /claude CLI not found/);
  });

  it("maps init, assistant text and result into normalized events", async () => {
    const adapter = createClaudeAdapter({
      claudeCommand: stubClaude([
        '{"type":"system","subtype":"init","session_id":"s-1","model":"glm"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
        '{"type":"result","is_error":false,"result":"Hello"}',
      ].join("\n")),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "s-1");
    assert.equal(events[1]?.payload?.text, "Hello");
    assert.equal(events[2]?.payload?.text, "Hello");
  });

  it("passes --resume with the transport sessionId", async () => {
    const adapter = createClaudeAdapter({
      claudeCommand: stubClaude(
        '{"type":"result","is_error":false,"result":"resumed"}',
      ),
    });
    const argsFile = path.join(stubScriptDir ?? "", "args.txt");

    const events = await collect(
      adapter.start(
        { prompt: "go", options: {}, sessionId: "sess-9" },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events.map((event) => event.type), ["done"]);
    assert.equal(events[0]?.payload?.text, "resumed");
    const recordedArgs = readFileSync(argsFile, "utf8");
    assert.match(recordedArgs, /--resume sess-9/);
  });

  it("surfaces a nonzero CLI exit with stderr as an error event", async () => {
    const adapter = createClaudeAdapter({
      claudeCommand: stubClaudeWithStderr("invalid api key", 1),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.match(String(events[0]?.payload?.message), /invalid api key/);
  });

  it("aborts an active CLI stream through the supplied signal", async () => {
    const controller = new AbortController();
    const adapter = createClaudeAdapter({
      claudeCommand: stubClaudeSlow(controller),
    });

    const stream = adapter.start(runInput(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    assert.equal((await iterator.next()).value?.type, "done");
  });
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stubClaude(
  output: string,
  onSpawn?: (args: string[]) => void,
): string {
  return makeStubScript(output, "0", onSpawn);
}

function stubClaudeWithStderr(stderr: string, code: number): string {
  return makeStubScript("", String(code), undefined, stderr);
}

function stubClaudeSlow(controller: AbortController): string {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-cli-stub-"));
  directories.push(dir);
  const script = path.join(dir, "claude");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s-slow\"}'",
      "sleep 30",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  controller.signal.addEventListener("abort", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });
  return script;
}

let stubScriptDir: string | null = null;

function makeStubScript(
  output: string,
  exitCode: string,
  _onSpawn?: (args: string[]) => void,
  stderr = "",
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-cli-stub-"));
  directories.push(dir);
  stubScriptDir = dir;
  const script = path.join(dir, "claude");
  const outputB64 = Buffer.from(output, "utf8").toString("base64");
  const stderrB64 = Buffer.from(stderr, "utf8").toString("base64");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s ' "$@" >> "${dir}/args.txt"`,
      `[ -n "${outputB64}" ] && printf '%s' "$(printf '%s' ${outputB64} | (base64 -d 2>/dev/null || base64 -D))"`,
      `[ -n "${stderrB64}" ] && printf '%s' "$(printf '%s' ${stderrB64} | (base64 -d 2>/dev/null || base64 -D))" >&2`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

function runInput() {
  return {
    prompt: "Summarise the repository",
    options: { cwd: "/tmp" } as Record<string, unknown>,
  };
}
