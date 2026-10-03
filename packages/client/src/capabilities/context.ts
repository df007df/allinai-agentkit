import { PLATFORM_IDS, type PlatformId } from "../runtime/types.js";
import type { CapabilityContextKey } from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type LocalContextSource = {
  execution?: Record<string, unknown>;
  workspace?: string | Record<string, unknown>;
  projectConfig?: Record<string, unknown>;
  /** Deliberately ignored: a capability never inherits process environment. */
  environment?: unknown;
  [key: string]: unknown;
};

/**
 * Project configuration is useful only after this recursive boundary. These
 * names deliberately over-match: losing an optional display field is safer
 * than leaking a session, cookie, bearer credential, or access key.
 */
const SENSITIVE_KEY =
  /(token|secret|password|credential|authorization|authentication|oauth|auth(token|key|cookie|session)|api[_-]?key|private[_-]?key|access[_-]?(key|token)|bearer|cookie|session|keychain|(^|[_-])env($|[_-]))/i;
const UNSAFE_OBJECT_KEY = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CONTEXT_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRuntime(value: unknown): value is PlatformId {
  return (
    typeof value === "string" && PLATFORM_IDS.includes(value as PlatformId)
  );
}

function sanitizeJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (depth > MAX_CONTEXT_DEPTH || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const sanitized = sanitizeJson(item, seen, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  if (!isPlainObject(value)) return undefined;
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || UNSAFE_OBJECT_KEY.has(key)) continue;
    const sanitized = sanitizeJson(item, seen, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function executionContext(
  source: Record<string, unknown> | undefined,
): Record<string, JsonValue> | null {
  if (!source) return null;
  const result: Record<string, JsonValue> = {};
  for (const key of ["executionId", "taskId", "commandId"] as const) {
    if (typeof source[key] === "string" && source[key].trim())
      result[key] = source[key];
  }
  if (Number.isSafeInteger(source.attempt) && (source.attempt as number) >= 0) {
    result.attempt = source.attempt as number;
  }
  if (isRuntime(source.runtime)) result.runtime = source.runtime;
  return Object.keys(result).length > 0 ? result : null;
}

function workspaceContext(
  source: LocalContextSource["workspace"],
): { path: string } | null {
  const candidate =
    typeof source === "string"
      ? source
      : isPlainObject(source) && typeof source.path === "string"
        ? source.path
        : null;
  return candidate && candidate.trim() ? { path: candidate } : null;
}

/**
 * Constructs a fresh JSON-only object. It selects named local sources rather
 * than spreading a command or process object, so credentials and ambient
 * environment cannot cross into a plugin process by accident.
 */
export function buildCapabilityContext(
  keys: readonly CapabilityContextKey[],
  source: LocalContextSource,
): Record<string, unknown> {
  const requested = new Set(keys);
  const context: Record<string, unknown> = {};
  if (requested.has("execution")) {
    const execution = executionContext(source.execution);
    if (execution) context.execution = execution;
  }
  if (requested.has("workspace")) {
    const workspace = workspaceContext(source.workspace);
    if (workspace) context.workspace = workspace;
  }
  if (requested.has("projectConfig")) {
    const projectConfig = sanitizeJson(source.projectConfig);
    if (projectConfig && !Array.isArray(projectConfig))
      context.projectConfig = projectConfig;
  }
  return context;
}
