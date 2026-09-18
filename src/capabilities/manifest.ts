import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  CAPABILITY_CONTEXT_KEYS,
  CAPABILITY_PERMISSIONS,
  type CapabilityContextKey,
  type CapabilityPermission,
  type JsonSchema,
  type JsonSchemaValue,
  type ShellCapability,
} from "./types.js";

export const MAX_CAPABILITY_TIMEOUT_SECONDS = 900;

const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_SCHEMA_COLLECTION_ITEMS = 1_024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseDescription(
  value: Record<string, unknown>,
): string | undefined | null {
  if (value.description === undefined) return undefined;
  if (
    typeof value.description !== "string" ||
    value.description.length > 4_096
  ) {
    return null;
  }
  return value.description;
}

function parseBoundedInteger(
  value: Record<string, unknown>,
  key: string,
  maximum = MAX_SCHEMA_COLLECTION_ITEMS,
): number | undefined | null {
  const raw = value[key];
  if (raw === undefined) return undefined;
  return isNonNegativeInteger(raw) && raw <= maximum ? raw : null;
}

function parseJsonSchema(value: unknown, depth = 0): JsonSchemaValue | null {
  if (
    depth > MAX_SCHEMA_DEPTH ||
    !isPlainObject(value) ||
    typeof value.type !== "string"
  ) {
    return null;
  }
  const description = parseDescription(value);
  if (description === null) return null;
  const withDescription = description === undefined ? {} : { description };

  if (value.type === "object") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "description",
        "properties",
        "required",
        "additionalProperties",
        "minProperties",
        "maxProperties",
      ])
    ) {
      return null;
    }
    let properties: Record<string, JsonSchemaValue> | undefined;
    if (value.properties !== undefined) {
      if (!isPlainObject(value.properties)) return null;
      const entries = Object.entries(value.properties);
      if (entries.length > MAX_SCHEMA_PROPERTIES) return null;
      properties = {};
      for (const [key, child] of entries) {
        if (!key || key.length > 128) return null;
        const parsed = parseJsonSchema(child, depth + 1);
        if (!parsed) return null;
        properties[key] = parsed;
      }
    }
    let required: string[] | undefined;
    if (value.required !== undefined) {
      if (
        !Array.isArray(value.required) ||
        value.required.length > MAX_SCHEMA_PROPERTIES ||
        value.required.some(
          (key) => typeof key !== "string" || !properties?.[key],
        ) ||
        new Set(value.required).size !== value.required.length
      ) {
        return null;
      }
      required = [...value.required];
    }
    if (
      value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== "boolean"
    ) {
      return null;
    }
    const minProperties = parseBoundedInteger(
      value,
      "minProperties",
      MAX_SCHEMA_PROPERTIES,
    );
    const maxProperties = parseBoundedInteger(
      value,
      "maxProperties",
      MAX_SCHEMA_PROPERTIES,
    );
    if (
      minProperties === null ||
      maxProperties === null ||
      (minProperties !== undefined &&
        maxProperties !== undefined &&
        minProperties > maxProperties)
    ) {
      return null;
    }
    return {
      ...withDescription,
      type: "object",
      ...(properties ? { properties } : {}),
      ...(required ? { required } : {}),
      ...(value.additionalProperties !== undefined
        ? { additionalProperties: value.additionalProperties }
        : {}),
      ...(minProperties === undefined ? {} : { minProperties }),
      ...(maxProperties === undefined ? {} : { maxProperties }),
    };
  }

  if (value.type === "array") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "description",
        "items",
        "minItems",
        "maxItems",
      ])
    ) {
      return null;
    }
    const items = parseJsonSchema(value.items, depth + 1);
    const minItems = parseBoundedInteger(value, "minItems");
    const maxItems = parseBoundedInteger(value, "maxItems");
    if (
      !items ||
      minItems === null ||
      maxItems === null ||
      (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
    ) {
      return null;
    }
    return {
      ...withDescription,
      type: "array",
      items,
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
    };
  }

  if (value.type === "string") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "description",
        "minLength",
        "maxLength",
      ])
    ) {
      return null;
    }
    const minLength = parseBoundedInteger(value, "minLength");
    const maxLength = parseBoundedInteger(value, "maxLength");
    if (
      minLength === null ||
      maxLength === null ||
      (minLength !== undefined &&
        maxLength !== undefined &&
        minLength > maxLength)
    ) {
      return null;
    }
    return {
      ...withDescription,
      type: "string",
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
    };
  }

  if (value.type === "number" || value.type === "integer") {
    if (!hasOnlyKeys(value, ["type", "description", "minimum", "maximum"])) {
      return null;
    }
    if (
      (value.minimum !== undefined && !isFiniteNumber(value.minimum)) ||
      (value.maximum !== undefined && !isFiniteNumber(value.maximum)) ||
      (typeof value.minimum === "number" &&
        typeof value.maximum === "number" &&
        value.minimum > value.maximum)
    ) {
      return null;
    }
    return {
      ...withDescription,
      type: value.type,
      ...(value.minimum === undefined ? {} : { minimum: value.minimum }),
      ...(value.maximum === undefined ? {} : { maximum: value.maximum }),
    };
  }

  if (value.type === "boolean" || value.type === "null") {
    if (!hasOnlyKeys(value, ["type", "description"])) return null;
    return { ...withDescription, type: value.type };
  }
  return null;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | null {
  if (!Array.isArray(value) || new Set(value).size !== value.length)
    return null;
  const values: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) return null;
    values.push(item as T);
  }
  return values;
}

