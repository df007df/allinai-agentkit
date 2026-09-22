import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTerminalPlatformEvent, platformErrorEvent } from "./events.js";
import {
  encodeApprovalResponse,
  encodeRunnerStart,
  JsonlDecoder,
  parseApprovalRequest,
  parseRunnerChildMessage,
} from "./runner-wire.js";
import type {
  PlatformEvent,
  PlatformRunInput,
  RunnerManager,
} from "./types.js";

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Absolute ceiling for one execution regardless of event flow. Generous on
 * purpose: long but healthy agent turns keep resetting the stall timer.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
/**
 * Slow-failure watchdog: a healthy run emits its first JSONL event (at least
 * `init`) within seconds. Waiting far longer than that means the vendor
 * process is stuck on network/auth/startup, and its stderr usually says why.
 */
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
/** How much of the child's stderr is retained for failure diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024;

export const DEFAULT_RUNNER_CHILD_ENTRYPOINT = fileURLToPath(
  new URL("./runner-child.js", import.meta.url),
);

export type RunnerChildProcess = {
  pid?: number;
  stdin: {
    write(chunk: string): boolean;
    end?(): void;
  } | null;
  stdout: {
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  /** Optional so in-process test doubles without a stderr pipe still fit. */
  stderr: {
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type RunnerSpawnOptions = {
  cwd: undefined;
  env: undefined;
  shell: false;
  detached: boolean;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
};

export type RunnerSpawn = (
  command: string,
  args: string[],
  options: RunnerSpawnOptions,
) => RunnerChildProcess;

type TimerHandle = unknown;

export type RunnerManagerOptions = {
  /** Dependency injection keeps lifecycle tests independent from real child processes. */
  spawn?: RunnerSpawn;
  /** A local package-controlled path. Hub payloads never influence this value. */
  childEntrypoint?: string;
  /** How long the event flow may stay silent before the run fails. Reset by every event. */
  stallTimeoutMs?: number;
  /** Absolute wall-clock ceiling for one execution, regardless of event flow. */
  totalTimeoutMs?: number;
  /**
   * Armed at spawn and disarmed by the first JSONL event. Firing produces a
   * `runner_timeout` failure carrying the captured stderr tail.
   */
  firstEventTimeoutMs?: number;
  /** Delay after SIGTERM before an unclosed child/process group receives SIGKILL. */
  terminationGraceMs?: number;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for deterministic timeout and escalation coverage. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearScheduledTimeout?: (timer: TimerHandle) => void;
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
  child: RunnerChildProcess;
  events: PlatformEventQueue;
  totalTimeout: TimerHandle;
  stallTimeout: TimerHandle;
  firstEventTimeout: TimerHandle;
  firstEventSeen: boolean;
  stderrTail: string;
  terminationTimeout: TimerHandle | null;
  cancelled: boolean;
  outputClosed: boolean;
  closeReceived: boolean;
  terminationRequested: boolean;
  /** Tool approvals awaiting a human decision; each freezes the stall clock. */
  pendingApprovals: Set<string>;
};

const STDERR_TAIL_KEEP_BYTES = STDERR_TAIL_BYTES / 2;

function appendStderrTail(active: ActiveRun, chunk: string): void {
  const merged = active.stderrTail + chunk;
  active.stderrTail =
    merged.length > STDERR_TAIL_KEEP_BYTES
      ? merged.slice(merged.length - STDERR_TAIL_KEEP_BYTES)
      : merged;
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositiveTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * Starts exactly one fixed-entrypoint child per execution and transports only
 * JSONL. It is deliberately vendor-agnostic: platform SDK work belongs to the
 * child adapter layer, so an SDK failure cannot poison this manager.
 */
export class IsolatedRunnerManager implements RunnerManager {
  private readonly spawn: RunnerSpawn;
  private readonly childEntrypoint: string;
  private readonly stallTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly firstEventTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearScheduledTimeout: (timer: TimerHandle) => void;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: RunnerManagerOptions = {}) {
    this.spawn = options.spawn ?? (nodeSpawn as unknown as RunnerSpawn);
    this.childEntrypoint =
      options.childEntrypoint ?? DEFAULT_RUNNER_CHILD_ENTRYPOINT;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.firstEventTimeoutMs =
      options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    validatePositiveTimeout(this.stallTimeoutMs, "stallTimeoutMs");
    validatePositiveTimeout(this.totalTimeoutMs, "totalTimeoutMs");
    validatePositiveTimeout(this.firstEventTimeoutMs, "firstEventTimeoutMs");
    validatePositiveTimeout(this.terminationGraceMs, "terminationGraceMs");
    this.killProcessGroup = options.killProcessGroup ?? defaultKillProcessGroup;
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
    let child: RunnerChildProcess;
    try {
      child = this.spawn(process.execPath, [this.childEntrypoint], {
        cwd: undefined,
        env: undefined,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      events.push(
        platformErrorEvent("runner_spawn_failed", errorMessage(error)),
      );
      events.close();
      return events;
    }

    const active: ActiveRun = {
      executionId,
      child,
      events,
      totalTimeout: {} as TimerHandle,
      stallTimeout: {} as TimerHandle,
      firstEventTimeout: {} as TimerHandle,
      firstEventSeen: false,
      stderrTail: "",
      terminationTimeout: null,
      cancelled: false,
      outputClosed: false,
      closeReceived: false,
      terminationRequested: false,
      pendingApprovals: new Set(),
    };
    active.totalTimeout = this.scheduleTimeout(() => {
      if (active.closeReceived) return;
      if (!active.outputClosed) {
        this.reportFailure(
          active,
          "runner_timeout",
          `Runner exceeded the ${this.totalTimeoutMs}ms total limit`,
          { phase: "total" },
        );
        return;
      }
      // A terminal runner event is not enough if the child never exits. It is
      // still tracked and eventually cleaned up without emitting a second event.
      this.requestTermination(active);
    }, this.totalTimeoutMs);
    unrefTimer(active.totalTimeout);

    active.stallTimeout = this.scheduleTimeout(() => {
      if (active.closeReceived || active.outputClosed) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.stallTimeoutMs}ms`,
        { phase: "stall" },
      );
    }, this.stallTimeoutMs);
    unrefTimer(active.stallTimeout);

    active.firstEventTimeout = this.scheduleTimeout(() => {
      if (active.closeReceived || active.firstEventSeen) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.firstEventTimeoutMs}ms`,
        { phase: "first_event" },
      );
    }, this.firstEventTimeoutMs);
    unrefTimer(active.firstEventTimeout);

    this.activeRuns.set(executionId, active);
    this.bindChild(active);
    if (active.outputClosed) return events;

    try {
      if (!child.stdin) throw new Error("Runner child stdin is unavailable");
      child.stdin.write(encodeRunnerStart(executionId, input));
      // stdin stays open: the parent may need to send tool approval
      // decisions while the run is in flight.
    } catch (error) {
      this.reportFailure(active, "runner_input_failed", errorMessage(error));
    }

    return events;
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.activeRuns.get(executionId);
    if (!active || active.closeReceived) return;
    active.cancelled = true;
    this.denyPendingApprovals(active, "Execution cancelled");
    this.requestTermination(active);
  }

  respondToolApproval(
    executionId: string,
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
  ): void {
    const active = this.activeRuns.get(executionId);
    if (!active || active.closeReceived) return;
    if (!active.pendingApprovals.delete(requestId)) return;
    // A decision unblocks tool execution, so the stall clock resumes now.
    this.clearScheduledTimeout(active.stallTimeout);
    active.stallTimeout = this.scheduleTimeout(() => {
      if (active.closeReceived || active.outputClosed) return;
      if (active.pendingApprovals.size > 0) return;
      this.reportFailure(
        active,
        "runner_timeout",
        `Runner received no events within ${this.stallTimeoutMs}ms`,
        { phase: "stall" },
      );
    }, this.stallTimeoutMs);
    unrefTimer(active.stallTimeout);
    try {
      if (!active.child.stdin) throw new Error("Runner child stdin is unavailable");
      active.child.stdin.write(
        encodeApprovalResponse({
          type: "tool_approval.response",
          requestId,
          decision,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    } catch (error) {
      this.reportFailure(active, "runner_input_failed", errorMessage(error));
    }
  }

  private denyPendingApprovals(active: ActiveRun, reason: string): void {
    for (const requestId of active.pendingApprovals) {
      try {
        active.child.stdin?.write(
          encodeApprovalResponse({
            type: "tool_approval.response",
            requestId,
            decision: "deny",
            reason,
          }),
        );
      } catch {
        // The child is being torn down anyway.
      }
    }
    active.pendingApprovals.clear();
  }

  /**
   * Resolves which execution owns a pending approval request id, for out-of
   * -process callers (e.g. the Codex hooks HTTP bridge) that only know the id.
   * Returns null when no active run holds it.
   */
  ownerOfToolApproval(requestId: string): string | null {
    for (const [executionId, active] of this.activeRuns) {
      if (active.pendingApprovals.has(requestId)) return executionId;
    }
    return null;
  }

  /**
   * A terminal SDK event can arrive before the child has actually exited.
   * Daemon shutdown uses this to wait for those remaining child resources.
   */
  async waitForIdle(): Promise<void> {
    if (this.activeRuns.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  /** Child failures are isolated; a later execution can always be started. */
  isHealthy(): boolean {
    return true;
  }

  /** Retained until the child emits `close`, including after a terminal error. */
  hasActiveExecution(executionId: string): boolean {
    return this.activeRuns.has(executionId);
  }

  private bindChild(active: ActiveRun): void {
    const decoder = new JsonlDecoder();
    active.child.on("error", (error) => {
      this.reportFailure(active, "runner_process_failed", errorMessage(error));
    });
    active.child.on("close", (code, signal) => {
      if (active.closeReceived) return;
      active.closeReceived = true;
      for (const line of decoder.finish()) this.handleOutputLine(active, line);
      if (!active.outputClosed && !active.cancelled) {
        this.reportFailure(
          active,
          "runner_child_exit",
          `Runner child exited before a terminal event (code=${String(code)}, signal=${String(signal)})`,
        );
      }
      this.cleanup(active);
    });
    if (active.child.stderr) {
      active.child.stderr.on("data", (chunk) => {
        appendStderrTail(
          active,
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
        );
      });
      active.child.stderr.on("error", () => {
        // Stderr is best-effort diagnostics; read failures must never turn
        // into runner failures on their own.
      });
    }
    if (!active.child.stdout) {
      this.reportFailure(
        active,
        "runner_stdout_unavailable",
        "Runner child stdout is unavailable",
      );
      return;
    }

    active.child.stdout.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        this.handleOutputLine(active, line);
      }
    });
    active.child.stdout.on("error", (error) => {
      this.reportFailure(active, "runner_stdout_failed", errorMessage(error));
    });
  }

  private handleOutputLine(active: ActiveRun, line: string): void {
    if (active.outputClosed || line.length === 0) return;
    if (!active.firstEventSeen) {
      active.firstEventSeen = true;
      this.clearScheduledTimeout(active.firstEventTimeout);
    }
    // Every arriving event proves the run is alive: restart the stall clock.
    // A pending tool approval also holds the clock: the wait is expected to
    // be as long as the human takes, not a silent platform failure.
    this.clearScheduledTimeout(active.stallTimeout);
    if (active.pendingApprovals.size === 0) {
      active.stallTimeout = this.scheduleTimeout(() => {
        if (active.closeReceived || active.outputClosed) return;
        if (active.pendingApprovals.size > 0) return;
        this.reportFailure(
          active,
          "runner_timeout",
          `Runner received no events within ${this.stallTimeoutMs}ms`,
          { phase: "stall" },
        );
      }, this.stallTimeoutMs);
      unrefTimer(active.stallTimeout);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.reportFailure(
        active,
        "runner_protocol_error",
        "Runner child emitted invalid JSONL",
      );
      return;
    }
    const approval = parseApprovalRequest(parsed);
    if (approval) {
      active.pendingApprovals.add(approval.requestId);
      active.events.push({
        type: "tool",
        payload: {
          toolApproval: {
            requestId: approval.requestId,
            toolName: approval.toolName,
            toolInput: approval.toolInput,
          },
        },
      });
      return;
    }
    const message = parseRunnerChildMessage(parsed);
    if (!message) {
      this.reportFailure(
        active,
        "runner_protocol_error",
        "Runner child emitted an invalid event",
      );
      return;
    }
    active.events.push(message.event);
    if (!isTerminalPlatformEvent(message.event)) return;
    this.closeOutput(active);
    if (message.event.type === "error") this.requestTermination(active);
  }

  private reportFailure(
    active: ActiveRun,
    reason: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (active.outputClosed) return;
    this.clearScheduledTimeout(active.firstEventTimeout);
    active.events.push(
      platformErrorEvent(reason, message, {
        ...details,
        ...(active.stderrTail.length > 0
          ? { stderrTail: active.stderrTail }
          : {}),
      }),
    );
    this.closeOutput(active);
    this.requestTermination(active);
  }

  private closeOutput(active: ActiveRun): void {
    if (active.outputClosed) return;
    active.outputClosed = true;
    active.events.close();
  }

  private requestTermination(active: ActiveRun): void {
    if (active.closeReceived || active.terminationRequested) return;
    active.terminationRequested = true;
    this.terminate(active, "SIGTERM");
    active.terminationTimeout = this.scheduleTimeout(() => {
      if (active.closeReceived) return;
      this.terminate(active, "SIGKILL");
    }, this.terminationGraceMs);
    unrefTimer(active.terminationTimeout);
  }

  private cleanup(active: ActiveRun): void {
    this.clearScheduledTimeout(active.totalTimeout);
    this.clearScheduledTimeout(active.stallTimeout);
    this.clearScheduledTimeout(active.firstEventTimeout);
    if (active.terminationTimeout) {
      this.clearScheduledTimeout(active.terminationTimeout);
      active.terminationTimeout = null;
    }
    this.closeOutput(active);
    this.activeRuns.delete(active.executionId);
    if (this.activeRuns.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private terminate(active: ActiveRun, signal: NodeJS.Signals): void {
    try {
      if (
        process.platform !== "win32" &&
        active.child.pid &&
        active.child.pid > 0
      ) {
        this.killProcessGroup(active.child.pid, signal);
        return;
      }
      active.child.kill(signal);
    } catch {
      // The child may already be gone. Its close handler owns cleanup; never
      // let process cleanup affect manager health.
    }
  }
}

export function createRunnerManager(
  options?: RunnerManagerOptions,
): IsolatedRunnerManager {
  return new IsolatedRunnerManager(options);
}
