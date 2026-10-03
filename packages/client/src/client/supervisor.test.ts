import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ClientStateStore, type ExecutionState } from "./state-store.js";
import { ClientSupervisor, mergeDesiredPlugins } from "./supervisor.js";
import type { ClientTransport, ClientTransportHandlers } from "./transport.js";
import type { ClientCommand, ClientEvent } from "./types.js";
import type { InventoryReport } from "../protocol/index.js";
import type { PluginSyncAcknowledgement } from "./types.js";
import type {
  ActivePluginSnapshot,
  InstalledPlugin,
  PluginConfig,
} from "../plugins/types.js";
import type { CapabilityEvent } from "../capabilities/shell-wire.js";
import type { ShellCapability } from "../capabilities/types.js";
import type {
  PlatformEvent,
  PlatformRunInput,
  RunnerManager,
} from "../runtime/types.js";
import type {
  CapabilityHostPort,
  ResolvedActiveCapability,
} from "./supervisor.js";

function agentRun(
  executionId = "e1",
): Extract<ClientCommand, { kind: "agent.run" }> {
  return {
    kind: "agent.run",
    commandId: `command-${executionId}`,
    executionId,
    taskId: `task-${executionId}`,
    attempt: 1,
    runtime: "codex",
    payload: { prompt: "hello" },
  };
}

function capabilityInvoke(
  executionId = "capability-e1",
  input: Record<string, unknown> = { branch: "main" },
): Extract<ClientCommand, { kind: "capability.invoke" }> {
  return {
    kind: "capability.invoke",
    commandId: `capability-command-${executionId}`,
    executionId,
    taskId: `capability-task-${executionId}`,
    attempt: 1,
    capabilityId: "demo.publish",
    input,
  };
}

const installedCapabilityPlugin: InstalledPlugin = {
  id: "demo.plugin",
  gitUrl: "https://github.com/allin-ai/demo-plugin.git",
  enabled: true,
  resolvedCommit: "b".repeat(40),
  installedAt: "2026-09-18T00:00:00.000Z",
  status: "active",
};

const declaredCapability: ShellCapability = {
  id: "demo.publish",
  entry: "bin/publish.sh",
  inputSchema: { type: "object" },
  contextKeys: ["execution", "workspace", "projectConfig"],
  permissions: ["network"],
  timeoutSeconds: 30,
};

function resolvedCapability(): ResolvedActiveCapability {
  return {
    plugin: installedCapabilityPlugin,
    capability: declaredCapability,
    pluginRoot: "/agent/plugins/demo.plugin/revisions/b",
  };
}

class FakeCapabilityHost implements CapabilityHostPort {
  invocations: Array<{
    resolved: ResolvedActiveCapability;
    input: unknown;
    context: Record<string, unknown>;
  }> = [];
  events: CapabilityEvent[] = [
    { type: "progress", payload: { phase: "started" } },
    { type: "result", payload: { published: true } },
  ];
  private completed: (() => void) | undefined;
  private readonly completion = new Promise<void>((resolve) => {
    this.completed = resolve;
  });
  available: ResolvedActiveCapability | null = resolvedCapability();

  async resolveActiveCapability(
    capabilityId: string,
  ): Promise<ResolvedActiveCapability | null> {
    return this.available?.capability.id === capabilityId
      ? this.available
      : null;
  }

  async *invoke(
    resolved: ResolvedActiveCapability,
    input: unknown,
    context: Record<string, unknown>,
    _signal: AbortSignal,
  ): AsyncIterable<CapabilityEvent> {
    this.invocations.push({ resolved, input, context });
    for (const event of this.events) {
      if (event.type === "result" || event.type === "error") {
        this.completed?.();
      }
      yield event;
    }
    this.completed?.();
  }

  async waitUntilComplete(): Promise<void> {
    await this.completion;
  }
}

class AbortAwareCapabilityHost extends FakeCapabilityHost {
  private started: (() => void) | undefined;
  private readonly startPromise = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  aborted = false;
  private finished: (() => void) | undefined;
  private readonly finishPromise = new Promise<void>((resolve) => {
    this.finished = resolve;
  });

  override async *invoke(
    resolved: ResolvedActiveCapability,
    input: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityEvent> {
    this.invocations.push({ resolved, input, context });
    this.started?.();
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    this.finished?.();
    yield { type: "result", payload: { shouldNotOverwriteCancellation: true } };
  }

  async waitUntilStarted(): Promise<void> {
    await this.startPromise;
  }

  async waitUntilFinished(): Promise<void> {
    await this.finishPromise;
  }
}

class DeferredShutdownCapabilityHost extends FakeCapabilityHost {
  private releaseCleanup: (() => void) | undefined;
  private readonly cleanupReleased = new Promise<void>((resolve) => {
    this.releaseCleanup = resolve;
  });
  private reportStarted: (() => void) | undefined;
  private readonly started = new Promise<void>((resolve) => {
    this.reportStarted = resolve;
  });
  private reportAborted: (() => void) | undefined;
  private readonly aborted = new Promise<void>((resolve) => {
    this.reportAborted = resolve;
  });

