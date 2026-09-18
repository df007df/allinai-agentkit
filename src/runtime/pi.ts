import { OptionalRuntimeDependencyError } from "./codex.js";
import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";

type PiSessionEvent =
  | { type: "agent_start" }
  | {
      type: "message_update";
      assistantMessageEvent: {
        type: string;
        delta?: string;
        [key: string]: unknown;
      };
    }
  | {
      type: "agent_end";
      willRetry?: boolean;
      messages: unknown[];
    }
  | {
      type:
        | "tool_execution_start"
        | "tool_execution_update"
        | "tool_execution_end";
      [key: string]: unknown;
    };

type PiSession = {
  readonly sessionId: string;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
};

type PiCreateSession = (options?: {
  cwd?: string;
}) => Promise<{ session: PiSession }>;

type PiSdkModule = {
  VERSION?: string;
  createAgentSession: PiCreateSession;
};

export type PiSdkLoader = () => Promise<PiSdkModule>;

export type PiAdapterRunInput = PlatformRunInput & { platform: "pi" };

export type PiAdapter = {
  readonly id: "pi";
  probe(): Promise<PlatformProbe>;
  start(
    input: PiAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreatePiAdapterDeps = {
  /** Test seam; production uses the verified official Pi SDK factory. */
  createAgentSession?: PiCreateSession;
  /** Test seam for the optional SDK module. It is never invoked at import time. */
  loadPi?: PiSdkLoader;
};

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

function loadInstalledPi(): Promise<PiSdkModule> {
  return import(PI_SDK_PACKAGE) as Promise<PiSdkModule>;
}

async function loadPiModule(loader: PiSdkLoader): Promise<PiSdkModule> {
  try {
    return await loader();
  } catch (cause) {
    throw new OptionalRuntimeDependencyError(PI_SDK_PACKAGE, cause);
  }
}

class PiEventQueue implements AsyncIterable<PlatformEvent> {
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

function mapPiSessionEvent(
  event: PiSessionEvent,
  runtimeSessionId: string,
): PlatformEvent | null {
  switch (event.type) {
    case "agent_start":
      return {
        type: "init",
        payload: { runtimeSessionId, vendorEventType: event.type },
      };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return {
          type: "text_delta",
          payload: {
            text: update.delta,
            vendorEventType: event.type,
            vendorUpdateType: update.type,
          },
        };
      }
      if (update.type === "thinking_delta") {
        return {
          type: "thinking_delta",
          payload: {
            text: update.delta,
            vendorEventType: event.type,
            vendorUpdateType: update.type,
          },
        };
      }
      if (
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta" ||
        update.type === "toolcall_end"
      ) {
        return {
          type: "tool",
          payload: {
            vendorEventType: event.type,
            vendorUpdateType: update.type,
            update,
          },
        };
      }
      return null;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return { type: "tool", payload: { ...event } };
    case "agent_end":
      // Pi may retry after this event. `prompt()` completion emits the single
      // terminal event when all retries have settled.
      return event.willRetry
        ? null
        : {
            type: "done",
            payload: {
              vendorEventType: event.type,
              messageCount: event.messages.length,
            },
          };
    default:
      return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Official Pi SDK adapter. It uses `createAgentSession()` and translates the
 * session subscription stream; tests replace only this factory and never start
 * a real Pi agent.
 */
export function createPiAdapter(deps: CreatePiAdapterDeps = {}): PiAdapter {
  const loadPi = deps.loadPi ?? loadInstalledPi;

  return {
    id: "pi",
    async probe(): Promise<PlatformProbe> {
      const sdk = await loadPiModule(loadPi);
      return { installed: true, version: sdk.VERSION ?? null };
    },
    async *start(
      input: PiAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: { aborted: true } };
        return;
      }

      let session: PiSession | null = null;
      let unsubscribe: (() => void) | null = null;
      const events = new PiEventQueue();
      let emittedTerminal = false;
      const emit = (event: PlatformEvent) => {
        if (emittedTerminal) return;
        events.push(event);
        emittedTerminal = event.type === "done" || event.type === "error";
      };
      let abortRequested = false;
      let abortCompletion: Promise<void> | null = null;
      const abort = (): Promise<void> | null => {
        abortRequested = true;
        if (!session) return null;
        if (abortCompletion) return abortCompletion;
        abortCompletion = (async () => {
          // `AgentSession.abort()` is asynchronous. Finish it before
          // publishing terminal state or disposing the session so Pi has an
          // opportunity to stop its model/tool work cleanly.
          await session?.abort().catch(() => undefined);
          if (!emittedTerminal) {
            emit({ type: "done", payload: { aborted: true } });
          }
          events.close();
        })();
        return abortCompletion;
      };

      signal.addEventListener("abort", abort, { once: true });
      try {
        const createSession =
          deps.createAgentSession ??
          (await loadPiModule(loadPi)).createAgentSession;
        const created = await createSession(
          input.cwd ? { cwd: input.cwd } : undefined,
        );
        session = created.session;
        if (abortRequested || signal.aborted) {
          abort();
        } else {
          unsubscribe = session.subscribe((event) => {
            const mapped = mapPiSessionEvent(event, session?.sessionId ?? "");
            if (mapped && !abortRequested) emit(mapped);
          });

          void session
            .prompt(input.prompt)
            .then(() => {
              if (!abortRequested && !emittedTerminal) emit({ type: "done" });
            })
            .catch((error: unknown) => {
              if (!abortRequested && !emittedTerminal) {
                emit({
                  type: "error",
                  payload: { message: errorMessage(error), cause: "sdk_throw" },
                });
              }
            })
            .finally(() => {
              if (!abortRequested) events.close();
            });
        }

        for await (const event of events) yield event;
      } catch (error) {
        if (error instanceof OptionalRuntimeDependencyError) throw error;
        if (signal.aborted) {
          yield { type: "done", payload: { aborted: true } };
        } else {
          yield {
            type: "error",
            payload: { message: errorMessage(error), cause: "sdk_throw" },
          };
        }
      } finally {
        signal.removeEventListener("abort", abort);
        if (abortRequested && session && !abortCompletion) abort();
        await abortCompletion;
        unsubscribe?.();
        session?.dispose();
      }
    },
  };
}
