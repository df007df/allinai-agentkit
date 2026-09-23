import {
  CLIENT_EVENT_TYPES,
  CLIENT_RUNTIME_IDS,
  type AgentInput,
  type ClientCommand,
  type ClientEvent,
  type ClientEventBatch,
  type ClientEventType,
  type HubDownlink,
  type InventoryReport,
  type PlatformInventoryEntry,
  type ProjectInventoryEntry,
  type PluginConfig,
  type PluginInventoryEntry,
  type PluginSyncAcknowledgement,
  type RuntimeId,
} from "./types.js";

/** Shared Hub ↔ Agent Client protocol identity. */
export const AGENT_CLIENT_PROTOCOL_VERSION = 2;

const CAPABILITY_SHELL_FIELDS = ["command", "argv", "shell"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return (
    typeof value === "string" && CLIENT_RUNTIME_IDS.includes(value as RuntimeId)
  );
}

function isClientEventType(value: unknown): value is ClientEventType {
  return (
    typeof value === "string" &&
    CLIENT_EVENT_TYPES.includes(value as ClientEventType)
  );
}

function isPluginConfig(value: unknown): value is PluginConfig {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["id", "gitUrl", "ref", "enabled", "runtimes"]) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.gitUrl) ||
    typeof value.enabled !== "boolean"
  )
    return false;
  if (value.ref !== undefined && !isNonEmptyString(value.ref)) return false;
  return (
    value.runtimes === undefined ||
    (Array.isArray(value.runtimes) && value.runtimes.every(isRuntimeId))
  );
}

function hasCapabilityShellField(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.some((item) => hasCapabilityShellField(item, seen));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      CAPABILITY_SHELL_FIELDS.includes(
        key as (typeof CAPABILITY_SHELL_FIELDS)[number],
      ) || hasCapabilityShellField(item, seen),
  );
}

export function parseClientCommand(value: unknown): ClientCommand | null {
  if (!isPlainObject(value) || !isNonEmptyString(value.kind)) return null;
  if (value.kind === "agent.run") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "commandId",
        "executionId",
        "taskId",
        "attempt",
        "runtime",
        "payload",
      ]) ||
      !isNonEmptyString(value.commandId) ||
      !isNonEmptyString(value.executionId) ||
      !isNonEmptyString(value.taskId) ||
      !isNonNegativeInteger(value.attempt) ||
      !isRuntimeId(value.runtime) ||
      !isPlainObject(value.payload)
    )
      return null;
    return {
      kind: "agent.run",
      commandId: value.commandId,
      executionId: value.executionId,
      taskId: value.taskId,
      attempt: value.attempt,
      runtime: value.runtime,
      payload: value.payload as AgentInput,
    };
  }
  if (value.kind === "capability.invoke") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "commandId",
        "executionId",
        "taskId",
        "attempt",
        "capabilityId",
        "input",
      ]) ||
      !isNonEmptyString(value.commandId) ||
      !isNonEmptyString(value.executionId) ||
      !isNonEmptyString(value.taskId) ||
      !isNonNegativeInteger(value.attempt) ||
      !isNonEmptyString(value.capabilityId) ||
      !isPlainObject(value.input) ||
      hasCapabilityShellField(value.input)
    )
      return null;
    return {
      kind: "capability.invoke",
      commandId: value.commandId,
      executionId: value.executionId,
      taskId: value.taskId,
      attempt: value.attempt,
      capabilityId: value.capabilityId,
      input: value.input,
    };
  }
  if (value.kind === "cancel") {
    if (
      !hasOnlyKeys(value, ["kind", "commandId", "executionId"]) ||
      !isNonEmptyString(value.commandId) ||
      !isNonEmptyString(value.executionId)
    )
      return null;
    return {
      kind: "cancel",
      commandId: value.commandId,
      executionId: value.executionId,
    };
  }
  if (value.kind === "respond_tool_approval") {
    if (
      !hasOnlyKeys(value, [
        "kind",
        "commandId",
        "executionId",
        "requestId",
        "decision",
        "reason",
      ]) ||
      !isNonEmptyString(value.commandId) ||
      !isNonEmptyString(value.executionId) ||
      !isNonEmptyString(value.requestId) ||
      (value.decision !== "allow" && value.decision !== "deny") ||
      (value.reason !== undefined && !isNonEmptyString(value.reason))
    )
      return null;
    return {
      kind: "respond_tool_approval",
      commandId: value.commandId,
      executionId: value.executionId,
      requestId: value.requestId,
      decision: value.decision,
      ...(value.reason !== undefined ? { reason: value.reason } : {}),
    };
  }
  return null;
}