  override async *invoke(
    resolved: ResolvedActiveCapability,
    input: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityEvent> {
    this.invocations.push({ resolved, input, context });
    this.reportStarted?.();
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          this.reportAborted?.();
          resolve();
        },
        { once: true },
      );
    });
    await this.cleanupReleased;
  }

  async waitUntilStarted(): Promise<void> {
    await this.started;
  }

  async waitUntilAborted(): Promise<void> {
    await this.aborted;
  }

  finishCleanup(): void {
    this.releaseCleanup?.();
  }
}

const inventoryReport = (): InventoryReport => ({
  type: "inventory.report",
  reportedAt: "2026-09-19T00:00:00.000Z",
  platforms: [{ platform: "codex", installed: true, version: "1.2.3" }],
  plugins: [
    {
      id: "demo",
      gitUrl: "https://example.test/demo.git",
      enabled: true,
      status: "active",
      resolvedCommit: "a".repeat(40),
      installedAt: "2026-09-19T00:00:00.000Z",
    },
  ],
  projects: [],
});

class FakeTransport implements ClientTransport {
  handlers: ClientTransportHandlers | null = null;
  pushed: ClientEvent[][] = [];
  acknowledgements: Record<string, number> = {};
  pushFailure: Error | null = null;
  pluginAcknowledgements: PluginSyncAcknowledgement[] = [];
  inventoryReports: InventoryReport[] = [];
  closed = false;

