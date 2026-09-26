import { spawn } from "node:child_process";
import type { PlatformEvent, PlatformRunInput } from "./types.js";

export type CodexCliSpawn = {
  args: string[];
  cwd?: string;
  resumeThreadId?: string;
  prompt: string;
};

export type CodexCliProcess = {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  onExit: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
};

/**
 * Builds the `codex exec` argument vector for a run. JSONL output keeps the
 * event mapping parseable. Full-permission execution (`-s
 * danger-full-access`, `--ask-for-approval never`): the daemon's own
 * approval layer (plugin-delivered hooks + hub decisions) is the gate,
 * not the CLI sandbox.
 */
export function buildCodexExecArgs(
  input: CodexCliSpawn,
  envOverrides: string[] = [],
): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    // Plugin-delivered hooks cannot be trusted interactively by an
    // unattended run; the scripts come from the agentkit-system plugin we
    // materialized ourselves, so托管信任 is the headless equivalent.
    "--dangerously-bypass-hook-trust",
  ];
  args.push(...envOverrides);
  if (input.cwd) args.push("-C", input.cwd);
  if (input.resumeThreadId) {
    args.push("resume", input.resumeThreadId);
  }
  args.push(input.prompt);
  return args;
}

/**
 * Streams parsed JSONL lines from a spawned codex process. Lines that fail
 * JSON parsing (banner text, warnings) are skipped — the wire format is
 * line-delimited JSON on stdout, everything else is noise.
 */
export async function* readJsonl(
  chunks: AsyncIterable<string>,
): AsyncIterable<Record<string, unknown>> {
  let buffer = "";
  const emit = function* (): Generator<Record<string, unknown>> {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const parsed = tryParseJson(line);
      if (parsed) yield parsed;
      newline = buffer.indexOf("\n");
    }
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    yield* emit();
  }
  // Flush the final unterminated line.
  const tail = buffer.trim();
  const parsed = tryParseJson(tail);
  if (parsed) yield parsed;
}

function tryParseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Non-JSON noise on stdout: skip.
    return null;
  }
}

export function spawnCodexCli(
  codexCommand: string,
  input: CodexCliSpawn,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): CodexCliProcess {
  const child = spawn(codexCommand, buildCodexExecArgs(input), {
    cwd: input.cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  const stdout = readChildStream(child.stdout);
  // Stderr must be buffered eagerly: if the caller only drains it after the
  // exit event, the process 'close' may already have destroyed the stream.
  const stderrChunks: string[] = [];
  const stderrDone = (async () => {
    for await (const chunk of readChildStream(child.stderr)) {
      stderrChunks.push(chunk);
    }
  })();
  const stderr = {
    async *[Symbol.asyncIterator]() {
      yield* stderrChunks;
      await stderrDone;
    },
  } as AsyncIterable<string>;
  const onExit = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      // Abort is an expected path (signal passed to spawn): the ABORT_ERR
      // from the error event must not reject the exit promise.
      child.once("error", () => resolve({ code: null, signal: "ABORT" }));
      child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
    },
  );
  return {
    stdout,
    stderr,
    onExit,
    kill: () => child.kill("SIGTERM"),
  };
}

async function* readChildStream(
  stream: NodeJS.ReadableStream | null,
): AsyncIterable<string> {
  if (!stream) return;
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    yield String(chunk);
  }
}

/**
 * Maps one codex exec --json event into the normalized PlatformEvent stream.
 * Mirrors the SDK adapter mapping: thread.started → init (with runtimeSessionId),
 * item.completed(agent_message) → done, other item events → tool/vendor.
 */
export function mapCodexCliEvent(
  event: Record<string, unknown>,
  runtimeSessionId: string | undefined,
): PlatformEvent | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started") {
    return {
      type: "init",
      payload: {
        ...(typeof event.thread_id === "string"
          ? { runtimeSessionId: event.thread_id }
          : runtimeSessionId
            ? { runtimeSessionId }
            : {}),
      },
    };
  }
  if (type === "turn.started" || type === "turn.completed") {
    return null;
  }
  if (type === "item.completed" || type === "item.started" || type === "item.updated") {
    const item = event.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const text = typeof item?.text === "string" ? item.text : "";
    if (itemType === "agent_message") {
      if (type === "item.completed") {
        return { type: "done", payload: { text } };
      }
      return {
        type: "text_delta",
        payload: { text },
      };
    }
    return {
      type: "vendor",
      payload: { vendorEventType: type, itemType, item },
    };
  }
  if (type === "error") {
    return {
      type: "error",
      payload: { message: typeof event.message === "string" ? event.message : "codex error" },
    };
  }
  return null;
}

export function codexCliRunInput(
  input: PlatformRunInput,
): CodexCliSpawn {
  return {
    args: [],
    cwd: input.cwd,
    resumeThreadId: input.sessionId,
    prompt: input.prompt,
  };
}

/** Collects a stderr stream into a string for error surfaces. */
export async function drainToString(
  stream: AsyncIterable<string>,
): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}
