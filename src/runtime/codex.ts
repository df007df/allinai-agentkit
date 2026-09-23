import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";

type CodexSdkEvent = { type: string; [key: string]: unknown };

type CodexThread = {
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexSdkEvent> }>;
};

/** The small official SDK surface this adapter needs; injectable for tests. */
export type CodexSdk = {
  startThread(options?: {
    workingDirectory?: string;
    model?: string;
    /** Skip Codex's git-repo trust gate; daemon-managed run dirs are often
     * bare workspaces a user has never opened in Codex. */
    skipGitRepoCheck?: boolean;
  }): CodexThread;
  resumeThread(
    threadId: string,
    options?: {
      workingDirectory?: string;
      model?: string;
      skipGitRepoCheck?: boolean;
    },
  ): CodexThread;
};

type CodexSdkModule = {
  Codex: new () => CodexSdk;
};

export type CodexSdkLoader = () => Promise<CodexSdkModule>;

/** Raised only when a caller asks to use an adapter whose optional SDK is absent. */
export class OptionalRuntimeDependencyError extends Error {
  readonly packageName: string;
  readonly installCommand: string;

  constructor(packageName: string, cause: unknown) {
    const installCommand = `npm install ${packageName}`;
    super(
      `The optional runtime dependency ${packageName} is not available. Install it with \`${installCommand}\`.`,
      { cause },
    );
    this.name = "OptionalRuntimeDependencyError";
    this.packageName = packageName;
    this.installCommand = installCommand;
  }
}

export type CodexAdapterRunInput = PlatformRunInput & {
  platform: "codex";
  /**
   * A previously reported Codex thread id, when this is a resume. Falls back
   * to the transport-level `sessionId` when the host does not set this alias.
   */
  resumeThreadId?: string;
  /**
   * SDK escalation policy. The official SDK exposes no approval callback, so
   * in-flight decisions cannot be delivered; defaults to `never` (sandbox is
   * the boundary) and human gating is delivered out of process via hooks.
   */
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
};

