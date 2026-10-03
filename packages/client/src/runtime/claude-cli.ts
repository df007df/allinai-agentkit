import { spawn } from "node:child_process";
import type { PlatformEvent, PlatformRunInput } from "./types.js";
import { readJsonl } from "./codex-cli.js";

export type ClaudeCliSpawn = {
  cwd?: string;
  resumeSessionId?: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  /** Absolute plugin directories passed as --plugin-dir (SDK-less delivery). */
  pluginDirs?: string[];
};

/**
 * Builds the `claude -p` argument vector. stream-json requires --verbose;
 * --output-style is left at default so hooks/events stay consistent.
 * Runs under the DEFAULT permission mode: bypassPermissions would suppress
 * the PermissionRequest hook (verified live — it never fires under bypass),
 * which is our tool ask-user relay. Full-permission behavior is restored by
 * the plugin hook itself, which allows every call unless a human denies it.
 */
export function buildClaudePrintArgs(input: ClaudeCliSpawn): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Default (not bypass): PermissionRequest hooks never fire under
    // bypassPermissions, killing the ask-user relay. The plugin hook
    // explicitly allows every call unless a human denies, so the default
    // mode stays fully permissive in practice.
    "--permission-mode",
    "default",
    "--max-turns",
    String(input.maxTurns ?? 1),
  ];
  if (input.model) args.push("--model", input.model);
  if (input.cwd) args.push("--add-dir", input.cwd);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  for (const dir of input.pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }
  return args;
}

/**
 * Maps one claude -p stream-json event into the normalized stream:
 * system/init → init (session id), assistant text → text_delta (partial) or
 * done (final via result), result → done/error.
 */
export function mapClaudeCliEvent(
  event: Record<string, unknown>,
): PlatformEvent | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "system") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (subtype === "init") {
      return {
        type: "init",
        payload: {
          ...(typeof event.session_id === "string"
            ? { runtimeSessionId: event.session_id }
            : {}),
          ...(typeof event.model === "string" ? { model: event.model } : {}),
        },
      };
    }
    return null;
  }
  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        return { type: "text_delta", payload: { text: b.text } };
      }
    }
    return null;
  }
  if (type === "result") {
    const isError = event.is_error === true;
    const text = typeof event.result === "string" ? event.result : "";
    return {
      type: isError ? "error" : "done",
      payload: { text, ...(isError ? { message: text } : {}) },
    };
  }
  return null;
}

export function claudeCliRunInput(
  input: PlatformRunInput,
): ClaudeCliSpawn {
  return {
    cwd: input.cwd,
    resumeSessionId: input.sessionId,
    prompt: input.prompt,
    model: input.model,
    maxTurns: 1,
  };
}

export type ClaudeCliProcess = {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  onExit: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
};

export function spawnClaudeCli(
  claudeCommand: string,
  input: ClaudeCliSpawn,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliProcess {
  const child = spawn(claudeCommand, buildClaudePrintArgs(input), {
    cwd: input.cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  const stdout: AsyncIterable<string> = readChildStream(child.stdout);
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
      child.once("error", () => resolve({ code: null, signal: "ABORT" }));
      child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
    },
  );
  return { stdout, stderr, onExit, kill: () => child.kill("SIGTERM") };
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