  async connect(handlers: ClientTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async push(events: ClientEvent[]): Promise<Record<string, number>> {
    if (this.pushFailure) throw this.pushFailure;
    this.pushed.push(events);
    return this.acknowledgements;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async reportPluginSync(
    acknowledgement: PluginSyncAcknowledgement,
  ): Promise<void> {
    this.pluginAcknowledgements.push(acknowledgement);
  }

  async reportInventory(report: InventoryReport): Promise<void> {
    this.inventoryReports.push(report);
  }

  async deliver(command: ClientCommand): Promise<void> {
    if (!this.handlers) throw new Error("transport is not connected");
    await this.handlers.command(command);
  }

  async reconnect(): Promise<void> {
    if (!this.handlers) throw new Error("transport is not connected");
    await this.handlers.connected();
  }

  async deliverPluginSync(input: {
    revision: string;
    plugins: PluginConfig[];
    inventoryQuery?: boolean;
  }): Promise<void> {
    if (!this.handlers?.pluginSync) {
      throw new Error("plugin sync handler is not connected");
    }
    await this.handlers.pluginSync({
      revision: input.revision,
      plugins: input.plugins,
      inventoryQuery: input.inventoryQuery === true,
    });
  }
}

class FakePluginManager {
  syncCount = 0;
  failNext = false;
  snapshots: ActivePluginSnapshot[] = [
    { id: "demo", resolvedCommit: "a".repeat(40) },
  ];

  async sync(desired: PluginConfig[]): Promise<InstalledPlugin[]> {
    this.syncCount += 1;
    if (this.failNext) {
      return [
        {
          ...desired[0]!,
          resolvedCommit: "a".repeat(40),
          installedAt: "2026-09-18T00:00:00.000Z",
          status: "failed",
          lastError: "invalid plugin manifest",
        },
      ];
    }
    return desired.map((plugin) => ({
      ...plugin,
      resolvedCommit: "a".repeat(40),
      installedAt: "2026-09-18T00:00:00.000Z",
      status: "active",
    }));
  }

  snapshotActivePlugins(): ActivePluginSnapshot[] {
    return [...this.snapshots];
  }

  async check(
    desired: PluginConfig[],
  ): Promise<Array<{ id: string; resolvedCommit: string; diverged: false; aheadCount: 0; localHead: string }>> {
    return desired.map(() => ({
      id: "demo",
      resolvedCommit: "a".repeat(40),
      localHead: "a".repeat(40),
      diverged: false as const,
      aheadCount: 0 as const,
    }));
  }

  async forceTo(): Promise<InstalledPlugin> {
    throw new Error("forceTo is not exercised by supervisor tests");
  }
}

class DeferredPluginManager extends FakePluginManager {
  private readonly released: Promise<void>;
  private releaseSync: (() => void) | null = null;
  private enterSync: (() => void) | null = null;
  private readonly enteredSync: Promise<void>;

  constructor() {
    super();
    this.released = new Promise<void>((resolve) => {
      this.releaseSync = resolve;
    });
    this.enteredSync = new Promise<void>((resolve) => {
      this.enterSync = resolve;
    });
  }

  override async sync(desired: PluginConfig[]): Promise<InstalledPlugin[]> {
    this.syncCount += 1;
    this.enterSync?.();
    await this.released;
    return desired.map((plugin) => ({
      ...plugin,
      resolvedCommit: "a".repeat(40),
      installedAt: "2026-09-18T00:00:00.000Z",
      status: "active",
    }));
  }

  async waitUntilSyncStarts(): Promise<void> {
    await this.enteredSync;
  }

  resolveSync(): void {
    this.releaseSync?.();
  }
}

class FakeRunner implements RunnerManager {
  started: Array<{ executionId: string; input: PlatformRunInput }> = [];
  cancelled: string[] = [];
  observedState: ExecutionState | undefined;
  cancelObservedState: ExecutionState | undefined;
  private readonly streamClosers = new Map<string, () => void>();

  constructor(protected readonly store: ClientStateStore) {}

  start(
    executionId: string,
    input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    this.observedState = this.store.getExecution(executionId)?.state;
    this.started.push({ executionId, input });
    const finished = new Promise<void>((resolve) => {
      this.streamClosers.set(executionId, resolve);
    });
    return (async function* (): AsyncIterable<PlatformEvent> {
      await finished;
    })();
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelObservedState = this.store.getExecution(executionId)?.state;
    this.cancelled.push(executionId);
    this.streamClosers.get(executionId)?.();
  }
}

class DeferredStartRunner extends FakeRunner {
  private readonly released: Promise<void>;
  private releaseStart: (() => void) | null = null;
  private enterStart: (() => void) | null = null;
  private readonly enteredStartPromise: Promise<void>;

  constructor(store: ClientStateStore) {
    super(store);
    this.released = new Promise<void>((resolve) => {
      this.releaseStart = resolve;
    });
    this.enteredStartPromise = new Promise<void>((resolve) => {
      this.enterStart = resolve;
    });
  }

  override start(
    executionId: string,
    input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    super.start(executionId, input);
    this.enterStart?.();
    const released = this.released;
    return (async function* (): AsyncIterable<PlatformEvent> {
      await released;
    })();
  }

  async waitUntilStarted(): Promise<void> {
    await this.enteredStartPromise;
  }

  resolveStart(): void {
    this.releaseStart?.();
  }
}

class DeferredShutdownRunner implements RunnerManager {
  readonly cancelled: string[] = [];
  private releaseCleanup: (() => void) | undefined;
  private readonly cleanupReleased = new Promise<void>((resolve) => {
    this.releaseCleanup = resolve;
  });
  private reportStarted: (() => void) | undefined;
  private readonly started = new Promise<void>((resolve) => {
    this.reportStarted = resolve;
  });
  private reportCancelled: (() => void) | undefined;
  private readonly cancelledPromise = new Promise<void>((resolve) => {
    this.reportCancelled = resolve;
  });

  start(
    _executionId: string,
    _input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    this.reportStarted?.();
    const cleanupReleased = this.cleanupReleased;
    return (async function* (): AsyncIterable<PlatformEvent> {
      await cleanupReleased;
    })();
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
    this.reportCancelled?.();
  }

  async waitForIdle(): Promise<void> {
    await this.cleanupReleased;
  }

  async waitUntilStarted(): Promise<void> {
    await this.started;
  }

  async waitUntilCancelled(): Promise<void> {
    await this.cancelledPromise;
  }

  finishCleanup(): void {
    this.releaseCleanup?.();
  }
}

class PlatformEventQueue implements AsyncIterable<PlatformEvent> {
  private readonly values: PlatformEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<PlatformEvent>) => void
  > = [];

  emit(event: PlatformEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.values.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PlatformEvent> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      const next = await new Promise<IteratorResult<PlatformEvent>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * The production RunnerManager owns a child process. This fake substitutes
 * only that external boundary; the Supervisor and SQLite state store stay
 * real so tests assert their durable observable behavior.
 */
class StreamingRunner implements RunnerManager {
  readonly cancelled: string[] = [];
  cancelObservedState: ExecutionState | undefined;
  private readonly streams = new Map<string, PlatformEventQueue>();

  constructor(private readonly store: ClientStateStore) {}

  start(
    executionId: string,
    _input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    return this.streamFor(executionId);
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelObservedState = this.store.getExecution(executionId)?.state;
    this.cancelled.push(executionId);
  }

  emit(executionId: string, event: PlatformEvent): void {
    this.streamFor(executionId).emit(event);
  }

  private streamFor(executionId: string): PlatformEventQueue {
    const existing = this.streams.get(executionId);
    if (existing) return existing;
    const created = new PlatformEventQueue();
    this.streams.set(executionId, created);
    return created;
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastFailure = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastFailure;
}

describe("ClientSupervisor", () => {
  let dir: string;
  let store: ClientStateStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-supervisor-"));
    store = new ClientStateStore(path.join(dir, "state.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("durably admits an auto-approved run before starting its runner", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());

    assert.equal(runner.started.length, 1);
    assert.equal(runner.observedState, "running");
    assert.equal(store.getExecution("e1")?.state, "running");
    assert.deepEqual(
      store.listUnackedEvents("e1").map((event) => event.type),
      ["received", "running"],
    );
  });

  it("snapshots current active plugin commits before a run and includes them in its durable running event", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());

    assert.deepEqual(
      store.getExecution("e1")?.pluginSnapshot,
      plugins.snapshots,
    );
    assert.deepEqual(store.listUnackedEvents("e1")[0]?.payload, {
      prompt: "hello",
      runtime: "codex",
      pluginSnapshot: plugins.snapshots,
    });
    assert.deepEqual(store.listUnackedEvents("e1")[1]?.payload, {
      runtime: "codex",
      pluginSnapshot: plugins.snapshots,
    });
  });

  it("syncs each successful plugin revision once, retries failed revisions, and leaves active runs alone", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
    });
    await supervisor.start();
    await transport.deliver(agentRun());

    const desired: PluginConfig[] = [
      {
        id: "demo",
        gitUrl: "https://github.com/allin-ai/demo.git",
        enabled: true,
        runtimes: ["codex"],
      },
    ];
    await transport.deliverPluginSync({
      revision: "plugins-v1",
      plugins: desired,
    });
    await transport.deliverPluginSync({
      revision: "plugins-v1",
      plugins: desired,
    });

    assert.equal(plugins.syncCount, 1);
    assert.equal(store.getLastPluginSyncRevision(), "plugins-v1");
    assert.deepEqual(
      transport.pluginAcknowledgements.map(({ revision, status }) => ({
        revision,
        status,
      })),
      [
        { revision: "plugins-v1", status: "applied" },
        { revision: "plugins-v1", status: "already_applied" },
      ],
    );

    plugins.failNext = true;
    await transport.deliverPluginSync({
      revision: "plugins-v2",
      plugins: desired,
    });
    assert.equal(store.getLastPluginSyncRevision(), "plugins-v1");
    assert.equal(store.getExecution("e1")?.state, "running");
    assert.equal(transport.pluginAcknowledgements.at(-1)?.status, "failed");
    assert.equal(
      transport.pluginAcknowledgements.at(-1)?.error?.code,
      "plugin_sync_failed",
    );

    plugins.failNext = false;
    await transport.deliverPluginSync({
      revision: "plugins-v2",
      plugins: desired,
    });
    assert.equal(plugins.syncCount, 3);
    assert.equal(store.getLastPluginSyncRevision(), "plugins-v2");
    assert.equal(transport.pluginAcknowledgements.at(-1)?.status, "applied");
  });

