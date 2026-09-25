import type { PlatformEvent, PlatformRunInput } from "./types.js";

export { readJsonl } from "./codex-cli.js";

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
 */
export function buildClaudePrintArgs(input: ClaudeCliSpawn): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
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
