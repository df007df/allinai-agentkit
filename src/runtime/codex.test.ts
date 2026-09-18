import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    cwd: "/work/project",
    sessionId: "session-1",
    model: "gpt-5.3-codex",
  };
}

describe("Codex adapter", () => {
  it("reports an installed SDK boundary without claiming auth health", async () => {
    const adapter = createCodexAdapter({
      loadCodex: async () =>
        ({
          Codex: class {
            startThread() {
              throw new Error("probe must not create an SDK client");
            }
            resumeThread() {
              throw new Error("probe must not create an SDK client");
            }
          },
        }) as never,
    });

    assert.deepEqual(await adapter.probe(), { installed: true, version: null });
  });

  it("names the optional Codex package and installation command when it is unavailable", async () => {
    const adapter = createCodexAdapter({
      loadCodex: async () => {
        throw new Error("Cannot find package");
      },
    });

    await assert.rejects(adapter.probe(), (error: unknown) => {
      assert.ok(error instanceof OptionalRuntimeDependencyError);
      assert.equal(error.packageName, "@openai/codex-sdk");
      assert.match(error.message, /npm install @openai\/codex-sdk/);
      return true;
    });
  });

  it("maps thread.started, agent_message and turn.completed into normalized events", async () => {
    const adapter = createCodexAdapter({
      createCodex: () => ({
        startThread: (options) => {
          assert.deepEqual(options, {
            workingDirectory: "/work/project",
            model: "gpt-5.3-codex",
          });
          return {
            async runStreamed(prompt) {
              assert.equal(prompt, "Summarise the repository");
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "thread-1" };
                  yield {
                    type: "item.completed",
                    item: { id: "m1", type: "agent_message", text: "Hello" },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 3,
                      cached_input_tokens: 1,
                      output_tokens: 5,
                      reasoning_output_tokens: 2,
                    },
                  };
                })(),
              };
            },
          };
        },
        resumeThread: () => {
          throw new Error("not used");
        },
      }),
    });

    const events = await collect(
      adapter.start(runInput(), new AbortController().signal),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "done"],
    );
    assert.deepEqual(events[0]?.payload, {
      runtimeSessionId: "thread-1",
      vendorEventType: "thread.started",
    });
    assert.equal(events[1]?.payload?.text, "Hello");
    assert.deepEqual(events[2]?.payload?.usage, {
      input_tokens: 3,
      cached_input_tokens: 1,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    });
  });

  it("resumes an existing SDK thread and emits its known session before stream output", async () => {
    const adapter = createCodexAdapter({
      createCodex: () => ({
        startThread: () => {
          throw new Error("not used");
        },
        resumeThread: (threadId, options) => {
          assert.equal(threadId, "thread-old");
          assert.deepEqual(options, { workingDirectory: "/work/project" });
          return {
            async runStreamed() {
              return { events: (async function* () {})() };
            },
          };
        },
      }),
    });

    const events = await collect(
      adapter.start(
        { ...runInput(), model: undefined, resumeThreadId: "thread-old" },
        new AbortController().signal,
      ),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "done"],
    );
    assert.equal(events[0]?.payload?.runtimeSessionId, "thread-old");
  });

  it("aborts an active Codex stream through the supplied signal", async () => {
    const controller = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    const adapter = createCodexAdapter({
      createCodex: () => ({
        startThread: () => ({
          async runStreamed(_prompt, options) {
            sdkSignal = options?.signal;
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: "thread-1" };
                await new Promise<void>((resolve) => {
                  options?.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
              })(),
            };
          },
        }),
        resumeThread: () => {
          throw new Error("not used");
        },
      }),
    });

    const stream = adapter.start(runInput(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "init");
    controller.abort();
    assert.equal((await iterator.next()).value?.type, "done");
    assert.equal(sdkSignal, controller.signal);
  });
});