export function parseClientEvent(value: unknown): ClientEvent | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "executionId",
      "eventSeq",
      "type",
      "payload",
      "occurredAt",
    ]) ||
    !isNonEmptyString(value.executionId) ||
    !isNonNegativeInteger(value.eventSeq) ||
    !isClientEventType(value.type) ||
    !isNonEmptyString(value.occurredAt)
  )
    return null;
  if (Object.hasOwn(value, "payload")) {
    if (!isPlainObject(value.payload)) return null;
    return {
      executionId: value.executionId,
      eventSeq: value.eventSeq,
      type: value.type,
      payload: value.payload,
      occurredAt: value.occurredAt,
    };
  }
  return {
    executionId: value.executionId,
    eventSeq: value.eventSeq,
    type: value.type,
    occurredAt: value.occurredAt,
  };
}

export function parseClientEventBatch(value: unknown): ClientEvent[] | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "events"]) ||
    value.type !== "event.push" ||
    !Array.isArray(value.events)
  )
    return null;
  const events: ClientEvent[] = [];
  for (const event of value.events) {
    const parsed = parseClientEvent(event);
    if (!parsed) return null;
    events.push(parsed);
  }
  return events;
}

export function encodeClientEventBatch(
  events: ClientEvent[],
): ClientEventBatch {
  const parsed = parseClientEventBatch({ type: "event.push", events });
  if (!parsed) throw new TypeError("Invalid ClientEvent batch");
  return { type: "event.push", events: parsed };
}

export type ClientHello = {
  type: "client.hello";
  protocolVersion: typeof AGENT_CLIENT_PROTOCOL_VERSION;
  clientId: string;
  /** Optional human-readable display name; absent means "show clientId". */
  name?: string;
};
export type HubEventAcknowledgement = {
  type: "event.ack";
  watermarks: Record<string, number>;
};

function isPluginSyncAcknowledgement(
  value: unknown,
): value is PluginSyncAcknowledgement {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "revision", "status", "plugins", "error"]) ||
    value.type !== "plugin.sync.ack" ||
    !isNonEmptyString(value.revision) ||
    !["applied", "already_applied", "failed"].includes(
      value.status as string,
    ) ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(
      (plugin) =>
        isPlainObject(plugin) &&
        hasOnlyKeys(plugin, ["id", "resolvedCommit"]) &&
        isNonEmptyString(plugin.id) &&
        typeof plugin.resolvedCommit === "string" &&
        /^[0-9a-f]{40}$/i.test(plugin.resolvedCommit),
    )
  )
    return false;
  if (value.error === undefined) return value.status !== "failed";
  return (
    value.status === "failed" &&
    isPlainObject(value.error) &&
    hasOnlyKeys(value.error, ["code", "message"]) &&
    value.error.code === "plugin_sync_failed" &&
    isNonEmptyString(value.error.message)
  );
}

function isPlatformInventoryEntry(value: unknown): value is PlatformInventoryEntry {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["platform", "installed", "version", "reason"]) ||
    !isRuntimeId(value.platform) ||
    typeof value.installed !== "boolean" ||
    (value.version !== null && typeof value.version !== "string")
  )
    return false;
  return value.reason === undefined || isNonEmptyString(value.reason);
}

function isPluginInventoryEntry(value: unknown): value is PluginInventoryEntry {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "id",
        "gitUrl",
        "ref",
        "enabled",
        "status",
        "resolvedCommit",
        "installedAt",
        "lastError",
      ],
    ) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.gitUrl) ||
    typeof value.enabled !== "boolean" ||
    !["active", "blocked", "failed"].includes(value.status as string) ||
    typeof value.resolvedCommit !== "string" ||
    !(value.resolvedCommit === "unresolved" || /^[0-9a-f]{40}$/i.test(value.resolvedCommit)) ||
    !isNonEmptyString(value.installedAt)
  )
    return false;
  if (value.ref !== undefined && !isNonEmptyString(value.ref)) return false;
  return value.lastError === undefined || isNonEmptyString(value.lastError);
}

