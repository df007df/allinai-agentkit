import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRunnerManager,
  InProcessRunnerManager,
  type PlatformAdapterLookup,
  type RunnerManagerOptions,
} from "./runner-manager.js";
import type { PlatformEvent, PlatformId, PlatformRunInput } from "./types.js";

function runInput(platform: PlatformRunInput["platform"]): PlatformRunInput {
  return {
    platform,
    prompt: "Summarise the local project",
    cwd: "/work/project",
    context: { projectId: "project-1" },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
};

class FakeTimers {
  readonly timers: ScheduledTimer[] = [];

  schedule = (callback: () => void, delayMs: number): ScheduledTimer => {
    const timer = { callback, delayMs, cleared: false, fired: false };
    this.timers.push(timer);
    return timer;
  };

  clear = (timer: unknown): void => {
    (timer as ScheduledTimer).cleared = true;
  };

  run(delayMs: number): void {
    for (const timer of this.timers) {
      if (timer.delayMs !== delayMs || timer.cleared || timer.fired) continue;
      timer.fired = true;
      timer.callback();
    }
  }
}

/**
 * A push-controlled fake adapter: tests emit/end/fail the underlying stream
 * while the manager drains it like a real platform adapter.
 */
type ControlledAdapter = {
  readonly id: PlatformId;
  emit(event: PlatformEvent): void;
  end(): void;
  fail(error: Error): void;
  readonly signal: AbortSignal | undefined;
  readonly startedInputs: readonly PlatformRunInput[];
};

function fakeAdapters(): {
  lookup: PlatformAdapterLookup;
  forPlatform(platform: PlatformId): ControlledAdapter;
} {
  const adapters = new Map<
    PlatformId,
    ReturnType<PlatformAdapterLookup["get"]>
  >();
  const controlled = new Map<PlatformId, ControlledAdapter>();

  const lookup: PlatformAdapterLookup = {
    get(id) {
      const existing = adapters.get(id);
      if (existing) return existing;
      const state = {
        signal: undefined as AbortSignal | undefined,
        inputs: [] as PlatformRunInput[],
        sinks: [] as PushQueue<PlatformEvent>[],
      };
      const platformAdapter = {
        id,
        async probe() {
          return { installed: true, version: "test" };
        },
        async *start(input: PlatformRunInput, signal: AbortSignal) {
          state.signal = signal;
          state.inputs.push(input);
          const queue = new PushQueue<PlatformEvent>();
          state.sinks.push(queue);
          try {
            for await (const event of queue.stream()) {
              yield event;
            }
          } catch (error) {
            if (signal.aborted && isAbortError(error)) {
              yield { type: "done", payload: { aborted: true } };
              return;
            }
            throw error;
          }
        },
      };
      adapters.set(
        id,
        platformAdapter as unknown as ReturnType<
          PlatformAdapterLookup["get"]
        >,
      );
      controlled.set(id, {
        id,
        emit(event) {
          for (const sink of state.sinks) sink.push(event);
        },
        end() {
          for (const sink of state.sinks) sink.close();
        },
        fail(error) {
          for (const sink of state.sinks) sink.fail(error);
        },
        get signal() {
          return state.signal;
        },
        get startedInputs() {
          return state.inputs;
        },
      });
      return adapters.get(id)!;
    },
  };

  return {
    lookup,
    forPlatform(platform) {
      lookup.get(platform); // ensure registered
      return controlled.get(platform)!;
    },
  };
}

/** Minimal push/pull queue driving a fake adapter's generator. */
class PushQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private state: "open" | "closed" | "failed" = "open";
  private failure: Error | null = null;

  push(value: T): void {
    if (this.state !== "open") return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.state !== "open") return;
    this.state = "closed";
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.state !== "open") return;
    this.state = "failed";
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *stream(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.state === "failed") throw this.failure;
      if (this.state === "closed") return;
      const result = await new Promise<IteratorResult<T>>((resolve) =>
        this.waiters.push(resolve),
      );
      // A waiter wakes as done only via close()/fail(); re-reading state
      // catches the failure either way.
      const settled = this.state as "open" | "closed" | "failed";
      if (settled === "failed") throw this.failure;
      if (result.done) return;
      yield result.value;
    }
  }
}