export type CodexAdapter = {
  readonly id: "codex";
  probe(): Promise<PlatformProbe>;
  start(
    input: CodexAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreateCodexAdapterDeps = {
  /** Test seam. Production creates the installed official Codex SDK. */
  createCodex?: () => CodexSdk;
  /** Test seam for the optional SDK module. It is never invoked at import time. */
  loadCodex?: CodexSdkLoader;
};

const CODEX_SDK_PACKAGE = "@openai/codex-sdk";

function loadInstalledCodex(): Promise<CodexSdkModule> {
  return import(CODEX_SDK_PACKAGE) as Promise<CodexSdkModule>;
}

async function loadCodexModule(
  loader: CodexSdkLoader,
): Promise<CodexSdkModule> {
  try {
    return await loader();
  } catch (cause) {
    throw new OptionalRuntimeDependencyError(CODEX_SDK_PACKAGE, cause);
  }
}

function payload(values: Record<string, unknown>): PlatformEvent["payload"] {
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapCodexEvent(event: CodexSdkEvent): PlatformEvent | null {
  if (event.type === "thread.started") {
    const runtimeSessionId = text(event.thread_id);
    return runtimeSessionId
      ? {
          type: "init",
          payload: payload({ runtimeSessionId, vendorEventType: event.type }),
        }
      : null;
  }

  if (event.type === "turn.started") {
    return {
      type: "vendor",
      payload: payload({ vendorEventType: event.type }),
    };
  }

  if (event.type === "item.completed" && isRecord(event.item)) {
    if (event.item.type === "agent_message") {
      const message = text(event.item.text);
      return message
        ? {
            type: "text_delta",
            payload: payload({ text: message, vendorEventType: event.type }),
          }
        : null;
    }
    if (event.item.type === "reasoning") {
      const reasoning = text(event.item.text);
      return reasoning
        ? {
            type: "thinking_delta",
            payload: payload({ text: reasoning, vendorEventType: event.type }),
          }
        : null;
    }
    if (
      event.item.type === "command_execution" ||
      event.item.type === "file_change" ||
      event.item.type === "mcp_tool_call" ||
      event.item.type === "web_search" ||
      event.item.type === "todo_list"
    ) {
      return {
        type: "tool",
        payload: payload({ item: event.item, vendorEventType: event.type }),
      };
    }
    return {
      type: "vendor",
      payload: payload({ item: event.item, vendorEventType: event.type }),
    };
  }

  if (event.type === "turn.completed") {
    return {
      type: "done",
      payload: payload({ usage: event.usage, vendorEventType: event.type }),
    };
  }

  if (event.type === "turn.failed") {
    const message = isRecord(event.error)
      ? text(event.error.message)
      : undefined;
    return {
      type: "error",
      payload: payload({
        message: message ?? "Codex turn failed",
        vendorEventType: event.type,
      }),
    };
  }

  if (event.type === "error") {
    return {
      type: "error",
      payload: payload({
        message: text(event.message) ?? "Codex SDK error",
        vendorEventType: event.type,
      }),
    };
  }

  if (event.type === "item.started" || event.type === "item.updated") {
    return {
      type: "tool",
      payload: payload({ item: event.item, vendorEventType: event.type }),
    };
  }

  return {
    type: "vendor",
    payload: payload({ vendorEventType: event.type }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A vendor iterator is allowed to be waiting for stdout when cancellation
 * arrives. Do not wait for it to produce another event before reporting the
 * cancellation to the caller; Codex receives the same signal in
 * `runStreamed` and the iterator is asked to return as additional cleanup.
 */
function nextEventOrAbort(
  iterator: AsyncIterator<CodexSdkEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<CodexSdkEvent> | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void iterator.return?.();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (next) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(next);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Official Codex SDK adapter. It owns SDK event translation and takes the
 * caller's AbortSignal unchanged, so cancellation reaches `runStreamed`.
 */
export function createCodexAdapter(
  deps: CreateCodexAdapterDeps = {},
): CodexAdapter {
  const loadCodex = deps.loadCodex ?? loadInstalledCodex;

  return {
    id: "codex",
    async probe(): Promise<PlatformProbe> {
      // This only reports that the optional SDK boundary is importable; it
      // intentionally does not claim CLI login or provider credentials are healthy.
      await loadCodexModule(loadCodex);
      return { installed: true, version: null };
    },
    async *start(
      input: CodexAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: payload({ aborted: true }) };
        return;
      }

      const sdk = deps.createCodex
        ? deps.createCodex()
        : new (await loadCodexModule(loadCodex)).Codex();
      const threadOptions = {
        ...(input.cwd ? { workingDirectory: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        // Runs are daemon-managed workspaces, not repos the user opened in
        // Codex, so the interactive trust gate would block every run.
        skipGitRepoCheck: true,
        // The SDK exposes no approval callback, so escalation requests cannot
        // be answered in-process. Lock the policy to `never` and let the
        // sandbox be the boundary; tool-level human gating for Codex is the
        // hooks-channel deliverable (see docs/research 2026-09-22).
        ...(input.approvalPolicy ?? "never" ? { approvalPolicy: (input.approvalPolicy ?? "never") as "never" } : {}),
      };
      // `sessionId` is the platform-reported runtimeSessionId from a previous
      // run; resuming continues the persisted Codex thread in place.
      const resumeThreadId = input.resumeThreadId ?? input.sessionId;
      const thread = resumeThreadId
        ? sdk.resumeThread(resumeThreadId, threadOptions)
        : sdk.startThread(threadOptions);
      let terminal = false;

      if (resumeThreadId) {
        yield {
          type: "init",
          payload: payload({
            runtimeSessionId: resumeThreadId,
            resumed: true,
          }),
        };
      }

      try {
        const { events } = await thread.runStreamed(input.prompt, { signal });
        const iterator = events[Symbol.asyncIterator]();
        while (true) {
          const next = await nextEventOrAbort(iterator, signal);
          if (!next || next.done) break;
          const event = next.value;
          const mapped = mapCodexEvent(event);
          if (!mapped) continue;
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") {
            terminal = true;
            return;
          }
        }
        if (!terminal) {
          yield {
            type: "done",
            payload: signal.aborted ? payload({ aborted: true }) : undefined,
          };
        }
      } catch (error) {
        if (signal.aborted) {
          yield { type: "done", payload: payload({ aborted: true }) };
          return;
        }
        yield {
          type: "error",
          payload: payload({
            message: errorMessage(error),
            cause: "sdk_throw",
          }),
        };
      }
    },
  };
}
