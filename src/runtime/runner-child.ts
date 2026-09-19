import { createPlatformAdapterRegistry, type RegisteredPlatformAdapter } from "./registry.js";
import { platformErrorEvent } from "./events.js";
import {
  encodeRunnerEvent,
  JsonlDecoder,
  parseRunnerStart,
} from "./runner-wire.js";
import type { PlatformEvent, PlatformRunInput } from "./types.js";

let started = false;
const decoder = new JsonlDecoder();
const adapters = createPlatformAdapterRegistry();
const abort = new AbortController();

function writeEvent(event: PlatformEvent): void {
  process.stdout.write(encodeRunnerEvent(event));
}

function writeError(reason: string, message: string): void {
  writeEvent(platformErrorEvent(reason, message));
  process.exitCode = 1;
}

// Adapters agree on the PlatformRunInput shape at runtime; the per-platform
// literal types only exist for call-site narrowing the child does not need.
function startAdapter(
  adapter: RegisteredPlatformAdapter,
  input: PlatformRunInput,
  signal: AbortSignal,
): AsyncIterable<PlatformEvent> {
  return adapter.start(input as never, signal) as AsyncIterable<PlatformEvent>;
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
  if (line.length === 0 || started) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    writeError("runner_protocol_error", "Runner parent sent invalid JSONL");
    return;
  }
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