function isProjectInventoryEntry(value: unknown): value is ProjectInventoryEntry {
  return isPlainObject(value) && hasOnlyKeys(value, ["name"]) && isNonEmptyString(value.name);
}

export function parseInventoryReport(value: unknown): InventoryReport | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "reportedAt", "platforms", "plugins", "projects"]) ||
    value.type !== "inventory.report" ||
    !isNonEmptyString(value.reportedAt) ||
    !Array.isArray(value.platforms) ||
    !value.platforms.every(isPlatformInventoryEntry) ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(isPluginInventoryEntry) ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProjectInventoryEntry)
  )
    return null;
  return {
    type: "inventory.report",
    reportedAt: value.reportedAt,
    platforms: value.platforms,
    plugins: value.plugins,
    projects: value.projects,
  };
}

export function encodeInventoryReport(value: InventoryReport): InventoryReport {
  const parsed = parseInventoryReport(value);
  if (!parsed) throw new TypeError("Invalid inventory report");
  return parsed;
}

export function parsePluginSyncAcknowledgement(
  value: unknown,
): PluginSyncAcknowledgement | null {
  if (!isPluginSyncAcknowledgement(value)) return null;
  return {
    type: "plugin.sync.ack",
    revision: value.revision,
    status: value.status,
    plugins: value.plugins.map(({ id, resolvedCommit }) => ({
      id,
      resolvedCommit: resolvedCommit.toLowerCase(),
    })),
    ...(value.error
      ? {
          error: {
            code: "plugin_sync_failed" as const,
            message: value.error.message,
          },
        }
      : {}),
  };
}

export function encodePluginSyncAcknowledgement(
  value: PluginSyncAcknowledgement,
): PluginSyncAcknowledgement {
  const parsed = parsePluginSyncAcknowledgement(value);
  if (!parsed) throw new TypeError("Invalid plugin sync acknowledgement");
  return parsed;
}

export function parseClientHello(value: unknown): ClientHello | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "protocolVersion", "clientId", "name"]) ||
    value.type !== "client.hello" ||
    value.protocolVersion !== AGENT_CLIENT_PROTOCOL_VERSION ||
    !isNonEmptyString(value.clientId)
  )
    return null;
  // A present-but-blank name is dropped rather than rejecting the hello: the
  // identity fields are authoritative, the name is decorative.
  return {
    type: "client.hello",
    protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
    clientId: value.clientId,
    ...(isNonEmptyString(value.name) ? { name: value.name } : {}),
  };
}

export function encodeClientHello(
  clientId: string,
  name?: string,
): ClientHello {
  const hello = parseClientHello({
    type: "client.hello",
    protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
    clientId,
    ...(name ? { name } : {}),
  });
  if (!hello) throw new TypeError("Client id must be a non-empty string");
  return hello;
}

export function parseHubDownlink(value: unknown): HubDownlink | null {
  if (!isPlainObject(value) || !isNonEmptyString(value.type)) return null;
  if (value.type === "task.offer" && hasOnlyKeys(value, ["type", "command"])) {
    const command = parseClientCommand(value.command);
    return command ? { type: "task.offer", command } : null;
  }
  if (
    value.type === "plugin.sync" &&
    hasOnlyKeys(value, ["type", "revision", "plugins", "inventoryQuery"]) &&
    isNonEmptyString(value.revision) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isPluginConfig) &&
    (value.inventoryQuery === undefined || value.inventoryQuery === true)
  )
    return {
      type: "plugin.sync",
      revision: value.revision,
      plugins: value.plugins,
      ...(value.inventoryQuery === true ? { inventoryQuery: true } : {}),
    };
  return null;
}

export function parseHubEventAcknowledgement(
  value: unknown,
): HubEventAcknowledgement | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "watermarks"]) ||
    value.type !== "event.ack" ||
    !isPlainObject(value.watermarks)
  )
    return null;
  const watermarks: Record<string, number> = {};
  for (const [executionId, watermark] of Object.entries(value.watermarks)) {
    if (!isNonEmptyString(executionId) || !isNonNegativeInteger(watermark))
      return null;
    watermarks[executionId] = watermark;
  }
  return { type: "event.ack", watermarks };
}