  it("coalesces concurrent downlinks for one plugin revision and records one applied acknowledgement", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new DeferredPluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
    });
    await supervisor.start();
    const input = {
      revision: "plugins-v1",
      plugins: [
        {
          id: "demo",
          gitUrl: "https://github.com/allin-ai/demo.git",
          enabled: true,
        },
      ],
    } satisfies { revision: string; plugins: PluginConfig[] };

    const first = transport.deliverPluginSync(input);
    await plugins.waitUntilSyncStarts();
    const second = transport.deliverPluginSync(input);

    assert.equal(plugins.syncCount, 1);
    plugins.resolveSync();
    await Promise.all([first, second]);

    assert.equal(store.getLastPluginSyncRevision(), "plugins-v1");
    assert.deepEqual(
      transport.pluginAcknowledgements.map(({ revision, status }) => ({
        revision,
        status,
      })),
      [{ revision: "plugins-v1", status: "applied" }],
    );
  });

  it("persists normalized progress before reporting a runner completion", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    runner.emit("e1", { type: "text_delta", payload: { text: "hello" } });
    runner.emit("e1", { type: "done", payload: { sessionId: "s1" } });

    await eventually(() => {
      assert.deepEqual(
        store.listUnackedEvents("e1").map((event) => event.type),
        ["received", "running", "progress", "done"],
      );
    });
    assert.deepEqual(store.getExecution("e1")?.state, "done");
    const progress = store.listUnackedEvents("e1")[2];
    assert.deepEqual(progress?.eventType, "text_delta");
    assert.deepEqual(progress?.payload, { text: "hello" });
  });

  it("maps a runner stream error to one durable failed terminal state", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    runner.emit("e1", {
      type: "error",
      payload: { reason: "adapter_failed", message: "SDK unavailable" },
    });

    await eventually(() => {
      assert.equal(store.getExecution("e1")?.state, "failed");
    });
    assert.deepEqual(
      store.listUnackedEvents("e1").map((event) => event.type),
      ["received", "running", "failed"],
    );
    assert.deepEqual(store.listUnackedEvents("e1").at(-1)?.payload, {
      reason: "adapter_failed",
      message: "SDK unavailable",
    });
  });

  it("cancels durably before its runner and ignores a later runner terminal event", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    await transport.deliver({
      kind: "cancel",
      commandId: "cancel-e1",
      executionId: "e1",
    });
    runner.emit("e1", { type: "done" });
    await transport.deliver({
      kind: "cancel",
      commandId: "repeat-cancel-e1",
      executionId: "e1",
    });

    await eventually(() => {
      assert.deepEqual(
        store.listUnackedEvents("e1").map((event) => event.type),
        ["received", "running", "cancelled"],
      );
    });
    assert.equal(store.getExecution("e1")?.state, "cancelled");
    assert.equal(runner.cancelObservedState, "cancelled");
    assert.deepEqual(runner.cancelled, ["e1"]);
  });

  it("does not overwrite recovery or terminal executions with later runner terminals", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun("recovering"));
    store.markRecoveryRequired("recovering");
    runner.emit("recovering", { type: "done" });

    await transport.deliver(agentRun("completed"));
    runner.emit("completed", { type: "done" });
    await eventually(() => {
      assert.equal(store.getExecution("completed")?.state, "done");
    });
    runner.emit("completed", {
      type: "error",
      payload: { reason: "late_runner_error" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(store.getExecution("recovering")?.state, "recovery_required");
    assert.deepEqual(
      store.listUnackedEvents("recovering").map((event) => event.type),
      ["received", "running", "recovery_required"],
    );
    assert.equal(store.getExecution("completed")?.state, "done");
    assert.deepEqual(
      store.listUnackedEvents("completed").map((event) => event.type),
      ["received", "running", "done"],
    );
  });

  it("starts a run once, retains received on duplicate delivery, and replays after reconnect", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    await transport.deliver(agentRun());
    await supervisor.flush();

    assert.equal(runner.started.length, 1);
    assert.deepEqual(
      transport.pushed[0]?.map((event) => event.eventSeq),
      [1, 2],
    );
    assert.deepEqual(
      store.listUnackedEvents("e1").map((event) => event.eventSeq),
      [1, 2],
    );

    await transport.reconnect();

    assert.deepEqual(
      transport.pushed[1]?.map((event) => event.eventSeq),
      [1, 2],
    );
  });

  it("defaults to rejection and starts an approved persisted agent command only once", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({ store, transport, runner });
    await supervisor.start();

    await transport.deliver(agentRun());

    assert.equal(store.getExecution("e1")?.state, "rejected");
    assert.equal(runner.started.length, 0);

    const approvalTransport = new FakeTransport();
    const approvalSupervisor = new ClientSupervisor({
      store,
      transport: approvalTransport,
      runner,
      policy: () => "approval",
    });
    await approvalSupervisor.start();
    await approvalTransport.deliver(agentRun("e2"));

    assert.equal(store.getExecution("e2")?.state, "awaiting_approval");
    await approvalSupervisor.approve("e2");
    assert.deepEqual(
      runner.started.map((command) => command.executionId),
      ["e2"],
    );
    assert.equal(store.getExecution("e2")?.state, "running");
  });

  it("durably rejects an unavailable capability without calling a runner", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver({
      kind: "capability.invoke",
      commandId: "capability-c1",
      executionId: "capability-e1",
      taskId: "capability-t1",
      attempt: 1,
      capabilityId: "acme.publish",
      input: { branch: "main" },
    });

    assert.equal(store.getExecution("capability-e1")?.state, "rejected");
    assert.deepEqual(runner.started, []);
    assert.deepEqual(store.listUnackedEvents("capability-e1").at(-1)?.payload, {
      reason: "capability_host_unavailable",
    });
  });

  it("runs an auto-approved declared capability with sanitized context and durable events", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const capabilities = new FakeCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({
        workspace: "/workspace/demo",
        projectConfig: { visible: true, token: "must-not-cross-process" },
      }),
    });
    await supervisor.start();

    await transport.deliver(capabilityInvoke());
    await capabilities.waitUntilComplete();

    assert.equal(store.getExecution("capability-e1")?.state, "done");
    assert.deepEqual(capabilities.invocations[0], {
      resolved: resolvedCapability(),
      input: { branch: "main" },
      context: {
        execution: {
          executionId: "capability-e1",
          taskId: "capability-task-capability-e1",
          commandId: "capability-command-capability-e1",
          attempt: 1,
        },
        workspace: { path: "/workspace/demo" },
        projectConfig: { visible: true },
      },
    });
    assert.deepEqual(
      store
        .listUnackedEvents("capability-e1")
        .map((event) => [event.type, event.payload]),
      [
        ["received", undefined],
        [
          "running",
          {
            capabilityId: "demo.publish",
            pluginSnapshot: [
              { id: "demo.plugin", resolvedCommit: "b".repeat(40) },
            ],
          },
        ],
        ["progress", { eventType: "progress", phase: "started" }],
        ["done", { published: true }],
      ],
    );
    assert.deepEqual(runner.started, []);
  });

  it("requires local approval before a capability host starts", async () => {
    const transport = new FakeTransport();
    const capabilities = new FakeCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner: new FakeRunner(store),
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: [],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();

    await transport.deliver(capabilityInvoke("capability-approved"));

    assert.equal(
      store.getExecution("capability-approved")?.state,
      "awaiting_approval",
    );
    assert.equal(capabilities.invocations.length, 0);

    await supervisor.approve("capability-approved");
    await capabilities.waitUntilComplete();

    assert.equal(store.getExecution("capability-approved")?.state, "done");
    assert.equal(capabilities.invocations.length, 1);
  });

  it("cancels a running capability through its abort signal without a later terminal overwrite", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const capabilities = new AbortAwareCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();
    await transport.deliver(capabilityInvoke("capability-cancelled"));
    await capabilities.waitUntilStarted();

    await transport.deliver({
      kind: "cancel",
      commandId: "cancel-capability",
      executionId: "capability-cancelled",
    });
    await capabilities.waitUntilFinished();

    assert.equal(capabilities.aborted, true);
    assert.equal(
      store.getExecution("capability-cancelled")?.state,
      "cancelled",
    );
    assert.deepEqual(runner.cancelled, []);
  });

  it("does not start an absent or locally denied capability", async () => {
    const transport = new FakeTransport();
    const capabilities = new FakeCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner: new FakeRunner(store),
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: false,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();

    await transport.deliver(capabilityInvoke("capability-denied"));
    capabilities.available = null;
    await transport.deliver(capabilityInvoke("capability-absent"));

    assert.equal(store.getExecution("capability-denied")?.state, "rejected");
    assert.deepEqual(
      store.listUnackedEvents("capability-denied").at(-1)?.payload,
      { reason: "client is disabled" },
    );
    assert.equal(store.getExecution("capability-absent")?.state, "rejected");
    assert.deepEqual(
      store.listUnackedEvents("capability-absent").at(-1)?.payload,
      { reason: "capability_not_found" },
    );
    assert.equal(capabilities.invocations.length, 0);
  });

  it("durably rejects invalid capability input before the host can spawn", async () => {
    const transport = new FakeTransport();
    const capabilities = new FakeCapabilityHost();
    capabilities.available = {
      ...resolvedCapability(),
      capability: {
        ...declaredCapability,
        inputSchema: {
          type: "object",
          properties: { branch: { type: "string", minLength: 1 } },
          required: ["branch"],
          additionalProperties: false,
        },
      },
    };
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner: new FakeRunner(store),
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();

    await transport.deliver(capabilityInvoke("capability-invalid-input", {}));

    assert.equal(
      store.getExecution("capability-invalid-input")?.state,
      "rejected",
    );
    assert.deepEqual(
      store.listUnackedEvents("capability-invalid-input").at(-1)?.payload,
      { reason: "capability_input_invalid" },
    );
    assert.equal(capabilities.invocations.length, 0);
  });

  it("persists pre-start cancellation before asking the runner to cancel", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "approval",
    });
    await supervisor.start();
    await transport.deliver(agentRun());

    await transport.deliver({
      kind: "cancel",
      commandId: "cancel-e1",
      executionId: "e1",
    });

    assert.equal(store.getExecution("e1")?.state, "cancelled");
    assert.equal(runner.cancelObservedState, "cancelled");
    assert.deepEqual(runner.cancelled, ["e1"]);
    assert.equal(runner.started.length, 0);
  });

  it("keeps a durable cancellation after a still-active runner stream ends", async () => {
    const transport = new FakeTransport();
    const runner = new DeferredStartRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    await runner.waitUntilStarted();
    await transport.deliver({
      kind: "cancel",
      commandId: "cancel-e1",
      executionId: "e1",
    });

    assert.equal(store.getExecution("e1")?.state, "cancelled");
    assert.deepEqual(runner.cancelled, ["e1"]);

    runner.resolveStart();
    await eventually(() => {
      assert.equal(store.getExecution("e1")?.state, "cancelled");
    });

    assert.equal(store.getExecution("e1")?.state, "cancelled");
    assert.deepEqual(runner.cancelled, ["e1"]);
  });

  it("keeps unacknowledged events after a push failure and acknowledges only returned watermarks", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();
    await transport.deliver(agentRun("e1"));
    await transport.deliver(agentRun("e2"));

    transport.pushFailure = new Error("offline");
    await assert.rejects(() => supervisor.flush(), /offline/);
    assert.deepEqual(
      store.listUnackedEvents("e1").map((event) => event.eventSeq),
      [1, 2],
    );
    assert.deepEqual(
      store.listUnackedEvents("e2").map((event) => event.eventSeq),
      [1, 2],
    );

    transport.pushFailure = null;
    transport.acknowledgements = { e1: 1, e2: 2 };
    await supervisor.flush();

    assert.deepEqual(
      store.listUnackedEvents("e1").map((event) => event.eventSeq),
      [2],
    );
    assert.deepEqual(store.listUnackedEvents("e2"), []);
  });

  it("shuts down active platform and capability children before closing transport", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const capabilities = new AbortAwareCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();
    await transport.deliver(agentRun("shutdown-run"));
    await transport.deliver(capabilityInvoke("shutdown-capability"));
    await capabilities.waitUntilStarted();

    await supervisor.shutdown();
    await capabilities.waitUntilFinished();

    assert.deepEqual(runner.cancelled, ["shutdown-run"]);
    assert.equal(capabilities.aborted, true);
    assert.equal(store.getExecution("shutdown-run")?.state, "cancelled");
    assert.equal(store.getExecution("shutdown-capability")?.state, "cancelled");
    assert.equal(transport.closed, true);
  });

  it("waits for runner and capability consumption to finish before closing transport", async () => {
    const transport = new FakeTransport();
    const runner = new DeferredShutdownRunner();
    const capabilities = new DeferredShutdownCapabilityHost();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
      capabilityHost: capabilities,
      capabilityPolicy: {
        clientEnabled: true,
        autoPermissions: ["network"],
        allowedGitOrigins: ["github.com"],
        deniedPluginIds: [],
        allowedWorkspaceRoots: ["/workspace"],
      },
      capabilityContext: () => ({ workspace: "/workspace/demo" }),
    });
    await supervisor.start();
    await transport.deliver(agentRun("shutdown-wait-run"));
    await transport.deliver(capabilityInvoke("shutdown-wait-capability"));
    await Promise.all([
      runner.waitUntilStarted(),
      capabilities.waitUntilStarted(),
    ]);

    const closing = supervisor.shutdown();
    await Promise.all([
      runner.waitUntilCancelled(),
      capabilities.waitUntilAborted(),
    ]);
    assert.equal(transport.closed, false);

    runner.finishCleanup();
    capabilities.finishCleanup();
    await closing;
    assert.equal(transport.closed, true);
  });

  it("rejects auto runs over configured capacity and releases capacity after terminal or cancellation", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
      maxConcurrentRuns: 1,
    });
    await supervisor.start();

    await transport.deliver(agentRun("capacity-first"));
    await transport.deliver(agentRun("capacity-rejected"));

    assert.equal(store.getExecution("capacity-first")?.state, "running");
    assert.equal(store.getExecution("capacity-rejected")?.state, "rejected");
    assert.deepEqual(
      store.listUnackedEvents("capacity-rejected").at(-1)?.payload,
      { reason: "local_capacity_exhausted" },
    );

    runner.emit("capacity-first", { type: "done" });
    await eventually(() => {
      assert.equal(store.getExecution("capacity-first")?.state, "done");
    });
    await transport.deliver(agentRun("capacity-after-done"));
    assert.equal(store.getExecution("capacity-after-done")?.state, "running");
    await transport.deliver({
      kind: "cancel",
      commandId: "cancel-capacity-after-done",
      executionId: "capacity-after-done",
    });
    assert.equal(store.getExecution("capacity-after-done")?.state, "cancelled");
    await transport.deliver(agentRun("capacity-after-cancel"));
    assert.equal(store.getExecution("capacity-after-cancel")?.state, "running");
  });

  it("enforces capacity when approving a persisted run and frees recovered work after restart", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "approval",
      maxConcurrentRuns: 1,
    });
    await supervisor.start();
    await transport.deliver(agentRun("approval-first"));
    await transport.deliver(agentRun("approval-full"));
    await supervisor.approve("approval-first");
    await supervisor.approve("approval-full");

    assert.equal(store.getExecution("approval-first")?.state, "running");
    assert.equal(store.getExecution("approval-full")?.state, "rejected");
    assert.deepEqual(store.listUnackedEvents("approval-full").at(-1)?.payload, {
      reason: "local_capacity_exhausted",
    });

    store.markRecoveryRequired("approval-first");
    await transport.deliver(agentRun("after-recovery"));
    assert.equal(
      store.getExecution("after-recovery")?.state,
      "awaiting_approval",
    );
    await supervisor.approve("after-recovery");
    assert.equal(store.getExecution("after-recovery")?.state, "running");
  });

  it("refreshPlugins re-reports installed plugins without a plugin.sync push", async () => {
    const transport = new FakeTransport();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner: new StreamingRunner(store),
      policy: () => "auto",
      plugins: new FakePluginManager(),
    });
    store.recordPluginSyncSuccess("plugins-v1");
    await supervisor.refreshPlugins();

    assert.equal(transport.pluginAcknowledgements.length, 1);
    assert.deepEqual(transport.pluginAcknowledgements[0], {
      type: "plugin.sync.ack",
      revision: "plugins-v1",
      status: "already_applied",
      plugins: [{ id: "demo", resolvedCommit: "a".repeat(40) }],
    });

    const noRevision = new FakeTransport();
    const fresh = new ClientSupervisor({
      store: new ClientStateStore(path.join(dir, "state-2.db")),
      transport: noRevision,
      runner: new StreamingRunner(store),
      plugins: new FakePluginManager(),
    });
    await fresh.refreshPlugins();
    assert.equal(noRevision.pluginAcknowledgements[0]?.status, "applied");
    assert.match(
      noRevision.pluginAcknowledgements[0]?.revision ?? "",
      /^local-/,
    );
  });

  it("refreshPlugins fails loudly when the plugin manager is absent", async () => {
    const supervisor = new ClientSupervisor({
      store,
      transport: new FakeTransport(),
      runner: new StreamingRunner(store),
    });
    await assert.rejects(() => supervisor.refreshPlugins(), /unavailable/);
  });

  it("resolves a hub-requested project name to its local directory", async () => {
    const transport = new FakeTransport();
    const runner = new StreamingRunner(store);
    const started: PlatformRunInput[] = [];
    const original = runner.start.bind(runner);
    runner.start = (executionId: string, input: PlatformRunInput) => {
      started.push(input);
      return original(executionId, input);
    };
    // Registry is read at resolve time: project add lands without a restart.
    const projects = new Map<string, string>([["web", "/work/web"]]);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
      projectResolver: {
        list: () =>
          [...projects.entries()].map(([name, path]) => ({
            name,
            path,
            dir: "000000",
          })),
        resolve: (name) => {
          const path = projects.get(name ?? "");
          return path ? { path, recordDir: `/records/${name}` } : undefined;
        },
      },
    });
    await supervisor.start();

    await transport.deliver({
      ...agentRun("project-run"),
      payload: { prompt: "hello", project: "web" },
    });
    await eventually(() => {
      assert.equal(store.getExecution("project-run")?.state, "running");
    });
    assert.equal(started[0]?.cwd, "/work/web");
    assert.equal(started[0]?.context?.resolvedProjectPath, "/work/web");

    await transport.deliver({
      ...agentRun("unknown-project-run"),
      payload: { prompt: "hello", project: "missing" },
    });
    await eventually(() => {
      assert.equal(store.getExecution("unknown-project-run")?.state, "running");
    });
    assert.equal(started[1]?.cwd, undefined);
  });

  it("delivers terminal events immediately after a run completes", async () => {
    const transport = new FakeTransport();
    transport.acknowledgements = { e1: 3 };
    const runner = new StreamingRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
    });
    await supervisor.start();

    await transport.deliver(agentRun());
    runner.emit("e1", { type: "done", payload: { sessionId: "s1" } });
    await eventually(() => {
      assert.equal(transport.pushed.length >= 1, true);
    });
    await eventually(() => {
      assert.equal(store.listUnackedEvents("e1").length, 0);
    });
    // The single post-terminal push carried the whole durable sequence.
    assert.deepEqual(
      transport.pushed.at(-1)?.map((event) => event.type),
      ["received", "running", "done"],
    );
  });

  it("answers an inventoryQuery plugin.sync with ack + report and no side effects", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const recordedRevisions: string[] = [];
    const originalRecord = store.recordPluginSyncSuccess.bind(store);
    store.recordPluginSyncSuccess = (revision: string) => {
      recordedRevisions.push(revision);
      originalRecord(revision);
    };
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
      inventoryProvider: async () => inventoryReport(),
    });
    await supervisor.start();

    await transport.deliverPluginSync({
      revision: "q1",
      plugins: [],
      inventoryQuery: true,
    });

    assert.equal(transport.inventoryReports.length, 1);
    assert.equal(transport.inventoryReports[0]?.type, "inventory.report");
    assert.equal(
      transport.pluginAcknowledgements.at(-1)?.status,
      "already_applied",
    );
    assert.equal(transport.pluginAcknowledgements.at(-1)?.revision, "q1");
    assert.equal(transport.pluginAcknowledgements.at(-1)?.plugins.length, 1);
    assert.deepEqual(recordedRevisions, []);
    assert.equal(store.getLastPluginSyncRevision(), null);
  });

  it("reports inventory after a real plugin sync completes", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
      inventoryProvider: async () => inventoryReport(),
    });
    await supervisor.start();
    assert.equal(transport.inventoryReports.length, 0);

    await transport.deliverPluginSync({
      revision: "plugins-v1",
      plugins: [
        {
          id: "demo",
          gitUrl: "https://github.com/allin-ai/demo.git",
          enabled: true,
        },
      ],
    });

    await eventually(() => {
      assert.equal(transport.inventoryReports.length, 1);
    });
    assert.equal(transport.inventoryReports[0]?.type, "inventory.report");
  });

  it("reports inventory once on connect", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      policy: () => "auto",
      inventoryProvider: async () => inventoryReport(),
    });
    await supervisor.start();
    assert.equal(transport.inventoryReports.length, 0);

    await transport.reconnect();

    await eventually(() => {
      assert.equal(transport.inventoryReports.length, 1);
    });
  });

  it("degrades to an empty-platform report when inventoryProvider throws", async () => {
    store.savePluginState({
      plugin: {
        id: "demo",
        gitUrl: "https://example.test/demo.git",
        enabled: true,
        resolvedCommit: "a".repeat(40),
        installedAt: "2026-09-19T00:00:00.000Z",
        status: "active",
      },
      active: null,
    });
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
      inventoryProvider: async () => {
        throw new Error("probe failure");
      },
    });
    await supervisor.start();

    await transport.deliverPluginSync({
      revision: "q2",
      plugins: [],
      inventoryQuery: true,
    });

    assert.equal(transport.inventoryReports.length, 1);
    assert.deepEqual(transport.inventoryReports[0], {
      type: "inventory.report",
      reportedAt: transport.inventoryReports[0]?.reportedAt,
      platforms: [],
      plugins: [
        {
          id: "demo",
          gitUrl: "https://example.test/demo.git",
          enabled: true,
          status: "active",
          resolvedCommit: "a".repeat(40),
          installedAt: "2026-09-19T00:00:00.000Z",
        },
      ],
      projects: [],
    });
    assert.notEqual(transport.inventoryReports[0]?.reportedAt, "");
  });

  it("throttles proactive inventory reports within 5s", async () => {
    const transport = new FakeTransport();
    const runner = new FakeRunner(store);
    const plugins = new FakePluginManager();
    const supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      plugins,
      policy: () => "auto",
      inventoryProvider: async () => inventoryReport(),
    });
    await supervisor.start();

    // Connect reports proactively.
    await transport.reconnect();
    await eventually(() => {
      assert.equal(transport.inventoryReports.length, 1);
    });

    // A real sync right after the connect report is throttled.
    await transport.deliverPluginSync({
      revision: "plugins-v1",
      plugins: [
        {
          id: "demo",
          gitUrl: "https://github.com/allin-ai/demo.git",
          enabled: true,
        },
      ],
    });
    await eventually(() => {
      assert.equal(transport.pluginAcknowledgements.length, 1);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transport.inventoryReports.length, 1);

    // An inventoryQuery downlink is never throttled.
    await transport.deliverPluginSync({
      revision: "q3",
      plugins: [],
      inventoryQuery: true,
    });
    assert.equal(transport.inventoryReports.length, 2);
  });
});

