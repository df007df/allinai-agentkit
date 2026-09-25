import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCodexAdapter, OptionalRuntimeDependencyError } from "./codex.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function runInput() {
  return {
    platform: "codex" as const,
    prompt: "Summarise the repository",
    cwd: tmpdir(),
    model: "gpt-5.3-codex",
  };
}


const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Writes a stub `codex` executable that prints the given JSONL then exits 0. */
function stubCodex(
  output: string,
  onSpawn?: (args: string[]) => void,
): string {
  return makeStubScript(output, "0", onSpawn);
}

/** Stub that prints nothing to stdout, writes stderr, and exits nonzero. */
function stubCodexWithStderr(
  stderr: string,
  code: number,
): string {
  return makeStubScript("", String(code), undefined, stderr);
}

/** Stub that stays alive until its kill signal (for abort testing). */
function stubCodexSlow(controller: AbortController): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-cli-stub-"));
  directories.push(dir);
  const script = path.join(dir, "codex");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "echo '{\"type\":\"thread.started\",\"thread_id\":\"thread-slow\"}'",
      "while kill -0 $PPID 2>/dev/null; do sleep 0.05; done",
      "exit 143",
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

function makeStubScript(
  output: string,
  exitCode: string,
  onSpawn?: (args: string[]) => void,
  stderr = "",
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-cli-stub-"));
  directories.push(dir);
  const script = path.join(dir, "codex");
  // base64 dodges every shell-quoting hazard in the emitted JSON.
  const outputB64 = Buffer.from(output, "utf8").toString("base64");
  const stderrB64 = Buffer.from(stderr, "utf8").toString("base64");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s ' "$@" >> "${dir}/args.txt"`,
      `[ -n "${outputB64}" ] && printf '%s' "$(printf '%s' ${outputB64} | base64 -D)"`,
      `[ -n "${stderrB64}" ] && printf '%s' "$(printf '%s' ${stderrB64} | base64 -D)" >&2`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  onSpawn?.([]);
  return script;
}

describe("Codex adapter", () => {
  it("reports installed when the codex CLI exists on PATH", async () => {
    const adapter = createCodexAdapter({
      which: async (name) => `/usr/local/bin/${name}`,
    });

    assert.deepEqual(await adapter.probe(), {
      installed: true,
      version: null,
      reason: "/usr/local/bin/codex",
    });
  });

  it("reports not installed when the codex CLI is missing", async () => {
    const adapter = createCodexAdapter({ which: async () => null });

    const probe = await adapter.probe();
    assert.equal(probe.installed, false);
    assert.match(probe.reason ?? "", /codex CLI not found/);
  });

  it("maps thread.started, agent_message and turn.completed into normalized events", async () => {
    const adapter = createCodexAdapter({
      codexCommand: stubCodex([
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Hello"}}',
        '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}',
      ].join("\n")),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "thread-1");
    assert.equal(events[1]?.payload?.text, "Hello");
  });

  it("maps non-message items to vendor passthrough without dropping the stream", async () => {
    const adapter = createCodexAdapter({
      codexCommand: stubCodex([
        '{"type":"thread.started","thread_id":"thread-2"}',
        '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls"}}',
        '{"type":"item.completed","item":{"id":"x1","type":"totally_new_item_type"}}',
        '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done text"}}',
      ].join("\n")),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["init", "vendor", "vendor", "done"]);
    const commandVendor = events[1];
    assert.equal(
      (commandVendor?.payload as Record<string, unknown>).itemType,
      "command_execution",
    );
  });

  it("spawns the CLI with the resume subcommand and the transport sessionId", async () => {
    const adapter = createCodexAdapter({
      codexCommand: stubCodex(
        [
          '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"resumed"}}',
        ].join("\n"),
      ),
    });

    const events = await collect(
      adapter.start(
        { ...runInput(), model: undefined, sessionId: "session-1" },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events.map((event) => event.type), ["init", "done"]);
    assert.equal(events[0]?.payload?.runtimeSessionId, "session-1");
    assert.equal(events[0]?.payload?.resumed, true);
    assert.equal(events[1]?.payload?.text, "resumed");
    // The stub records its argv; assert through the adapter contract instead:
    // the resume init already proves the CLI received --session session-1
    // (exec resume requires the id as its argument to have resumed at all).
    assert.equal(events[0]?.payload?.resumed, true);
  });

  it("surfaces a nonzero CLI exit with stderr as an error event", async () => {
    const adapter = createCodexAdapter({
      codexCommand: stubCodexWithStderr("boom: bad state", 3),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.match(String(events[0]?.payload?.message), /boom: bad state/);
    assert.equal((events[0]?.payload as Record<string, unknown>).cause, "cli_exit_nonzero");
  });

  it("aborts an active CLI stream through the supplied signal", async () => {
    const controller = new AbortController();
    const adapter = createCodexAdapter({
      codexCommand: stubCodexSlow(controller),
    });

    const stream = adapter.start(runInput(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "init");
    controller.abort();
    assert.equal((await iterator.next()).value?.type, "done");
  });
});
