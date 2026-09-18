import { PLATFORM_IDS, type PlatformId } from "../runtime/types.js";
import { parseShellCapability } from "../capabilities/manifest.js";
import type { PluginCapabilityDeclaration, PluginManifest } from "./types.js";

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPluginId(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ID.test(value);
}

function isRuntime(value: unknown): value is PlatformId {
  return (
    typeof value === "string" && PLATFORM_IDS.includes(value as PlatformId)
  );
}

function parseCapabilities(
  value: unknown,
): PluginCapabilityDeclaration[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;

  const seen = new Set<string>();
  const parsed: PluginCapabilityDeclaration[] = [];
  for (const capability of value) {
    const parsedCapability = parseShellCapability(capability);
    if (!parsedCapability || seen.has(parsedCapability.id)) {
      return null;
    }
    seen.add(parsedCapability.id);
    parsed.push(parsedCapability);
  }
  return parsed;
}

/**
 * Parse the installation manifest before any revision can become active.
 * Capability schema details become stricter in the capability layer, but an
 * installer still checks that every declaration has a safe fixed entrypoint.
 */
export function parsePluginManifest(value: unknown): PluginManifest | null {
  if (!isPlainObject(value) || !isPluginId(value.id)) return null;

  let runtimes: PlatformId[] | undefined;
  if (value.runtimes !== undefined) {
    if (
      !Array.isArray(value.runtimes) ||
      !value.runtimes.every(isRuntime) ||
      new Set(value.runtimes).size !== value.runtimes.length
    ) {
      return null;
    }
    runtimes = [...value.runtimes];
  }

  const capabilities = parseCapabilities(value.capabilities);
  if (capabilities === null) return null;

  const manifest: PluginManifest = { id: value.id };
  if (runtimes) manifest.runtimes = runtimes;
  if (value.capabilities !== undefined) manifest.capabilities = capabilities;
  return manifest;
}

export function isValidPluginId(value: unknown): value is string {
  return isPluginId(value);
}
