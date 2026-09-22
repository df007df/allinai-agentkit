import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPiAdapter } from "./pi.js";
import { OptionalRuntimeDependencyError } from "./codex.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function runInput() {
  return {
    platform: "pi" as const,
    prompt: "Summarise the repository",
    cwd: "/work/project",
  };
}

describe("Pi adapter", () => {
  it("uses the official session factory and maps subscribed session events", async () => {
    let disposed = false;
    const adapter = createPiAdapter({
      createAgentSession: async (options) => {
        assert.deepEqual(options, { cwd: "/work/project" });
        let listener: ((event: never) => void) | undefined;
        return {
          session: {
            sessionId: "pi-session-1",
            subscribe(next) {
              listener = next as (event: never) => void;
              return () => {
                listener = undefined;
              };
            },
            async prompt(prompt) {
              assert.equal(prompt, "Summarise the repository");
              listener?.({ type: "agent_start" } as never);
              listener?.({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: "Hello from Pi",
                },
              } as never);
              listener?.({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "read",
                args: { path: "README.md" },
              } as never);
              listener?.({
                type: "agent_end",
                messages: [],
                willRetry: false,
              } as never);
            },
            async abort() {},
            dispose() {
              disposed = true;
            },
          },
        };
      },
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "tool", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "pi-session-1");
    assert.equal(events[1]?.payload?.text, "Hello from Pi");
    assert.equal(events[2]?.payload?.toolName, "read");
    assert.equal(events[3]?.payload?.messageCount, 0);
    assert.equal(disposed, true);
  });

  it("maps unrecognized session and message_update events to vendor without dropping them", async () => {
    const adapter = createPiAdapter({
      createAgentSession: async () => {
        let listener: ((event: never) => void) | undefined;
        return {
          session: {
            sessionId: "pi-session-2",
            subscribe(next) {
              listener = next as (event: never) => void;
              return () => {
                listener = undefined;
              };
            },
            async prompt() {
              listener?.({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_start",
                  contentIndex: 0,
                },
              } as never);
              listener?.({
                type: "turn_start",
              } as never);
              listener?.({
                type: "compaction_start",
                reason: "threshold",
              } as never);
              listener?.({ type: "agent_start" } as never);
              listener?.({
                type: "agent_end",
                messages: [{ role: "assistant" }],
                willRetry: false,
              } as never);
            },
            async abort() {},
            dispose() {},
          },
        };
      },
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["vendor", "vendor", "vendor", "init", "done"],
    );
    assert.equal(events[0]?.payload?.vendorUpdateType, "text_start");
    assert.equal(events[1]?.payload?.vendorEventType, "turn_start");
    assert.equal(events[2]?.payload?.vendorEventType, "compaction_start");
    assert.equal(events[4]?.payload?.messageCount, 1);
  });

  it("reports the installed official SDK version", async () => {
    const probe = await createPiAdapter({
      loadPi: async () => ({
        VERSION: "0.85.1",
        createAgentSession: async () => {
          throw new Error("probe must not create a session");
        },
      }),
    }).probe();

    assert.deepEqual(probe, { installed: true, version: "0.85.1" });
  });

  it("resumes an existing session file when a transport sessionId resolves", async () => {
    let receivedSessionManager: unknown;
    const adapter = createPiAdapter({
      createAgentSession: async (options) => {
        receivedSessionManager = options?.sessionManager;
        return {
          session: {
            sessionId: "pi-session-1",
            subscribe: () => () => undefined,
            async prompt() {},
            async abort() {},
            dispose() {},
          },
        };
      },
      sessionResolver: {
        resolveSessionFile: async (sessionId) =>
          sessionId === "pi-session-1"
            ? "/sessions/dir/2026-09-22T08-50-50Z_pi-session-1.jsonl"
            : null,
        openSessionFile: (sessionFile) => ({ __opened: sessionFile }),
      },
    });

    const events = await collect(
      adapter.start(
        { ...runInput(), sessionId: "pi-session-1" },
        new AbortController().signal,
      ),
    );

    const init = events.find((event) => event.type === "init");
    assert.equal(init?.payload?.runtimeSessionId, "pi-session-1");
    assert.equal(init?.payload?.resumed, true);
    assert.match(String(init?.payload?.sessionFile), /pi-session-1\.jsonl$/);
    assert.ok(receivedSessionManager, "sessionManager must be passed through");
    assert.equal(
      events.some((event) => event.type === "done"),
      true,
    );
  });

  it("emits a lossless vendor note and keeps going when the sessionId cannot be resolved", async () => {
    const adapter = createPiAdapter({
      createAgentSession: async (options) => {
        assert.equal(options?.sessionManager, undefined);
        return {
          session: {
            sessionId: "pi-session-fresh",
            subscribe: () => () => undefined,
            async prompt() {},
            async abort() {},
            dispose() {},
          },
        };
      },
      sessionResolver: {
        resolveSessionFile: async () => null,
        openSessionFile: () => {
          throw new Error("must not open when resolution failed");
        },
      },
    });

    const events = await collect(
      adapter.start(
        { ...runInput(), sessionId: "gone-session" },
        new AbortController().signal,
      ),
    );

    const note = events.find(
      (event) =>
        event.type === "vendor" &&
        event.payload?.vendorEventType === "session_resume_unavailable",
    );
    assert.equal(note?.payload?.requestedSessionId, "gone-session");
    assert.equal(
      events.some((event) => event.type === "done"),
      true,
    );
  });

  it("raises an actionable optional dependency error when the SDK is absent", async () => {
    const adapter = createPiAdapter({
      loadPi: async () => {
        throw new Error("Cannot find package");
      },
    });

    await assert.rejects(adapter.probe(), (error: unknown) => {
      assert.ok(error instanceof OptionalRuntimeDependencyError);
      assert.equal(error.packageName, "@earendil-works/pi-coding-agent");
      assert.match(
        error.message,
        /npm install @earendil-works\/pi-coding-agent/,
      );
      return true;
    });
  });

  it("propagates an actionable optional dependency error from adapter use", async () => {
    const adapter = createPiAdapter({
      loadPi: async () => {
        throw new Error("Cannot find package");
      },
    });

    await assert.rejects(
      collect(adapter.start(runInput(), new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof OptionalRuntimeDependencyError);
        assert.equal(error.packageName, "@earendil-works/pi-coding-agent");
        assert.match(
          error.message,
          /npm install @earendil-works\/pi-coding-agent/,
        );
        return true;
      },
    );
  });

  it("awaits a delayed SDK abort before terminal completion and disposal", async () => {
    const controller = new AbortController();
    const lifecycle: string[] = [];
    let finishAbort: (() => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    const adapter = createPiAdapter({
      createAgentSession: async () => ({
        session: {
          sessionId: "pi-session-abort",
          subscribe() {
            return () => undefined;
          },
          prompt: () =>
            new Promise<void>((resolve) => {
              lifecycle.push("prompt");
              finishPrompt = resolve;
            }),
          abort: () =>
            new Promise<void>((resolve) => {
              lifecycle.push("abort:start");
              finishAbort = () => {
                lifecycle.push("abort:end");
                resolve();
                finishPrompt?.();
              };
            }),
          dispose() {
            lifecycle.push("dispose");
          },
        },
      }),
    });

    const iterator = adapter
      .start(runInput(), controller.signal)
      [Symbol.asyncIterator]();
    const terminal = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await Promise.resolve();

    assert.deepEqual(lifecycle, ["prompt", "abort:start"]);
    let terminalSettled = false;
    void terminal.then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    assert.equal(terminalSettled, false);

    finishAbort?.();
    assert.equal((await terminal).value?.type, "done");
    assert.deepEqual(lifecycle, ["prompt", "abort:start", "abort:end"]);
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(lifecycle, [
      "prompt",
      "abort:start",
      "abort:end",
      "dispose",
    ]);
  });
});
