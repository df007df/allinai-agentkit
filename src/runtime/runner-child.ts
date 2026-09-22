import { createPlatformAdapterRegistry, type RegisteredPlatformAdapter } from "./registry.js";
import { platformErrorEvent } from "./events.js";
import {
  encodeApprovalRequest,
  encodeRunnerEvent,
  JsonlDecoder,
  parseApprovalResponse,
  parseRunnerStart,
} from "./runner-wire.js";
import { randomUUID } from "node:crypto";
import type { PlatformEvent, PlatformRunInput } from "./types.js";

let started = false;
const decoder = new JsonlDecoder();
const adapters = createPlatformAdapterRegistry();
const abort = new AbortController();
/** Pending human decisions, resolved by tool_approval.response lines. */
const pendingApprovals = new Map<
  string,
  (decision: { decision: "allow" | "deny"; reason?: string }) => void
>();

function writeLine(line: string): void {
  process.stdout.write(line);
}

function writeEvent(event: PlatformEvent): void {
  writeLine(encodeRunnerEvent(event));
}

function writeError(reason: string, message: string): void {
  writeEvent(platformErrorEvent(reason, message));
  process.exitCode = 1;
}

/**
 * The adapter-facing approval callback. It is only wired into adapters that
 * support in-process tool gating (claude canUseTool, pi approval extension).
 * The blocking promise resolves when the parent sends the decision; until
 * then the tool call is held.
 */
const onAskUser = async (
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> => {
  const requestId = randomUUID();
  writeLine(
    encodeApprovalRequest({
      type: "tool_approval.request",
      requestId,
      toolName,
      toolInput,
    }),
  );
  const decision = await new Promise<{
    decision: "allow" | "deny";
    reason?: string;
  }>((resolve) => {
    pendingApprovals.set(requestId, resolve);
  });
  return decision.decision === "allow"
    ? { behavior: "allow" }
    : {
        behavior: "deny",
        message: decision.reason ?? "Denied by human approval",
      };
};

// Adapters agree on the PlatformRunInput shape at runtime; the per-platform
// literal types only exist for call-site narrowing the child does not need.
function startAdapter(
  adapter: RegisteredPlatformAdapter,
  input: PlatformRunInput,
  signal: AbortSignal,
): AsyncIterable<PlatformEvent> {
  return adapter.start(
    { ...input, onAskUser } as never,
    signal,
  ) as AsyncIterable<PlatformEvent>;
}

async function run(message: NonNullable<ReturnType<typeof parseRunnerStart>>): Promise<void> {
  const { input } = message;
  const adapter = adapters
    .list()
    .find((candidate) => candidate.id === input.platform);
  if (!adapter) {
    writeError(
      "platform_adapter_unavailable",
      `No platform adapter is registered for ${input.platform}`,
    );
    return;
  }
  let terminal = false;
  try {
    for await (const event of startAdapter(adapter, input, abort.signal)) {
      if (event.type === "done" || event.type === "error") terminal = true;
      writeEvent(event);
      if (terminal) return;
    }
    if (!terminal) {
      writeError("runner_stream_ended", "Adapter stream ended before a terminal event");
    }
  } catch (error) {
    writeError(
      "platform_adapter_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    abort.abort();
  }
}

function handleLine(line: string): void {
  if (line.length === 0) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    writeError("runner_protocol_error", "Runner parent sent invalid JSONL");
    return;
  }
  const response = parseApprovalResponse(raw);
  if (response) {
    const resolve = pendingApprovals.get(response.requestId);
    if (resolve) {
      pendingApprovals.delete(response.requestId);
      resolve({ decision: response.decision, reason: response.reason });
    }
    return;
  }
  if (started) return;
  const message = parseRunnerStart(raw);
  if (!message) {
    writeError(
      "runner_protocol_error",
      "Runner parent sent an invalid start message",
    );
    return;
  }
  started = true;
  void run(message);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    abort.abort();
    process.exitCode = 0;
  });
}

process.stdin.on("data", (chunk: string | Uint8Array) => {
  for (const line of decoder.push(chunk)) handleLine(line);
});
process.stdin.on("end", () => {
  for (const line of decoder.finish()) handleLine(line);
});
process.stdin.on("error", (error) => {
  writeError(
    "runner_input_failed",
    error instanceof Error ? error.message : String(error),
  );
});
