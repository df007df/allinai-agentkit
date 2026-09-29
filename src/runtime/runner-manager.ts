import { isTerminalPlatformEvent, platformErrorEvent } from "./events.js";
import type {
  PlatformEvent,
  PlatformId,
  PlatformRunInput,
  RunnerManager,
} from "./types.js";

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Absolute ceiling for one execution regardless of event flow. Generous on
 * purpose: long but healthy agent turns keep resetting the stall timer.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Slow-failure watchdog: a healthy run emits its first event (at least
 * `init`) within seconds. Waiting far longer than that means the platform
 * CLI is stuck on network/auth/startup.
 */
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;

type TimerHandle = unknown;

export type RunnerManagerOptions = {
  /** Platform adapters; one execution resolves its adapter by input.platform. */
  adapters?: PlatformAdapterLookup;
  /**
   * http(s) proxy endpoint forwarded to platform CLI children as
   * HTTPS_PROXY/HTTP_PROXY (plus NO_PROXY=localhost,127.0.0.1 so hub traffic
   * stays direct). Consumed via `platformChildEnv` when constructing the
   * adapter registry; absent means inherit the daemon env as-is.
   */
  proxyUrl?: string;
  /** How long the event flow may stay silent before the run fails. Reset by every event. */
  stallTimeoutMs?: number;
  /** Absolute wall-clock ceiling for one execution, regardless of event flow. */
  totalTimeoutMs?: number;
  /**
   * Armed at start and disarmed by the first event. Firing produces a
   * `runner_timeout` failure carrying the phase marker.
   */
  firstEventTimeoutMs?: number;
  /** Test seam for deterministic timeout coverage. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearScheduledTimeout?: (timer: TimerHandle) => void;
};

/** Minimal registry surface the manager needs; the full registry satisfies it. */
export type PlatformAdapterLookup = {
  get(id: PlatformId): {
    id: PlatformId;
    start(
      input: PlatformRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent>;
  };
};

class PlatformEventQueue implements AsyncIterable<PlatformEvent> {
  private readonly values: PlatformEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<PlatformEvent>) => void
  > = [];
  private closed = false;

  push(value: PlatformEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PlatformEvent> {
    while (true) {
      const next = await this.next();
      if (next.done) return;
      yield next.value;
    }
  }

  private next(): Promise<IteratorResult<PlatformEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

type ActiveRun = {
  executionId: string;
  events: PlatformEventQueue;
  abort: AbortController;
  totalTimeout: TimerHandle;
  stallTimeout: TimerHandle;
  firstEventTimeout: TimerHandle;
  firstEventSeen: boolean;
  outputClosed: boolean;
  /** Set when a terminal event or failure already settled the stream. */
  streamSettled: boolean;
  /** Set by cancel(); an AbortError surfacing afterwards is a normal finish. */
  cancelled: boolean;
};

function defaultScheduleTimeout(
  callback: () => void,
  delayMs: number,
): TimerHandle {
  return setTimeout(callback, delayMs);
}

function defaultClearScheduledTimeout(timer: TimerHandle): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function unrefTimer(timer: TimerHandle): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositiveTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** Environment each platform CLI child inherits, proxy merged when set. */
export function platformChildEnv(proxyUrl?: string): NodeJS.ProcessEnv {
  if (proxyUrl === undefined) return process.env;
  return {
    ...process.env,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1",
  };
}

/**
 * Runs platform adapters in the daemon process: one execution resolves its
 * adapter by `input.platform` and drains the adapter's event stream through
 * the four-watchdog timeout model. Tool approvals ride the plugin-delivered
 * hooks and the HTTP bridge; this manager never sees in-band approval
 * traffic, so `respondToolApproval`/`ownerOfToolApproval` remain as
 * compatibility no-ops for the bridge wiring.
 */
export class InProcessRunnerManager implements RunnerManager {
  private readonly adapters: PlatformAdapterLookup;
  private readonly stallTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly firstEventTimeoutMs: number;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearScheduledTimeout: (timer: TimerHandle) => void;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: RunnerManagerOptions = {}) {
    this.adapters = options.adapters ?? unconfiguredAdapters();
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.firstEventTimeoutMs =
      options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
    validatePositiveTimeout(this.stallTimeoutMs, "stallTimeoutMs");
    validatePositiveTimeout(this.totalTimeoutMs, "totalTimeoutMs");
    validatePositiveTimeout(this.firstEventTimeoutMs, "firstEventTimeoutMs");
    this.scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.clearScheduledTimeout =
      options.clearScheduledTimeout ?? defaultClearScheduledTimeout;
  }

  start(
    executionId: string,
    input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    const existing = this.activeRuns.get(executionId);
    if (existing) return existing.events;

    const events = new PlatformEventQueue();
    const active: ActiveRun = {
      executionId,
      events,
      abort: new AbortController(),
      totalTimeout: {} as TimerHandle,
      stallTimeout: {} as TimerHandle,
      firstEventTimeout: {} as TimerHandle,
      firstEventSeen: false,
      outputClosed: false,
      streamSettled: false,
      cancelled: false,
    };

    let adapter: ReturnType<PlatformAdapterLookup["get"]>;
    try {
      adapter = this.adapters.get(input.platform);
    } catch (error) {
      events.push(
        platformErrorEvent("platform_adapter_unavailable", errorMessage(error)),
      );
      events.close();
      return events;
    }

    active.totalTimeout = this.scheduleTimeout(() => {
      if (active.streamSettled || active.outputClosed) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner exceeded the ${this.totalTimeoutMs}ms total limit`,
        { phase: "total" },
      );
    }, this.totalTimeoutMs);
    unrefTimer(active.totalTimeout);

    active.stallTimeout = this.scheduleTimeout(() => {
      if (active.streamSettled || active.outputClosed) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.stallTimeoutMs}ms`,
        { phase: "stall" },
      );
    }, this.stallTimeoutMs);
    unrefTimer(active.stallTimeout);

    active.firstEventTimeout = this.scheduleTimeout(() => {
      if (active.streamSettled || active.outputClosed || active.firstEventSeen)
        return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.firstEventTimeoutMs}ms`,
        { phase: "first_event" },
      );
    }, this.firstEventTimeoutMs);
    unrefTimer(active.firstEventTimeout);

    this.activeRuns.set(executionId, active);
    void this.drain(active, adapter, input);
    return events;
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.activeRuns.get(executionId);
    if (!active || active.streamSettled) return;
    active.cancelled = true;
    // The adapter surfaces the abort as a terminal event, a thrown
    // AbortError, or a plain stream end; drain() treats all three as a
    // graceful finish. An adapter that ignores the signal still hits the
    // total timeout.
    active.abort.abort();
  }

  respondToolApproval(
    _executionId: string,
    _requestId: string,
    _decision: "allow" | "deny",
    _reason?: string,
  ): void {
    // Hook-based approvals resolve at the HTTP bridge; nothing in this
    // manager parks on in-band approval requests anymore.
  }

  ownerOfToolApproval(_requestId: string): string | null {
    return null;
  }

  /** Retained until the adapter stream settles, mirroring child tracking. */
  async waitForIdle(): Promise<void> {
    if (this.activeRuns.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /** Adapter failures are isolated; a later execution can always be started. */
  isHealthy(): boolean {
    return true;
  }

  hasActiveExecution(executionId: string): boolean {
    return this.activeRuns.has(executionId);
  }

  private async drain(
    active: ActiveRun,
    adapter: ReturnType<PlatformAdapterLookup["get"]>,
    input: PlatformRunInput,
  ): Promise<void> {
    try {
      for await (const event of adapter.start(input, active.abort.signal)) {
        this.handleEvent(active, event);
        if (active.outputClosed) return;
      }
      if (!active.outputClosed && !active.cancelled) {
        this.reportFailure(
          active,
          "runner_stream_ended",
          "Adapter stream ended before a terminal event",
        );
      }
    } catch (error) {
      if (!active.outputClosed && !active.cancelled && !isAbortError(error)) {
        this.reportFailure(
          active,
          "platform_adapter_failed",
          errorMessage(error),
        );
      }
    } finally {
      this.finish(active);
    }
  }

  private handleEvent(active: ActiveRun, event: PlatformEvent): void {
    if (active.outputClosed || active.streamSettled) return;
    if (!active.firstEventSeen) {
      active.firstEventSeen = true;
      this.clearScheduledTimeout(active.firstEventTimeout);
    }
    // Every arriving event proves the run is alive: restart the stall clock.
    this.clearScheduledTimeout(active.stallTimeout);
    active.stallTimeout = this.scheduleTimeout(() => {
      if (active.streamSettled || active.outputClosed) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.stallTimeoutMs}ms`,
        { phase: "stall" },
      );
    }, this.stallTimeoutMs);
    unrefTimer(active.stallTimeout);

    active.events.push(event);
    if (!isTerminalPlatformEvent(event)) return;
    active.streamSettled = true;
    // Settle synchronously so consumers finishing their collect() observe
    // hasActiveExecution=false without an extra tick; drain()'s finally
    // remains as the idempotent path for stream ends without a terminal.
    this.finish(active);
  }

  private reportFailure(
    active: ActiveRun,
    reason: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (active.outputClosed) return;
    active.streamSettled = true;
    this.clearAllTimers(active);
    active.events.push(platformErrorEvent(reason, message, details));
    active.events.close();
    active.abort.abort();
  }

  private clearAllTimers(active: ActiveRun): void {
    this.clearScheduledTimeout(active.totalTimeout);
    this.clearScheduledTimeout(active.stallTimeout);
    this.clearScheduledTimeout(active.firstEventTimeout);
  }

  private finish(active: ActiveRun): void {
    this.clearAllTimers(active);
    active.events.close();
    this.activeRuns.delete(active.executionId);
    if (this.activeRuns.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
}

function unconfiguredAdapters(): PlatformAdapterLookup {
  return {
    get(id) {
      throw new Error(
        `No platform adapter registry configured; cannot run ${id}. Pass RunnerManagerOptions.adapters.`,
      );
    },
  };
}

export function createRunnerManager(
  options?: RunnerManagerOptions,
): InProcessRunnerManager {
  return new InProcessRunnerManager(options);
}
