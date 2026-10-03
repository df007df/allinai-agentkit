export const CLIENT_RUNTIME_IDS = ["codex", "claude", "pi", "zcode"] as const;

export type RuntimeId = (typeof CLIENT_RUNTIME_IDS)[number];

/** Structured input passed to a platform adapter; runtime-specific validation is adapter-owned. */
export type AgentInput = Record<string, unknown>;

export type ClientCommand =
  | {
      kind: "agent.run";
      commandId: string;
      executionId: string;
      taskId: string;
      attempt: number;
      runtime: RuntimeId;
      payload: AgentInput;
    }
  | {
      kind: "capability.invoke";
      commandId: string;
      executionId: string;
      taskId: string;
      attempt: number;
      capabilityId: string;
      input: Record<string, unknown>;
    }
  | { kind: "cancel"; commandId: string; executionId: string }
  | {
      kind: "respond_tool_approval";
      commandId: string;
      executionId: string;
      requestId: string;
      decision: "allow" | "deny";
      reason?: string;
    }
  | {
      /** Approver UI verdict on a locally policy-gated execution. */
      kind: "respond_policy_approval";
      commandId: string;
      executionId: string;
      decision: "allow" | "deny";
      reason?: string;
    };

export const CLIENT_EVENT_TYPES = [
  "received",
  "running",
  "awaiting_approval",
  "progress",
  "done",
  "failed",
  "cancelled",
  "recovery_required",
  "rejected",
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/**
 * Content dimension of a progress event: what the runtime actually did.
 * Orthogonal to the lifecycle `type`; terminal lifecycle events omit it.
 */
export const CLIENT_EVENT_CONTENT_TYPES = [
  "init",
  "text_delta",
  "thinking_delta",
  "tool",
  "vendor",
] as const;

export type ClientEventContentType =
  (typeof CLIENT_EVENT_CONTENT_TYPES)[number];

export type ClientEvent = {
  executionId: string;
  eventSeq: number;
  type: ClientEventType;
  /** Present only when `type` is "progress"; names the payload shape. */
  eventType?: ClientEventContentType;
  payload?: Record<string, unknown>;
  occurredAt: string;
};

export type ClientEventBatch = {
  type: "event.push";
  events: ClientEvent[];
};

/** Hub desired plugin state; installation remains a local client concern. */
export type PluginConfig = {
  id: string;
  gitUrl: string;
  ref?: string;
  enabled: boolean;
  runtimes?: RuntimeId[];
};

export type HubDownlink =
  | { type: "task.offer"; command: ClientCommand }
  | {
      type: "plugin.sync";
      revision: string;
      plugins: PluginConfig[];
      /** Query-only downlink: report inventory, apply no side effects. */
      inventoryQuery?: true;
    };

export type PluginSyncStatus = "applied" | "already_applied" | "failed";

/** Per-plugin sync result carried on plugin.sync.ack. */
export type PluginSyncEntry = {
  id: string;
  resolvedCommit: string;
  /** Local working-repository HEAD (differs from resolvedCommit when diverged). */
  localHead?: string;
  /** True when tracked edits or local commits blocked an automatic update. */
  diverged?: boolean;
  /** Commits the local HEAD is ahead of the target (0 when not ahead). */
  aheadCount?: number;
};

/** Local acknowledgement of a desired-state revision; it never carries a pluginSet task field. */
export type PluginSyncAcknowledgement = {
  type: "plugin.sync.ack";
  revision: string;
  status: PluginSyncStatus;
  plugins: PluginSyncEntry[];
  error?: { code: "plugin_sync_failed"; message: string };
};

/** Optional embedded-Hub registration surface for node health reporting. */
export type HubRuntimeRegistration = {
  runtimeId: string;
  displayName: string;
  protocolVersion: number;
};

export type HubRuntimeHeartbeat = { runtimeId: string };

/** A non-executing embedded Hub audit event. Client executions use ClientEvent. */
export type HubRuntimeEvent = {
  sessionId: string;
  seq: number;
  kind: string;
  ts: string;
  payload: unknown;
};

export type PlatformInventoryEntry = {
  platform: RuntimeId;
  installed: boolean;
  version: string | null;
  reason?: string;
};

/** One platform's dispatch outcome for a synced plugin, as reported in inventory. */
export type PluginDeliveryInventoryEntry = {
  platform: "claude" | "codex" | "pi" | "zcode";
  state: "installed" | "removed" | "skipped" | "failed";
  detail?: string;
};

export type PluginInventoryEntry = {
  id: string;
  gitUrl: string;
  ref?: string;
  enabled: boolean;
  status: "active" | "blocked" | "failed";
  resolvedCommit: string;
  installedAt: string;
  lastError?: string;
  /** Local working-repository HEAD (differs from resolvedCommit when diverged). */
  localHead?: string;
  /** True when tracked edits or local commits blocked an automatic update. */
  diverged?: boolean;
  /** Commits the local HEAD is ahead of the target (0 when not ahead). */
  aheadCount?: number;
  /** Per-platform dispatch outcome of the last sync (one entry per platform). */
  delivery?: PluginDeliveryInventoryEntry[];
};

/**
 * A locally registered project name as reported in inventory. Only the name
 * crosses the wire: Hub selection is by name, and the path stays client-local.
 */
export type ProjectInventoryEntry = {
  name: string;
};

export type InventoryReport = {
  type: "inventory.report";
  reportedAt: string;
  platforms: PlatformInventoryEntry[];
  plugins: PluginInventoryEntry[];
  projects: ProjectInventoryEntry[];
};
