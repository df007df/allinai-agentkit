import { OptionalRuntimeDependencyError } from "./codex.js";
import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";

type PiAssistantMessageEvent = {
  type: string;
  delta?: string;
  [key: string]: unknown;
};

type PiSessionEvent =
  | { type: "agent_start" }
  | {
      type: "message_update";
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | {
      type: "agent_end";
      willRetry?: boolean;
      messages: unknown[];
    }
  | {
      type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
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
  sessionManager?: unknown;
  resourceLoader?: unknown;
}) => Promise<{ session: PiSession }>;

type PiSessionManagerModule = {
  SessionManager: {
    listAll(
      sessionDir?: string,
      onProgress?: unknown,
    ): Promise<Array<{ path: string; id: string }>>;
    open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
  };
};

type PiDefaultResourceLoaderModule = {
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir?: string;
    extensionFactories?: Array<unknown>;
  }) => unknown;
};

/** Everything the adapter needs from the official SessionManager surface. */
export type PiSessionResolver = {
  /** Resolves a previous sessionId (full or unique prefix) to its file. */
  resolveSessionFile(sessionId: string): Promise<string | null>;
  /** Opens a session file for continued prompting. */
  openSessionFile(
    sessionFile: string,
    cwd?: string,
  ): unknown;
};

/**
 * Host-owned tool decision bridge, same shape as the runner child's
 * `onAskUser`. When present, the adapter injects an inline approval extension
 * that gates every tool call on this callback.
 */
export type PiOnAskUser = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

type PiSdkModule = {
  VERSION?: string;
  createAgentSession: PiCreateSession;
};

export type PiSdkLoader = () => Promise<PiSdkModule>;

export type PiResourceLoaderLoader = () => Promise<PiDefaultResourceLoaderModule>;

export type PiAdapterRunInput = PlatformRunInput & {
  platform: "pi";
  /** Host-owned tool decision bridge; presence enables in-process gating. */
  onAskUser?: PiOnAskUser;
};

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
  /**
   * Test seam for session resume. Production reads the official
   * SessionManager (id or unique prefix match, then open).
   */
  sessionResolver?: PiSessionResolver;
  /** Test seam for the inline approval extension's resource loader. */
  loadResourceLoader?: PiResourceLoaderLoader;
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
  if (event.type === "agent_start") {
    return {
      type: "init",
      payload: { runtimeSessionId, vendorEventType: event.type },
    };
  }
  if (event.type === "message_update") {
    const update: PiAssistantMessageEvent = event.assistantMessageEvent;
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
    return {
      type: "vendor",
      payload: {
        vendorEventType: event.type,
        vendorUpdateType: update.type,
        update,
      },
    };
  }
  if (event.type === "agent_end") {
    // Pi may retry after this event. `prompt()` completion emits the single
    // terminal event when all retries have settled.
    const { willRetry, messages } = event as {
      willRetry?: boolean;
      messages: unknown[];
    };
    return willRetry
      ? null
      : {
          type: "done",
          payload: {
            vendorEventType: event.type,
            messageCount: messages.length,
          },
        };
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    return { type: "tool", payload: { ...event } };
  }
  // Session extension events (compaction, retries, queue updates, bash
  // output, ...) arrive outside the closed union above; keep them lossless.
  const extended = event as { type: string; [key: string]: unknown };
  return {
    type: "vendor",
    payload: { vendorEventType: extended.type, event: { ...extended } },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a DefaultResourceLoader carrying one inline approval extension. The
 * extension subscribes to `tool_call` and blocks until the host decision
 * bridge settles, so gating happens in-process without TUI dialogs.
 */
async function buildApprovalResourceLoader(
  onAskUser: PiOnAskUser,
  loadResourceLoader: PiResourceLoaderLoader | undefined,
  cwd: string | undefined,
): Promise<unknown> {
  const loaderDeps = loadResourceLoader ?? loadInstalledResourceLoader;
  const { DefaultResourceLoader } = await loaderDeps();
  return new DefaultResourceLoader({
    cwd: cwd ?? process.cwd(),
    extensionFactories: [
      {
        name: "agentkit-tool-approval",
        hidden: true,
        factory: (pi: {
          on(
            event: "tool_call",
            handler: (event: {
              toolName: string;
              input: Record<string, unknown>;
            }) => Promise<{ block?: boolean; reason?: string } | void>,
          ): void;
        }) => {
          pi.on("tool_call", async (event) => {
            const decision = await onAskUser(event.toolName, event.input);
            if (decision.behavior === "deny") {
              return { block: true, reason: decision.message };
            }
            return undefined;
          });
        },
      },
    ],
  });
}

function loadInstalledResourceLoader(): Promise<PiDefaultResourceLoaderModule> {
  return import(PI_SDK_PACKAGE) as Promise<PiDefaultResourceLoaderModule>;
}

/**
 * Builds the production resolver on the official SessionManager index. It
 * accepts the full id or a unique prefix, so hosts may store the short form
 * Pi shows in its own resume picker.
 */
function createOfficialSessionResolver(
  loadSessionManager: () => Promise<PiSessionManagerModule>,
): PiSessionResolver {
  return {
    async resolveSessionFile(sessionId) {
      const { SessionManager } = await loadSessionManager();
      const sessions = await SessionManager.listAll();
      const exact = sessions.find((session) => session.id === sessionId);
      if (exact) return exact.path;
      const matches = sessions.filter((session) =>
        session.id.startsWith(sessionId),
      );
      return matches.length === 1 ? (matches[0]?.path ?? null) : null;
    },
    async openSessionFile(sessionFile, cwd) {
      const { SessionManager } = await loadSessionManager();
      return SessionManager.open(sessionFile, undefined, cwd);
    },
  };
}

/**
 * Official Pi SDK adapter. It uses `createAgentSession()` and translates the
 * session subscription stream; tests replace only this factory and never start
 * a real Pi agent.
 */
export function createPiAdapter(deps: CreatePiAdapterDeps = {}): PiAdapter {
  const loadPi = deps.loadPi ?? loadInstalledPi;
  const loadSessionManager = (): Promise<PiSessionManagerModule> =>
    (async () => (await loadPiModule(loadPi)) as unknown as PiSessionManagerModule)();
  const sessionResolver: PiSessionResolver =
    deps.sessionResolver ?? createOfficialSessionResolver(loadSessionManager);

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
        let sessionOptions: {
          cwd?: string;
          sessionManager?: unknown;
          resourceLoader?: unknown;
        } | undefined = input.cwd ? { cwd: input.cwd } : undefined;
        if (input.onAskUser) {
          // In-process tool gating: an inline extension holds every tool call
          // on the host decision bridge before execution.
          sessionOptions = {
            ...sessionOptions,
            resourceLoader: await buildApprovalResourceLoader(
              input.onAskUser,
              deps.loadResourceLoader,
              input.cwd,
            ),
          };
        }
        if (input.sessionId) {
          const sessionFile = await sessionResolver.resolveSessionFile(
            input.sessionId,
          );
          if (sessionFile) {
            const sessionManager = sessionResolver.openSessionFile(
              sessionFile,
              input.cwd,
            );
            sessionOptions = {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              sessionManager,
            };
            emit({
              type: "init",
              payload: {
                runtimeSessionId: input.sessionId,
                resumed: true,
                sessionFile,
              },
            });
          } else {
            emit({
              type: "vendor",
              payload: {
                vendorEventType: "session_resume_unavailable",
                requestedSessionId: input.sessionId,
              },
            });
          }
        }
        const created = await createSession(sessionOptions);
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