export function isValidCapabilityId(value: unknown): value is string {
  return typeof value === "string" && CAPABILITY_ID.test(value);
}

export function isSafeCapabilityEntry(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    !segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) && path.posix.normalize(value) === value
  );
}

/**
 * Parse the intentionally small JSON Schema subset accepted for direct shell
 * inputs. A root object is required, so a Hub request is always structured.
 */
export function parseShellCapability(value: unknown): ShellCapability | null {
  if (!isPlainObject(value)) return null;
  if (
    !hasOnlyKeys(value, [
      "id",
      "entry",
      "inputSchema",
      "contextKeys",
      "permissions",
      "timeoutSeconds",
    ]) ||
    !isValidCapabilityId(value.id) ||
    !isSafeCapabilityEntry(value.entry) ||
    !Number.isInteger(value.timeoutSeconds) ||
    (value.timeoutSeconds as number) < 1 ||
    (value.timeoutSeconds as number) > MAX_CAPABILITY_TIMEOUT_SECONDS
  ) {
    return null;
  }
  const inputSchema = parseJsonSchema(value.inputSchema);
  const contextKeys = parseEnum(value.contextKeys, CAPABILITY_CONTEXT_KEYS);
  const permissions = parseEnum(value.permissions, CAPABILITY_PERMISSIONS);
  if (
    !inputSchema ||
    inputSchema.type !== "object" ||
    !contextKeys ||
    !permissions
  ) {
    return null;
  }
  return {
    id: value.id,
    entry: value.entry,
    inputSchema,
    contextKeys: contextKeys as CapabilityContextKey[],
    permissions: permissions as CapabilityPermission[],
    timeoutSeconds: value.timeoutSeconds as number,
  };
}

function resolvesInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

/**
 * Installer-time realpath validation closes the remaining symlink escape
 * avenue that syntactic manifest parsing cannot see.
 */
export async function validateCapabilityEntries(
  pluginRoot: string,
  capabilities: readonly ShellCapability[],
): Promise<void> {
  const root = await realpath(pluginRoot);
  for (const capability of capabilities) {
    const candidate = path.resolve(root, capability.entry);
    if (!resolvesInside(root, candidate)) {
      throw new Error(
        `Capability ${capability.id} entry is outside the plugin root`,
      );
    }
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      throw new Error(
        `Capability ${capability.id} entry could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!resolvesInside(root, resolved)) {
      throw new Error(
        `Capability ${capability.id} entry resolves outside the plugin root`,
      );
    }
    const details = await stat(resolved);
    if (!details.isFile()) {
      throw new Error(
        `Capability ${capability.id} entry must resolve to a file`,
      );
    }
  }
}