function managerOptions(
  lookup: PlatformAdapterLookup,
  timers: FakeTimers,
): RunnerManagerOptions {
  return {
    adapters: lookup,
    firstEventTimeoutMs: 10,
    stallTimeoutMs: 50,
    totalTimeoutMs: 300,
    scheduleTimeout: timers.schedule,
    clearScheduledTimeout: timers.clear,
  };
}

describe("InProcessRunnerManager", () => {
  it("forwards ordered adapter events and leaves the manager healthy after an error event", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const adapter = fake.forPlatform("codex");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    adapter.emit({ type: "init", payload: { sessionId: "s1" } });
    adapter.emit({ type: "text_delta", payload: { text: "hello" } });
    adapter.emit({ type: "error", payload: { reason: "adapter_failed" } });

    const events = await collect(stream);

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "error"],
    );
    assert.equal(manager.isHealthy(), true);
    assert.equal(manager.hasActiveExecution("e1"), false);
  });

  it("resolves the adapter by input.platform and passes the run input through", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const expected = runInput("claude");

    const stream = manager.start("e1", expected);
    await tick();
    const adapter = fake.forPlatform("claude");
    assert.equal(adapter.startedInputs.length, 1);
    assert.equal(adapter.startedInputs[0], expected);
    assert.ok(adapter.signal instanceof AbortSignal);
    adapter.emit({ type: "done", payload: { text: "ok" } });
    await collect(stream);
  });

  it("fails closed when no adapter registry is configured", async () => {
    const manager = createRunnerManager();
    const events = await collect(manager.start("e1", runInput("pi")));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.payload?.reason, "platform_adapter_unavailable");
  });

  it("reports a failure when the adapter stream ends before a terminal event", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const adapter = fake.forPlatform("codex");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    adapter.emit({ type: "init", payload: {} });
    adapter.end();

    const events = await collect(stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "error"],
    );
    assert.match(
      String(events.at(-1)?.payload?.reason),
      /runner_stream_ended/,
    );
  });

  it("keeps the run alive while events flow and fails on the stall and total limits", async () => {
    const fake = fakeAdapters();
    const timers = new FakeTimers();
    const manager = createRunnerManager(managerOptions(fake.lookup, timers));
    const adapter = fake.forPlatform("codex");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    adapter.emit({ type: "init", payload: {} });
    // Events keep arriving just inside the stall window: no stall failure.
    // Each emit wakes drain on a microtask; tick first so the manager has
    // actually processed the event (and restarted the stall clock) before
    // firing the fake clock.
    for (let n = 1; n <= 3; n += 1) {
      await tick();
      adapter.emit({ type: "tool", payload: { n } });
      await tick();
      timers.run(49);
    }
    // Total ceiling still fires even though the last event was recent.
    timers.run(300);
    const events = await collect(stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "tool", "tool", "tool", "error"],
    );
    const totalEvent = events.at(-1);
    assert.equal(totalEvent?.payload?.phase, "total");
    assert.match(String(totalEvent?.payload?.message), /total limit/);
  });

  it("fires a first-event watchdog when the adapter stays silent and aborts the run", async () => {
    const fake = fakeAdapters();
    const timers = new FakeTimers();
    const manager = createRunnerManager(managerOptions(fake.lookup, timers));
    const adapter = fake.forPlatform("claude");

    const stream = manager.start("e1", runInput("claude"));
    await tick();
    timers.run(10);
    const events = await collect(stream);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.payload?.phase, "first_event");
    assert.equal(adapter.signal?.aborted, true);
  });

  it("disarms the first-event watchdog once the first event arrives", async () => {
    const fake = fakeAdapters();
    const timers = new FakeTimers();
    const manager = createRunnerManager(managerOptions(fake.lookup, timers));
    const adapter = fake.forPlatform("codex");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    adapter.emit({ type: "init", payload: {} });
    await tick(); // let drain process init and disarm the first-event timer
    timers.run(10); // would be the first-event deadline
    adapter.emit({ type: "done", payload: {} });
    const events = await collect(stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "done"],
    );
  });

  it("fails with phase=stall when the event flow goes silent mid-run", async () => {
    const fake = fakeAdapters();
    const timers = new FakeTimers();
    const manager = createRunnerManager(managerOptions(fake.lookup, timers));
    const adapter = fake.forPlatform("claude");

    const stream = manager.start("e1", runInput("claude"));
    await tick();
    adapter.emit({ type: "init", payload: {} });
    await tick(); // let drain process init before arming the fake clock
    timers.run(50);
    const events = await collect(stream);

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "error"],
    );
    assert.equal(events.at(-1)?.payload?.phase, "stall");
  });

  it("turns a thrown adapter error into one terminal error without poisoning later runs", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const adapter = fake.forPlatform("codex");

    const first = manager.start("e1", runInput("codex"));
    await tick();
    adapter.fail(new Error("adapter exploded"));
    const firstEvents = await collect(first);
    assert.deepEqual(
      firstEvents.map((event) => event.type),
      ["error"],
    );
    assert.equal(
      firstEvents[0]?.payload?.reason,
      "platform_adapter_failed",
    );

    const second = manager.start("e2", runInput("codex"));
    await tick();
    fake.forPlatform("codex").emit({ type: "done", payload: {} });
    const secondEvents = await collect(second);
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ["done"],
    );
    assert.equal(manager.isHealthy(), true);
  });

  it("cancel aborts the adapter signal and the run finishes gracefully", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const adapter = fake.forPlatform("pi");

    const stream = manager.start("e1", runInput("pi"));
    await tick();
    const collected = collect(stream);
    await manager.cancel("e1");
    assert.equal(adapter.signal?.aborted, true);
    // The fake adapter surfaces abort as a done event.
    adapter.emit({ type: "done", payload: { aborted: true } });
    const events = await collected;
    assert.deepEqual(
      events.map((event) => event.type),
      ["done"],
    );
    assert.equal(manager.hasActiveExecution("e1"), false);
  });

  it("cancel of an unknown or already-settled execution is a no-op", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    await manager.cancel("missing");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    fake.forPlatform("codex").emit({ type: "done", payload: {} });
    await collect(stream);
    // Settled: cancel must not resurrect or throw.
    await manager.cancel("e1");
    assert.equal(manager.hasActiveExecution("e1"), false);
  });

  it("an AbortError surfacing after cancel lands as a graceful aborted done, not a failure", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const adapter = fake.forPlatform("codex");

    const stream = manager.start("e1", runInput("codex"));
    await tick();
    const collected = collect(stream);
    await manager.cancel("e1");
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    // The fake adapter mirrors the real CLI adapters: an abort surfaces as a
    // terminal done(aborted) event, never as a platform failure.
    adapter.fail(abortError);
    await tick();
    const events = await collected;
    assert.deepEqual(events, [
      { type: "done", payload: { aborted: true } },
    ]);
    assert.equal(manager.hasActiveExecution("e1"), false);
  });

  it("waitForIdle resolves once the last stream settles and tracks concurrent runs separately", async () => {
    const fake = fakeAdapters();
    const manager = new InProcessRunnerManager({ adapters: fake.lookup });
    const codex = fake.forPlatform("codex");
    const claude = fake.forPlatform("claude");

    const s1 = manager.start("e1", runInput("codex"));
    const s2 = manager.start("e2", runInput("claude"));
    await tick();

    let idle = false;
    void manager.waitForIdle().then(() => {
      idle = true;
    });
    await tick();
    assert.equal(idle, false);

    codex.emit({ type: "done", payload: {} });
    await collect(s1);
    await tick();
    assert.equal(idle, false, "claude run is still active");

    claude.emit({ type: "done", payload: {} });
    await collect(s2);
    await tick();
    assert.equal(idle, true);
    assert.equal(manager.hasActiveExecution("e1"), false);
    assert.equal(manager.hasActiveExecution("e2"), false);
  });

  it("respondToolApproval and ownerOfToolApproval stay as bridge-compatibility no-ops", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const stream = manager.start("e1", runInput("codex"));
    await tick();
    assert.doesNotThrow(() =>
      manager.respondToolApproval("e1", "req-1", "deny", "not today"),
    );
    assert.equal(manager.ownerOfToolApproval("req-1"), null);
    assert.equal(manager.ownerOfToolApproval("req-unknown"), null);
    fake.forPlatform("codex").emit({ type: "done", payload: {} });
    await collect(stream);
  });

  it("starting the same executionId twice returns the same stream", async () => {
    const fake = fakeAdapters();
    const manager = createRunnerManager({ adapters: fake.lookup });
    const stream = manager.start("e1", runInput("codex"));
    assert.equal(manager.start("e1", runInput("codex")), stream);
    await tick();
    fake.forPlatform("codex").emit({ type: "done", payload: {} });
    await collect(stream);
  });
});
