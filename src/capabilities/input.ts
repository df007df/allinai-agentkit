import type { JsonSchema } from "./types.js";

const MAX_SCHEMA_DEPTH = 12;
const MAX_VALUE_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_COLLECTION_ITEMS = 1_024;
const MAX_DESCRIPTION_LENGTH = 4_096;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedInteger(
  value: unknown,
  maximum = MAX_COLLECTION_ITEMS,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function optionalBound(
  schema: Record<string, unknown>,
  key: string,
  maximum?: number,
): number | undefined | null {
  const value = schema[key];
  if (value === undefined) return undefined;
  return isBoundedInteger(value, maximum) ? (value as number) : null;
}

function isDescription(schema: Record<string, unknown>): boolean {
  return (
    schema.description === undefined ||
    (typeof schema.description === "string" &&
      schema.description.length <= MAX_DESCRIPTION_LENGTH)
  );
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (depth >= MAX_VALUE_DEPTH || !value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_COLLECTION_ITEMS &&
      value.every((item) => isJsonValue(item, depth + 1))
    );
  }
  if (
    !isPlainObject(value) ||
    Object.keys(value).length > MAX_SCHEMA_PROPERTIES
  ) {
    return false;
  }
  return Object.entries(value).every(
    ([key, item]) => !UNSAFE_KEYS.has(key) && isJsonValue(item, depth + 1),
  );
}

function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  depth: number,
): boolean {
  if (
    !hasOnlyKeys(schema, [
      "type",
      "description",
      "properties",
      "required",
      "additionalProperties",
      "minProperties",
      "maxProperties",
    ]) ||
    !isDescription(schema) ||
    !isPlainObject(value)
  ) {
    return false;
  }
  const minProperties = optionalBound(
    schema,
    "minProperties",
    MAX_SCHEMA_PROPERTIES,
  );
  const maxProperties = optionalBound(
    schema,
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
    return false;
  }
  const entries = Object.entries(value);
  if (
    entries.length > MAX_SCHEMA_PROPERTIES ||
    (minProperties !== undefined && entries.length < minProperties) ||
    (maxProperties !== undefined && entries.length > maxProperties) ||
    entries.some(([key]) => UNSAFE_KEYS.has(key))
  ) {
    return false;
  }

  let properties: Record<string, unknown> = {};
  if (schema.properties !== undefined) {
    if (
      !isPlainObject(schema.properties) ||
      Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES ||
      Object.entries(schema.properties).some(
        ([key]) => !key || key.length > 128 || UNSAFE_KEYS.has(key),
      )
    ) {
      return false;
    }
    properties = schema.properties;
  }
  let required: string[] = [];
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_SCHEMA_PROPERTIES ||
      schema.required.some(
        (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
      ) ||
      new Set(schema.required).size !== schema.required.length
    ) {
      return false;
    }
    required = schema.required as string[];
  }
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    return false;
  }
  const allowAdditional = schema.additionalProperties !== false;
  for (const [key, item] of entries) {
    const propertySchema = properties[key];
    if (propertySchema === undefined) {
      if (!allowAdditional || !isJsonValue(item, depth + 1)) return false;
      continue;
    }
    if (!validateSchema(propertySchema, item, depth + 1)) return false;
  }
  return true;
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown,
  depth: number,
): boolean {
  if (
    !hasOnlyKeys(schema, [
      "type",
      "description",
      "items",
      "minItems",
      "maxItems",
    ]) ||
    !isDescription(schema) ||
    !Array.isArray(value) ||
    schema.items === undefined
  ) {
    return false;
  }
  const minItems = optionalBound(schema, "minItems");
  const maxItems = optionalBound(schema, "maxItems");
  if (
    minItems === null ||
    maxItems === null ||
    (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
    value.length > MAX_COLLECTION_ITEMS ||
    (minItems !== undefined && value.length < minItems) ||
    (maxItems !== undefined && value.length > maxItems)
  ) {
    return false;
  }
  return value.every((item) => validateSchema(schema.items, item, depth + 1));
}

function validateString(
  schema: Record<string, unknown>,
  value: unknown,
): boolean {
  if (
    !hasOnlyKeys(schema, [
      "type",
      "description",
      "minLength",
      "maxLength",
    ]) ||
    !isDescription(schema) ||
    typeof value !== "string"
  ) {
    return false;
  }
  const minLength = optionalBound(schema, "minLength");
  const maxLength = optionalBound(schema, "maxLength");
  if (
    minLength === null ||
    maxLength === null ||
    (minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength) ||
    (minLength !== undefined && value.length < minLength) ||
    (maxLength !== undefined && value.length > maxLength)
  ) {
    return false;
  }
  return true;
}

function validateNumber(
  schema: Record<string, unknown>,
  value: unknown,
): boolean {
  if (
    !hasOnlyKeys(schema, ["type", "description", "minimum", "maximum"]) ||
    !isDescription(schema) ||
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return false;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) return false;
  if (
    (schema.minimum !== undefined &&
      (typeof schema.minimum !== "number" ||
        !Number.isFinite(schema.minimum))) ||
    (schema.maximum !== undefined &&
      (typeof schema.maximum !== "number" ||
        !Number.isFinite(schema.maximum))) ||
    (typeof schema.minimum === "number" &&
      typeof schema.maximum === "number" &&
      schema.minimum > schema.maximum)
  ) {
    return false;
  }
  return (
    (schema.minimum === undefined || value >= schema.minimum) &&
    (schema.maximum === undefined || value <= schema.maximum)
  );
}

function validateSchema(
  schema: unknown,
  value: unknown,
  depth: number,
): boolean {
  if (depth > MAX_SCHEMA_DEPTH || !isPlainObject(schema)) return false;
  if (schema.type === "object") return validateObject(schema, value, depth);
  if (schema.type === "array") return validateArray(schema, value, depth);
  if (schema.type === "string") return validateString(schema, value);
  if (schema.type === "number" || schema.type === "integer") {
    return validateNumber(schema, value);
  }
  if (schema.type === "boolean") {
    return (
      hasOnlyKeys(schema, ["type", "description"]) &&
      isDescription(schema) &&
      typeof value === "boolean"
    );
  }
  if (schema.type === "null") {
    return (
      hasOnlyKeys(schema, ["type", "description"]) &&
      isDescription(schema) &&
      value === null
    );
  }
  return false;
}

/**
 * Validates the manifest's deliberately small JSON Schema subset. Any schema
 * shape or value outside that subset is rejected rather than silently ignored.
 */
export function validateCapabilityInput(
  schema: JsonSchema,
  input: unknown,
): boolean {
  return validateSchema(schema, input, 0);
}
