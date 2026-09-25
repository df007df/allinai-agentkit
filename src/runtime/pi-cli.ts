import type { PlatformEvent, PlatformRunInput } from "./types.js";

export { readJsonl } from "./codex-cli.js";

export type PiCliSpawn = {
  cwd?: string;
  resumeSessionId?: string;
  prompt: string;
  model?: string;
};

/**
 * Builds the `pi -p --mode json` argument vector. Session resume goes
 * through --session <id> (exact project session id).
 */
export function buildPiPrintArgs(input: PiCliSpawn): string[] {
  const args = ["-p", "--mode", "json"];
  if (input.model) args.push("--model", input.model);
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  args.push(input.prompt);
  return args;
}

/**
 * Maps one pi --mode json event into the normalized stream:
 * session → init (session id), message_update(text_delta) → text_delta,
 * message_end(assistant) → done, toolcall events → tool/vendor.
 */
export function mapPiCliEvent(
  event: Record<string, unknown>,
): PlatformEvent | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "session") {
    return {
      type: "init",
      payload: {
        ...(typeof event.id === "string" ? { runtimeSessionId: event.id } : {}),
        ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
      },
    };
  }
  if (type === "message_update") {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (
      update &&
      update.type === "text_delta" &&
      typeof update.delta === "string"
    ) {
      return { type: "text_delta", payload: { text: update.delta } };
    }
    return null;
  }
  if (type === "message_end") {
    const message = event.message as Record<string, unknown> | undefined;
    if ((message?.role as string) !== "assistant") return null;
    const content = Array.isArray(message?.content) ? message?.content : [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        return { type: "done", payload: { text: b.text } };
      }
    }
    return null;
  }
  if (type.startsWith("toolcall")) {
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    return {
      type: "vendor",
      payload: {
        vendorEventType: type,
        toolName: typeof toolCall?.name === "string" ? toolCall.name : undefined,
        toolCall,
      },
    };
  }
  if (type === "agent_end" && event.willRetry === false) {
    return null;
  }
  return null;
}

export function piCliRunInput(input: PlatformRunInput): PiCliSpawn {
  return {
    cwd: input.cwd,
    resumeSessionId: input.sessionId,
    prompt: input.prompt,
    model: input.model,
  };
}
