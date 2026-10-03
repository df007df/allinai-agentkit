import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createPiAdapter } from "./pi.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("Pi adapter", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function stubPi(output: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-cli-stub-"));
    directories.push(dir);
    const script = path.join(dir, "pi");
    const outputB64 = Buffer.from(output, "utf8").toString("base64");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `[ -n "${outputB64}" ] && printf '%s' "$(printf '%s' ${outputB64} | (base64 -d 2>/dev/null || base64 -D))"`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    return script;
  }

  function stubFailingPi(stderr: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-cli-stub-"));
    directories.push(dir);
    const script = path.join(dir, "pi");
    const stderrB64 = Buffer.from(stderr, "utf8").toString("base64");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `printf '%s' "$(printf '%s' ${stderrB64} | (base64 -d 2>/dev/null || base64 -D))" >&2`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    return script;
  }

  it("reports installed when the pi CLI exists on PATH", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-probe-"));
    directories.push(dir);
    writeFileSync(path.join(dir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const adapter = createPiAdapter({ which: async () => path.join(dir, "pi") });
    const probe = await adapter.probe();
    assert.equal(probe.installed, true);
  });

  it("reports not installed when the pi CLI is missing", async () => {
    const adapter = createPiAdapter({ which: async () => null });
    const probe = await adapter.probe();
    assert.equal(probe.installed, false);
  });

  it("maps session, text_delta and message_end into normalized events", async () => {
    const adapter = createPiAdapter({
      piCommand: stubPi(
        [
          '{"type":"session","version":3,"id":"pi-sess-1","cwd":"/tmp"}',
          '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"HE"}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}}',
        ].join("\n"),
      ),
    });

    const events = await collect(
      adapter.start(
        { platform: "pi", prompt: "go", cwd: tmpdir() },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "pi-sess-1");
    assert.equal(events[2]?.payload?.text, "HELLO");
  });

  it("passes --session with the transport sessionId", async () => {
    const adapter = createPiAdapter({
      piCommand: stubPi(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"resumed"}]}}',
      ),
    });

    const events = await collect(
      adapter.start(
        {
          platform: "pi",
          prompt: "go",
          cwd: tmpdir(),
          sessionId: "old-sess",
        },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events.map((event) => event.type), ["init", "done"]);
    assert.equal(events[0]?.payload?.runtimeSessionId, "old-sess");
    assert.equal(events[0]?.payload?.resumed, true);
    assert.equal(events[1]?.payload?.text, "resumed");
  });

  it("surfaces a nonzero CLI exit with stderr as an error event", async () => {
    const adapter = createPiAdapter({
      piCommand: stubFailingPi("provider key missing"),
    });

    const events = await collect(
      adapter.start(
        { platform: "pi", prompt: "go", cwd: tmpdir() },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.match(String(events[0]?.payload?.message), /provider key missing/);
  });

  it("aborts an active CLI stream through the supplied signal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-cli-abort-"));
    directories.push(dir);
    const script = path.join(dir, "pi");
    // Emit one event (so the stream is live), then spin until the parent
    // dies — deleting the stub dir on abort forces the child's stdout to
    // close so the pending read settles immediately.
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'echo \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"working"}}\'',
        "while kill -0 $PPID 2>/dev/null; do sleep 0.05; done",
        "exit 143",
      ].join("\n"),
      { mode: 0o755 },
    );
    const adapter = createPiAdapter({ piCommand: script });
    const controller = new AbortController();
    const stream = adapter.start(
      { platform: "pi", prompt: "go", cwd: tmpdir() },
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.signal.addEventListener("abort", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    });
    controller.abort();
    const result = await iterator.next();
    assert.equal(result.value?.type, "done");
    assert.equal(
      (result.value?.payload as { aborted?: boolean } | undefined)?.aborted,
      true,
    );
  });
});
