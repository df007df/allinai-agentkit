import { platformErrorEvent } from "./events.js";
import {
  encodeRunnerEvent,
  JsonlDecoder,
  parseRunnerStart,
} from "./runner-wire.js";

let started = false;
const decoder = new JsonlDecoder();

function writeError(reason: string, message: string): void {
  process.stdout.write(encodeRunnerEvent(platformErrorEvent(reason, message)));
  process.exitCode = 1;
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
  // Task 1 deliberately contains no vendor SDK implementation. Task 2 wires
  // this fixed entrypoint to the adapter registry; until then it fails closed.
  writeError(
    "platform_adapter_unavailable",
    `No platform adapter is registered for ${message.input.platform}`,
  );
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
