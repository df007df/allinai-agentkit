import type { PlatformEvent } from "./types.js";

export const PLATFORM_EVENT_TYPES = [
  "init",
  "text_delta",
  "thinking_delta",
  "tool",
  "vendor",
  "done",
  "error",
] as const satisfies readonly PlatformEvent["type"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isPlatformEvent(value: unknown): value is PlatformEvent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "payload"]) ||
    !PLATFORM_EVENT_TYPES.includes(value.type as PlatformEvent["type"])
  ) {
    return false;
  }
  return value.payload === undefined || isRecord(value.payload);
}

export function isTerminalPlatformEvent(event: PlatformEvent): boolean {
  return event.type === "done" || event.type === "error";
}
/** Keeps process/protocol failures in the same durable event shape as SDK failures. */
export function platformErrorEvent(
  reason: string,
  message: string,
  details?: Record<string, unknown>,
): PlatformEvent {
  return {
    type: "error",
    payload: {
      reason,
      message,
      ...details,
    },
  };
}
