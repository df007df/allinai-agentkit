import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";
import { probeCli, type WhichFn } from "./cli-probe.js";
import {
  drainToString,
  mapCodexCliEvent,
  readJsonl,
  spawnCodexCli,
} from "./codex-cli.js";

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
  /** Test seam for the CLI existence probe. */
  which?: WhichFn;
  /** Codex CLI command; defaults to "codex". Tests inject a stub script. */
  codexCommand?: string;
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
      // CLI-first: installed means the codex binary exists on PATH. This is
      // the distribution ground truth; it makes no claim about login state.
      return await probeCli("codex", "codex", deps.which);
    },
    async *start(
      input: CodexAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: payload({ aborted: true }) };
        return;
      }

      // CLI-first execution: spawn `codex exec --json` and map its JSONL
      // events. The CLI is the distribution ground truth — it is exactly
      // what probe reports as installed, so execution cannot drift from it.
      const resumeThreadId = input.resumeThreadId ?? input.sessionId;
      if (resumeThreadId) {
        yield {
          type: "init",
          payload: payload({
            runtimeSessionId: resumeThreadId,
            resumed: true,
          }),
        };
      }

      const codexCommand = deps.codexCommand ?? "codex";
      const child = spawnCodexCli(
        codexCommand,
        {
          args: [],
          cwd: input.cwd,
          resumeThreadId,
          prompt: input.prompt,
        },
        signal,
      );

      let terminal = false;
      let sawInit = resumeThreadId !== undefined;
      try {
        for await (const cliEvent of readJsonl(child.stdout)) {
          const mapped = mapCodexCliEvent(cliEvent, resumeThreadId);
          if (!mapped) continue;
          if (mapped.type === "init") {
            // A resumed run re-emits thread.started; keep the resume init.
            if (sawInit) continue;
            sawInit = true;
          }
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") {
            terminal = true;
            return;
          }
        }
        const exit = await child.onExit;
        if (!terminal) {
          if (signal.aborted) {
            yield { type: "done", payload: payload({ aborted: true }) };
          } else if (exit.code !== 0) {
            const stderrText = await drainToString(child.stderr);
            yield {
              type: "error",
              payload: payload({
                message:
                  stderrText.trim() ||
                  `codex exec exited with code ${exit.code ?? "null"}`,
                cause: "cli_exit_nonzero",
              }),
            };
          } else {
            yield { type: "done", payload: undefined };
          }
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
            cause: "cli_spawn_failed",
          }),
        };
      }
    },
  };
}
