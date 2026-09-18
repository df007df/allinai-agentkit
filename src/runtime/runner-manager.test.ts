import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  createRunnerManager,
  type RunnerChildProcess,
  type RunnerSpawn,
} from "./runner-manager.js";
import type { PlatformRunInput } from "./types.js";

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

class FakeChild extends EventEmitter implements RunnerChildProcess {
  pid: number | undefined;
  readonly stdin = {
    writes: [] as string[],
    write: (chunk: string) => {
      this.stdin.writes.push(chunk);
      return true;
    },
  };
  stdout: EventEmitter | null = new EventEmitter();
  readonly stderr = new EventEmitter();
  killSignal: NodeJS.Signals | undefined;
  killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignal = signal;
    if (signal) this.killSignals.push(signal);
    return true;
  }

  writeEvent(event: unknown): void {
    this.stdout?.emit("data", `${JSON.stringify({ type: "event", event })}\n`);
  }

  writeRaw(line: string): void {
    this.stdout?.emit("data", line);
  }

  writeChunk(chunk: Uint8Array): void {
    this.stdout?.emit("data", chunk);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
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

function fakeSpawner(): {
  spawn: RunnerSpawn;
  children: FakeChild[];
  calls: Array<{ command: string; args: string[]; options: unknown }>;
} {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; options: unknown }> =
    [];
  return {
    children,
    calls,
    spawn: (command, args, options) => {
      const child = new FakeChild();
      children.push(child);
      calls.push({ command, args, options });
      return child;
    },
  };
}