describe("mergeDesiredPlugins", () => {
  const hubPlugin = {
    id: "hub",
    gitUrl: "https://hub.example.test/hub.git",
    enabled: true,
  };
  const localSkill = {
    id: "local-skills",
    gitUrl: "https://git.example.test/skills.git",
    enabled: true,
  };
  const systemPlugin = {
    id: "agentkit-system",
    gitUrl: "local://agentkit-system",
    enabled: true,
  };

  it("keeps hub entries first and lets them override local entries by id", () => {
    const localOverride = { ...hubPlugin, ref: "refs/heads/local-experiment" };
    const merged = mergeDesiredPlugins([localOverride, localSkill], [hubPlugin]);
    assert.deepEqual(merged, [hubPlugin, localSkill]);
  });

  it("keeps local-only entries so offline machines retain their skills", () => {
    assert.deepEqual(mergeDesiredPlugins([localSkill], []), [localSkill]);
    assert.deepEqual(mergeDesiredPlugins([], [hubPlugin]), [hubPlugin]);
    assert.deepEqual(mergeDesiredPlugins([], []), []);
  });

  it("does not treat the built-in system plugin as hub-overridable boilerplate", () => {
    const hubSystem = { ...systemPlugin, gitUrl: "local://hijack-attempt" };
    const merged = mergeDesiredPlugins([systemPlugin], [hubSystem]);
    assert.deepEqual(merged, [hubSystem]);
    assert.equal(merged.length, 1);
  });
});
