import { OptionalRuntimeDependencyError } from "./codex.js";
import type { PlatformEvent, PlatformProbe } from "./types.js";

/** Opaque vendor message shape retained without a mandatory SDK type dependency. */
export type ClaudeSdkMessage = {
  type?: string;
  subtype?: string;
  [key: string]: unknown;
};

export type ClaudeSdkUserMessage = Record<string, unknown>;

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; signal: AbortSignal },
) => Promise<unknown>;

export type ClaudeSdkOptions = {
  abortController?: AbortController;
  canUseTool?: ClaudeCanUseTool;
  [key: string]: unknown;
};

export type ClaudeQuery = AsyncIterable<ClaudeSdkMessage> & {
  close(): void;
};

export type ClaudeAdapterRunInput = {
  prompt: string | AsyncIterable<ClaudeSdkUserMessage>;
  /** Domain/host prepares provider and plugin settings before crossing this boundary. */
  options: Omit<ClaudeSdkOptions, "abortController" | "canUseTool">;
  /** Host-owned tool decision bridge. The adapter never imports a host package. */
  onAskUser?: ClaudeCanUseTool;
};

export type ClaudeQueryFactory = (parameters: {
  prompt: string | AsyncIterable<ClaudeSdkUserMessage>;
  options?: ClaudeSdkOptions;
}) => ClaudeQuery;

type ClaudeSdkModule = { query: ClaudeQueryFactory };

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>;

export type ClaudeAdapter = {
  readonly id: "claude";
  probe(): Promise<PlatformProbe>;
  start(
    input: ClaudeAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreateClaudeAdapterDeps = {
  /** Test seam. Production invokes the installed official Claude Agent SDK. */
  query?: ClaudeQueryFactory;
  /** Test seam for the optional SDK module. It is never invoked at import time. */
  loadClaude?: ClaudeSdkLoader;
};

const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

function loadInstalledClaude(): Promise<ClaudeSdkModule> {
  return import(CLAUDE_SDK_PACKAGE) as Promise<ClaudeSdkModule>;
}

async function loadClaudeModule(
  loader: ClaudeSdkLoader,
): Promise<ClaudeSdkModule> {
  try {
    return await loader();
  } catch (cause) {
    throw new OptionalRuntimeDependencyError(CLAUDE_SDK_PACKAGE, cause);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function payload(
  message: ClaudeSdkMessage,
  values: Record<string, unknown> = {},
): PlatformEvent["payload"] {
  return { ...values, vendorMessage: message };
}

function messageRecord(message: ClaudeSdkMessage): Record<string, unknown> {
  return message;
}

function messageSessionId(
  message: Record<string, unknown>,
): string | undefined {
  return text(message.session_id) ?? text(message.sessionId);
}

function mapClaudeMessage(message: ClaudeSdkMessage): PlatformEvent {
  const raw = messageRecord(message);
  const type = text(raw.type) ?? "unknown";
  const subtype = text(raw.subtype);

  if (type === "system" && subtype === "init") {
    return {
      type: "init",
      payload: payload(message, {
        runtimeSessionId: messageSessionId(raw),
        plugins: raw.plugins,
      }),
    };
  }

  if (type === "system" && subtype === "thinking_tokens") {
    return {
      type: "thinking_delta",
      payload: payload(message, { text: "" }),
    };
  }

  if (type === "stream_event" && isRecord(raw.event)) {
    const event = raw.event;
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (delta?.type === "text_delta") {
      return {
        type: "text_delta",
        payload: payload(message, { text: text(delta.text) ?? "" }),
      };
    }
    if (delta?.type === "thinking_delta") {
      return {
        type: "thinking_delta",
        payload: payload(message, { text: text(delta.thinking) ?? "" }),
      };
    }
  }

  if (type === "assistant" && isRecord(raw.message)) {
    const content = Array.isArray(raw.message.content)
      ? raw.message.content
      : [];
    const firstText = content.find(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    );
    if (isRecord(firstText)) {
      return {
        type: "text_delta",
        payload: payload(message, { text: firstText.text }),
      };
    }
    const firstThinking = content.find(
      (block) =>
        isRecord(block) &&
        block.type === "thinking" &&
        typeof block.thinking === "string",
    );
    if (isRecord(firstThinking)) {
      return {
        type: "thinking_delta",
        payload: payload(message, { text: firstThinking.thinking }),
      };
    }
  }

  if (type === "result") {
    const result = text(raw.result);
    if (raw.is_error === true || subtype === "error") {
      return {
        type: "error",
        payload: payload(message, {
          message: result ?? "Claude Agent SDK error",
        }),
      };
    }
    return { type: "done", payload: payload(message, { result }) };
  }

  if (type === "user" && isRecord(raw.message)) {
    // Tool results and control replies arrive as user-role messages; they are
    // the observable outcome of tool execution, not agent output.
    const content = Array.isArray(raw.message.content)
      ? raw.message.content
      : [];
    if (content.some((block) => isRecord(block) && block.type === "tool_result")) {
      return { type: "tool", payload: payload(message) };
    }
  }

  return {
    type: "vendor",
    payload: payload(message, { vendorMessageType: type, subtype }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Official Claude Agent SDK adapter. SDK setup/iteration and process cleanup
 * stay here; provider selection and host callbacks are explicit input.
 */
export function createClaudeAdapter(
  deps: CreateClaudeAdapterDeps = {},
): ClaudeAdapter {
  const loadClaude = deps.loadClaude ?? loadInstalledClaude;

  return {
    id: "claude",
    async probe(): Promise<PlatformProbe> {
      // This is deliberately SDK-presence reporting, not a provider auth or
      // executable health check.
      await loadClaudeModule(loadClaude);
      return { installed: true, version: null };
    },
    async *start(
      input: ClaudeAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: { aborted: true } };
        return;
      }

      const abortController = new AbortController();
      let activeQuery: ClaudeQuery | null = null;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        abortController.abort();
        activeQuery?.close();
      };
      signal.addEventListener("abort", close, { once: true });

      try {
        const queryFactory =
          deps.query ?? (await loadClaudeModule(loadClaude)).query;
        activeQuery = queryFactory({
          prompt: input.prompt,
          options: {
            ...input.options,
            abortController,
            ...(input.onAskUser ? { canUseTool: input.onAskUser } : {}),
          },
        });

        for await (const message of activeQuery) {
          if (signal.aborted) break;
          const mapped = mapClaudeMessage(message);
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") return;
        }

        yield {
          type: "done",
          ...(signal.aborted ? { payload: { aborted: true } } : {}),
        };
      } catch (error) {
        if (error instanceof OptionalRuntimeDependencyError) throw error;
        if (signal.aborted) {
          yield { type: "done", payload: { aborted: true } };
          return;
        }
        yield {
          type: "error",
          payload: { message: errorMessage(error), cause: "sdk_throw" },
        };
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    },
  };
}