describe("RunnerManager", () => {
  it("forwards ordered events from one child and leaves the manager alive when it exits with an error", async () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    const stream = manager.start("e1", runInput("codex"));
    const child = fake.children[0]!;
    child.writeEvent({ type: "init", payload: { sessionId: "s1" } });
    child.writeEvent({ type: "text_delta", payload: { text: "hello" } });
    child.writeEvent({ type: "error", payload: { reason: "adapter_failed" } });
    child.close(1);

    const events = await collect(stream);

    assert.deepEqual(
      events.map((event) => event.type),
      ["init", "text_delta", "error"],
    );
    assert.equal(manager.isHealthy(), true);
  });

  it("cancels the child process group for the requested execution only", async () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    manager.start("e1", runInput("codex"));
    manager.start("e2", runInput("claude"));
    await manager.cancel("e1");

    assert.equal(fake.children[0]?.killSignal, "SIGTERM");
    assert.equal(fake.children[1]?.killSignal, undefined);
    fake.children[0]?.close(null, "SIGTERM");
    fake.children[1]?.close(0);
  });

  it("waits for a terminal child's close before reporting the runner idle", async () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    const stream = manager.start("e1", runInput("codex"));
    const idle = manager.waitForIdle();
    let idleResolved = false;
    void idle.then(() => {
      idleResolved = true;
    });

    fake.children[0]?.writeEvent({ type: "done" });
    await collect(stream);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(idleResolved, false);

    fake.children[0]?.close(0);
    await idle;
    assert.equal(idleResolved, true);
  });

  it("uses a fixed client-owned entrypoint with shell disabled and sends Hub input only over JSONL", () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    manager.start("e1", runInput("pi"));

    assert.deepEqual(fake.calls[0], {
      command: process.execPath,
      args: ["/client-owned/runner-child.js"],
      options: {
        cwd: undefined,
        env: undefined,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    });
    assert.match(
      fake.children[0]!.stdin.writes[0]!,
      /Summarise the local project/,
    );
    assert.doesNotMatch(
      fake.calls[0]!.args.join(" "),
      /Summarise the local project/,
    );
    fake.children[0]?.close(0);
  });

  it("turns malformed child JSONL into one error event without poisoning later runs", async () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    const first = manager.start("e1", runInput("zcode"));
    fake.children[0]?.writeRaw("not json\n");
    fake.children[0]?.close(1);
    const firstEvents = await collect(first);

    const second = manager.start("e2", runInput("codex"));
    fake.children[1]?.writeEvent({ type: "done" });
    fake.children[1]?.close(0);
    const secondEvents = await collect(second);

    assert.deepEqual(
      firstEvents.map((event) => event.type),
      ["error"],
    );
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ["done"],
    );
    assert.equal(manager.isHealthy(), true);
  });

  it("cleans an active execution when a stdout-less child later closes", async () => {
    const timers = new FakeTimers();
    const child = new FakeChild();
    child.stdout = null;
    const spawn = () => child;
    const noStdoutManager = createRunnerManager({
      spawn,
      childEntrypoint: "/client-owned/runner-child.js",
      terminationGraceMs: 25,
      scheduleTimeout: timers.schedule,
      clearScheduledTimeout: timers.clear,
    });

    const events = await collect(
      noStdoutManager.start("e1", runInput("codex")),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["error"],
    );
    assert.equal(noStdoutManager.hasActiveExecution("e1"), true);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);

    child.close(null, "SIGTERM");
    assert.equal(noStdoutManager.hasActiveExecution("e1"), false);
    timers.run(25);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  });

  it("preserves Chinese text when a UTF-8 character is split between stdout chunks", async () => {
    const fake = fakeSpawner();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
    });

    const stream = manager.start("e1", runInput("codex"));
    const line = Buffer.from(
      `${JSON.stringify({ type: "event", event: { type: "text_delta", payload: { text: "中文" } } })}\n`,
      "utf8",
    );
    const firstChineseByte = line.indexOf(Buffer.from("中", "utf8"));
    fake.children[0]?.writeChunk(line.subarray(0, firstChineseByte + 1));
    fake.children[0]?.writeChunk(line.subarray(firstChineseByte + 1));
    fake.children[0]?.writeEvent({ type: "done" });
    fake.children[0]?.close(0);

    const events = await collect(stream);
    assert.equal(events[0]?.payload?.text, "中文");
    assert.equal(events[1]?.type, "done");
  });

  it("escalates an ignored cancellation to SIGKILL and keeps its child tracked until close", async () => {
    const fake = fakeSpawner();
    const timers = new FakeTimers();
    const processGroupSignals: NodeJS.Signals[] = [];
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
      terminationGraceMs: 25,
      scheduleTimeout: timers.schedule,
      clearScheduledTimeout: timers.clear,
      killProcessGroup: (_pid, signal) => processGroupSignals.push(signal),
    });

    manager.start("e1", runInput("codex"));
    fake.children[0]!.pid = 123;
    await manager.cancel("e1");

    assert.deepEqual(processGroupSignals, ["SIGTERM"]);
    assert.deepEqual(fake.children[0]?.killSignals, []);
    assert.equal(manager.hasActiveExecution("e1"), true);
    manager.start("e1", runInput("codex"));
    assert.equal(fake.children.length, 1);

    timers.run(25);
    assert.deepEqual(processGroupSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(manager.hasActiveExecution("e1"), true);

    fake.children[0]?.close(null, "SIGKILL");
    assert.equal(manager.hasActiveExecution("e1"), false);
  });

  it("escalates timeout and protocol failures while emitting only one terminal error", async () => {
    const fake = fakeSpawner();
    const timers = new FakeTimers();
    const manager = createRunnerManager({
      spawn: fake.spawn,
      childEntrypoint: "/client-owned/runner-child.js",
      executionTimeoutMs: 100,
      terminationGraceMs: 25,
      scheduleTimeout: timers.schedule,
      clearScheduledTimeout: timers.clear,
    });

    const stream = manager.start("e1", runInput("codex"));
    timers.run(100);
    const events = await collect(stream);

    assert.deepEqual(
      events.map((event) => event.type),
      ["error"],
    );
    assert.equal(fake.children[0]?.killSignal, "SIGTERM");
    assert.equal(events[0]?.payload?.reason, "runner_timeout");
    assert.equal(manager.hasActiveExecution("e1"), true);
    timers.run(25);
    assert.deepEqual(fake.children[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
    fake.children[0]?.close(null, "SIGKILL");

    const protocolStream = manager.start("e2", runInput("claude"));
    fake.children[1]?.writeRaw("invalid-json\n");
    const protocolEvents = await collect(protocolStream);
    assert.deepEqual(
      protocolEvents.map((event) => event.type),
      ["error"],
    );
    assert.deepEqual(fake.children[1]?.killSignals, ["SIGTERM"]);
    timers.run(25);
    assert.deepEqual(fake.children[1]?.killSignals, ["SIGTERM", "SIGKILL"]);
    fake.children[1]?.close(null, "SIGKILL");

    const streamError = manager.start("e3", runInput("pi"));
    fake.children[2]?.stdout?.emit("error", new Error("stream broke"));
    const streamEvents = await collect(streamError);
    assert.deepEqual(
      streamEvents.map((event) => event.type),
      ["error"],
    );
    assert.deepEqual(fake.children[2]?.killSignals, ["SIGTERM"]);
    timers.run(25);
    assert.deepEqual(fake.children[2]?.killSignals, ["SIGTERM", "SIGKILL"]);
    fake.children[2]?.close(null, "SIGKILL");
  });
});
