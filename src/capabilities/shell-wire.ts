import type { JsonSchemaValue } from "./types.js";

export const CAPABILITY_EVENT_TYPES = [
  "progress",
  "log",
  "result",
  "error",
] as const;

export type CapabilityEventType = (typeof CAPABILITY_EVENT_TYPES)[number];

export type CapabilityEvent = {
  type: CapabilityEventType;
  payload: Record<string, unknown>;
};

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PAYLOAD_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, depth = 0): value is JsonSchemaValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (depth >= MAX_PAYLOAD_DEPTH || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => !UNSAFE_KEYS.has(key) && isJsonValue(item, depth + 1),
  );
}

/**
 * A capability process may emit only `{ type, payload }` JSONL frames. The
 * payload intentionally remains application-defined, while the envelope stays
 * fixed so a plugin cannot inject a new control message into the client.
 */
export function parseCapabilityEventLine(line: string): CapabilityEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "type") ||
    !Object.hasOwn(value, "payload") ||
    typeof value.type !== "string" ||
    !CAPABILITY_EVENT_TYPES.includes(value.type as CapabilityEventType) ||
    !isPlainObject(value.payload) ||
    !isJsonValue(value.payload)
  ) {
    return null;
  }
  return {
    type: value.type as CapabilityEventType,
    payload: value.payload,
  };
}
