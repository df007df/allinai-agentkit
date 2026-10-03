import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  parseCapabilityEventLine,
  type CapabilityEvent,
} from "./shell-wire.js";
import { MAX_CAPABILITY_TIMEOUT_SECONDS } from "./manifest.js";
import type { ShellCapability } from "./types.js";

export type CapabilitySpawn = (
  entry: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ShellCapabilityHostOptions = {
  /** The immutable active revision selected by the local plugin manager. */
  pluginRoot: string;
  spawn?: CapabilitySpawn;
  /** Explicit local values only; process.env is never inherited. */
  environment?: Readonly<Record<string, string>>;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
};

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
const SAFE_ENVIRONMENT_KEY = /^(PATH|LANG|LC_[A-Z_]+|TZ)$/;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function terminalError(reason: string): CapabilityEvent {
  return { type: "error", payload: { reason } };
}

function safeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (SAFE_ENVIRONMENT_KEY.test(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) next({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const next of this.waiting.splice(0))
      next({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

type Entrypoint = { root: string; entry: string };

/**
 * The only process boundary available to a direct Shell Capability. The Hub
 * supplies data, never a command: the installed manifest determines the
 * executable and a fixed JSON document is the process's sole stdin input.
 */
export class ShellCapabilityHost {
  private readonly spawn: CapabilitySpawn;
  private readonly maxLineBytes: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(private readonly options: ShellCapabilityHostOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new TypeError("maxLineBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new TypeError("maxOutputBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.killGraceMs) || this.killGraceMs < 0) {
      throw new TypeError("killGraceMs must be a nonnegative safe integer");
    }
  }

  async *invoke(
    capability: ShellCapability,
    input: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityEvent> {
    const queue = new EventQueue<CapabilityEvent>();
    let stop: () => void = () => undefined;
    let stoppedByConsumer = false;
    void this.run(capability, input, context, signal, queue, (terminate) => {
      stop = terminate;
      if (stoppedByConsumer) stop();
    });

    try {
      for await (const event of queue) yield event;
    } finally {
      stoppedByConsumer = true;
      stop();
    }
  }

  private async resolveEntrypoint(
    capability: ShellCapability,
  ): Promise<Entrypoint | CapabilityEvent> {
    let root: string;
    try {
      root = await realpath(this.options.pluginRoot);
    } catch {
      return terminalError("capability_plugin_root_unavailable");
    }
    const candidate = path.resolve(root, capability.entry);
    if (!isInside(root, candidate)) {
      return terminalError("capability_entry_outside_plugin_root");
    }
    let entry: string;
    try {
      entry = await realpath(candidate);
    } catch {
      return terminalError("capability_entry_unavailable");
    }
    if (!isInside(root, entry)) {
      return terminalError("capability_entry_outside_plugin_root");
    }
    try {
      const entryStat = await stat(entry);
      if (!entryStat.isFile() || (entryStat.mode & 0o111) === 0) {
        return terminalError("capability_entry_not_executable");
      }
    } catch {
      return terminalError("capability_entry_unavailable");
    }
    return { root, entry };
  }

  private async run(
    capability: ShellCapability,
    input: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
    queue: EventQueue<CapabilityEvent>,
    setStop: (terminate: () => void) => void,
  ): Promise<void> {
    try {
      if (
        !Number.isSafeInteger(capability.timeoutSeconds) ||
        capability.timeoutSeconds < 1 ||
        capability.timeoutSeconds > MAX_CAPABILITY_TIMEOUT_SECONDS
      ) {
        queue.push(terminalError("capability_timeout_invalid"));
        return;
      }
      const resolved = await this.resolveEntrypoint(capability);
      if ("type" in resolved) {
        queue.push(resolved);
        return;
      }
      if (signal.aborted) {
        queue.push(terminalError("capability_cancelled"));
        return;
      }

      let request: string;
      try {
        request = JSON.stringify({ input, context });
      } catch {
        queue.push(terminalError("capability_input_invalid"));
        return;
      }
      if (typeof request !== "string") {
        queue.push(terminalError("capability_input_invalid"));
        return;
      }
      try {
        const document = JSON.parse(request) as Record<string, unknown>;
        if (
          !Object.hasOwn(document, "input") ||
          !Object.hasOwn(document, "context")
        ) {
          queue.push(terminalError("capability_input_invalid"));
          return;
        }
      } catch {
        queue.push(terminalError("capability_input_invalid"));
        return;
      }

      let child: ChildProcess;
      try {
        child = this.spawn(resolved.entry, [], {
          cwd: resolved.root,
          env: safeEnvironment(this.options.environment),
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch {
        queue.push(terminalError("capability_spawn_failed"));
        return;
      }
      if (!child.stdout || !child.stdin) {
        queue.push(terminalError("capability_spawn_failed"));
        child.kill();
        return;
      }

      await this.streamChild(
        child,
        request,
        capability.timeoutSeconds,
        signal,
        queue,
        setStop,
      );
    } catch {
      queue.push(terminalError("capability_host_failed"));
    } finally {
      queue.close();
    }
  }

  private async streamChild(
    child: ChildProcess,
    request: string,
    timeoutSeconds: number,
    signal: AbortSignal,
    queue: EventQueue<CapabilityEvent>,
    setStop: (terminate: () => void) => void,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let remaining = "";
      let totalOutputBytes = 0;
      let terminal: CapabilityEvent | null = null;
      let invalidOutput = false;
      let abortReason: "capability_cancelled" | "capability_timeout" | null =
        null;
      let closed = false;
      let terminating = false;
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (event: CapabilityEvent): void => {
        if (closed) return;
        closed = true;
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        queue.push(event);
        resolve();
      };

      const sendSignal = (name: NodeJS.Signals): void => {
        try {
          if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, name);
          } else {
            child.kill(name);
          }
        } catch {
          try {
            child.kill(name);
          } catch {
            // The child may have exited between output and cancellation.
          }
        }
      };

      const terminate = (): void => {
        if (closed || terminating) return;
        terminating = true;
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => sendSignal("SIGKILL"), this.killGraceMs);
        killTimer.unref();
      };

      const onAbort = (): void => {
        if (!abortReason) abortReason = "capability_cancelled";
        terminate();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        if (!abortReason) abortReason = "capability_timeout";
        terminate();
      }, capabilityTimeoutMilliseconds(timeoutSeconds));
      timeout.unref();

      const rejectOutput = (): void => {
        invalidOutput = true;
        terminate();
      };

      const acceptLine = (line: string): void => {
        if (invalidOutput) return;
        if (Buffer.byteLength(line) > this.maxLineBytes || line.length === 0) {
          rejectOutput();
          return;
        }
        const event = parseCapabilityEventLine(line);
        if (!event || terminal) {
          rejectOutput();
          return;
        }
        if (event.type === "result" || event.type === "error") {
          terminal = event;
          return;
        }
        queue.push(event);
      };

      const consumeText = (text: string): void => {
        remaining += text;
        let lineEnd = remaining.indexOf("\n");
        while (lineEnd >= 0) {
          const rawLine = remaining.slice(0, lineEnd);
          remaining = remaining.slice(lineEnd + 1);
          acceptLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
          lineEnd = remaining.indexOf("\n");
        }
        if (Buffer.byteLength(remaining) > this.maxLineBytes) rejectOutput();
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        if (closed || invalidOutput) return;
        totalOutputBytes += chunk.byteLength;
        if (totalOutputBytes > this.maxOutputBytes) {
          rejectOutput();
          return;
        }
        try {
          consumeText(decoder.decode(chunk, { stream: true }));
        } catch {
          rejectOutput();
        }
      });

      child.stdout!.once("end", () => {
        if (invalidOutput || closed) return;
        try {
          consumeText(decoder.decode());
          if (remaining.length > 0) {
            const finalLine = remaining.endsWith("\r")
              ? remaining.slice(0, -1)
              : remaining;
            remaining = "";
            acceptLine(finalLine);
          }
        } catch {
          rejectOutput();
        }
      });

      child.once("error", () => {
        clearTimeout(timeout);
        finish(terminalError("capability_spawn_failed"));
      });

      child.once("close", (code) => {
        clearTimeout(timeout);
        if (abortReason) {
          finish(terminalError(abortReason));
          return;
        }
        if (invalidOutput) {
          finish(terminalError("capability_output_invalid"));
          return;
        }
        if (code !== 0) {
          finish(
            terminal?.type === "error"
              ? terminal
              : terminalError("capability_process_failed"),
          );
          return;
        }
        finish(terminal ?? terminalError("capability_missing_terminal_event"));
      });

      child.stdin!.once("error", () => rejectOutput());
      child.stdin!.end(`${request}\n`);
      if (signal.aborted) onAbort();
      setStop(onAbort);
    });
  }
}

function capabilityTimeoutMilliseconds(timeoutSeconds: number): number {
  return timeoutSeconds * 1_000;
}
