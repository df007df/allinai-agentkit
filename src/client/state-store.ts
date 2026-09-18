import { DatabaseSync } from "node:sqlite";
import {
  parseClientCommand,
  parseClientEventBatch,
  type ClientCommand,
  type ClientEvent,
  type ClientEventType,
} from "../protocol/index.js";
import type {
  ActivePluginSnapshot,
  InstalledPlugin,
  PluginStateStore,
  StoredPluginState,
} from "../plugins/types.js";

export const EXECUTION_STATES = [
  "received",
  "awaiting_approval",
  "running",
  "rejected",
  "done",
  "failed",
  "cancelled",
  "recovery_required",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export type StoredExecution = {
  executionId: string;
  command: ClientCommand;
  state: ExecutionState;
  attempt: number;
  admittedAt: string;
  updatedAt: string;
  lastEventSeq: number;
  pluginSnapshot: ActivePluginSnapshot[];
};

export type AdmissionResult = {
  disposition: "inserted" | "duplicate";
  execution: StoredExecution;
};

export type AdmissionOptions = {
  pluginSnapshot?: ActivePluginSnapshot[];
};

export type EventToAppend = Omit<ClientEvent, "eventSeq"> & {
  eventSeq?: number;
};

type ExecutionRow = {
  execution_id: string;
  command_json: string;
  state: string;
  attempt: number;
  admitted_at: string;
  updated_at: string;
  last_event_seq: number;
  plugin_snapshot_json: string;
};

type OutboxRow = {
  event_json: string;
};

type PluginStateRow = {
  plugin_json: string;
  active_json: string | null;
};

const LEGAL_TRANSITIONS: Readonly<
  Record<ExecutionState, readonly ExecutionState[]>
> = {
  received: ["awaiting_approval", "running", "rejected", "cancelled"],
  awaiting_approval: ["running", "rejected", "cancelled"],
  running: ["done", "failed", "cancelled", "recovery_required"],
  rejected: [],
  done: [],
  failed: [],
  cancelled: [],
  recovery_required: [],
};

function isExecutionState(value: string): value is ExecutionState {
  return EXECUTION_STATES.includes(value as ExecutionState);
}

function now(): string {
  return new Date().toISOString();
}

function commandAttempt(command: ClientCommand): number {
  return command.kind === "cancel" ? 0 : command.attempt;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePluginSnapshot(
  value: ActivePluginSnapshot[],
): ActivePluginSnapshot[] {
  const seen = new Set<string>();
  return value.map((plugin) => {
    if (
      !plugin ||
      typeof plugin.id !== "string" ||
      !plugin.id ||
      typeof plugin.resolvedCommit !== "string" ||
      !/^[0-9a-f]{40}$/i.test(plugin.resolvedCommit) ||
      seen.has(plugin.id)
    ) {
      throw new TypeError("Plugin snapshot must contain unique full commits");
    }
    seen.add(plugin.id);
    return {
      id: plugin.id,
      resolvedCommit: plugin.resolvedCommit.toLowerCase(),
    };
  });
}

function parsePluginSnapshot(value: string): ActivePluginSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Stored plugin snapshot is invalid JSON");
  }
  if (!Array.isArray(parsed))
    throw new TypeError("Stored plugin snapshot is invalid");
  return normalizePluginSnapshot(parsed as ActivePluginSnapshot[]);
}

function assertInstalledPlugin(value: InstalledPlugin): void {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.gitUrl !== "string" ||
    !value.gitUrl ||
    typeof value.enabled !== "boolean" ||
    typeof value.resolvedCommit !== "string" ||
    !value.resolvedCommit ||
    typeof value.installedAt !== "string" ||
    !value.installedAt ||
    !["active", "blocked", "failed"].includes(value.status)
  ) {
    throw new TypeError("Plugin installation record is invalid");
  }
}

function parseInstalledPlugin(value: string): InstalledPlugin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Stored plugin record is invalid JSON");
  }
  assertInstalledPlugin(parsed as InstalledPlugin);
  return parsed as InstalledPlugin;
}

/**
 * Durable local inbox/outbox for one Agent Client daemon.
 *
 * `last_event_seq` deliberately lives with the execution rather than the
 * outbox: acknowledged rows are deleted, but a later event must never reuse
 * their sequence number.
 */
export class ClientStateStore implements PluginStateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Atomically writes the inbox command and its initial received event. A
   * redelivered execution returns the existing row without adding an event.
   */
  admit(
    command: ClientCommand,
    options: AdmissionOptions = {},
  ): AdmissionResult {
    return this.transaction(() => {
      const previous = this.getExecutionRow(command.executionId);
      if (previous) {
        return {
          disposition: "duplicate",
          execution: this.toExecution(previous),
        };
      }

      const admittedAt = now();
      const pluginSnapshot = normalizePluginSnapshot(
        options.pluginSnapshot ?? [],
      );
      const received: ClientEvent = {
        executionId: command.executionId,
        eventSeq: 1,
        type: "received",
        occurredAt: admittedAt,
      };
      if (pluginSnapshot.length > 0) received.payload = { pluginSnapshot };

      this.db
        .prepare(
          `INSERT INTO executions (
            execution_id, command_json, state, attempt, admitted_at, updated_at, last_event_seq, plugin_snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.executionId,
          JSON.stringify(command),
          "received",
          commandAttempt(command),
          admittedAt,
          admittedAt,
          received.eventSeq,
          JSON.stringify(pluginSnapshot),
        );
      this.insertOutboxEvent(received);

      return {
        disposition: "inserted",
        execution: {
          executionId: command.executionId,
          command,
          state: "received",
          attempt: commandAttempt(command),
          admittedAt,
          updatedAt: admittedAt,
          lastEventSeq: received.eventSeq,
          pluginSnapshot,
        },
      };
    });
  }

  getExecution(executionId: string): StoredExecution | null {
    const row = this.getExecutionRow(executionId);
    return row ? this.toExecution(row) : null;
  }

  listExecutions(): StoredExecution[] {
    const rows = this.db
      .prepare(
        `SELECT execution_id, command_json, state, attempt, admitted_at, updated_at, last_event_seq, plugin_snapshot_json
         FROM executions
         ORDER BY admitted_at ASC, execution_id ASC`,
      )
      .all() as unknown as ExecutionRow[];
    return rows.map((row) => this.toExecution(row));
  }

  /**
   * Changes execution state and commits the matching state event in the same
   * transaction. Callers cannot report a durable state without a durable
   * outbox record for it.
   */
  transition(
    executionId: string,
    nextState: ExecutionState,
    payload?: Record<string, unknown>,
  ): ClientEvent {
    return this.transaction(() => {
      const current = this.requireExecutionRow(executionId);
      this.assertLegalTransition(current, nextState);
      return this.transitionRow(current, nextState, payload);
    });
  }

  /**
   * Appends a non-state runtime event supplied by the caller. If no sequence is
   * supplied, this store allocates the next sequence. Explicit sequences are
   * accepted only when they are the next sequence, preventing acknowledgement
   * watermarks from skipping an event.
   */
  appendEvent(event: EventToAppend): ClientEvent {
    if (event.type !== "progress") {
      throw new TypeError(
        "Only progress events may be appended directly; state events must use transition",
      );
    }
    return this.transaction(() => {
      const current = this.requireExecutionRow(event.executionId);
      const eventSeq = event.eventSeq ?? current.last_event_seq + 1;
      if (
        !Number.isSafeInteger(eventSeq) ||
        eventSeq !== current.last_event_seq + 1
      ) {
        throw new RangeError(
          `Event sequence for ${event.executionId} must be ${current.last_event_seq + 1}`,
        );
      }
      const storedEvent: ClientEvent = { ...event, eventSeq };
      this.assertValidEvent(storedEvent);

      this.insertOutboxEvent(storedEvent);
      this.db
        .prepare(
          `UPDATE executions
           SET last_event_seq = ?, updated_at = ?
           WHERE execution_id = ?`,
        )
        .run(storedEvent.eventSeq, now(), storedEvent.executionId);
      return storedEvent;
    });
  }

  listUnackedEvents(executionId?: string): ClientEvent[] {
    const rows = executionId
      ? (this.db
          .prepare(
            `SELECT event_json FROM outbox
             WHERE execution_id = ?
             ORDER BY event_seq ASC`,
          )
          .all(executionId) as unknown as OutboxRow[])
      : (this.db
          .prepare(
            `SELECT event_json FROM outbox
             ORDER BY execution_id ASC, event_seq ASC`,
          )
          .all() as unknown as OutboxRow[]);
    return rows.map(({ event_json: eventJson }) =>
      this.parseStoredEvent(eventJson),
    );
  }

  /** Deletes only events at or below the Hub's acknowledgement watermark. */
  acknowledge(executionId: string, eventSeqWatermark: number): number {
    if (!Number.isSafeInteger(eventSeqWatermark) || eventSeqWatermark < 0) {
      throw new RangeError(
        "Acknowledgement watermark must be a non-negative safe integer",
      );
    }
    const result = this.db
      .prepare(
        `DELETE FROM outbox
         WHERE execution_id = ? AND event_seq <= ?`,
      )
      .run(executionId, eventSeqWatermark);
    return Number(result.changes);
  }

  /**
   * On daemon boot, no in-process runner can be trusted to still exist. Mark
   * every persisted running execution (or one selected execution) as needing
   * recovery and enqueue a matching state event.
   */
  markRecoveryRequired(executionId?: string): ClientEvent[] {
    return this.transaction(() => {
      const rows = executionId
        ? (this.db
            .prepare(
              `SELECT execution_id, command_json, state, attempt, admitted_at, updated_at, last_event_seq, plugin_snapshot_json
               FROM executions
               WHERE execution_id = ? AND state = 'running'`,
            )
            .all(executionId) as unknown as ExecutionRow[])
        : (this.db
            .prepare(
              `SELECT execution_id, command_json, state, attempt, admitted_at, updated_at, last_event_seq, plugin_snapshot_json
               FROM executions
               WHERE state = 'running'
               ORDER BY admitted_at ASC, execution_id ASC`,
            )
            .all() as unknown as ExecutionRow[]);

      return rows.map((row) => this.transitionRow(row, "recovery_required"));
    });
  }

  private initialize(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS executions (
          execution_id TEXT PRIMARY KEY,
          command_json TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          admitted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_event_seq INTEGER NOT NULL DEFAULT 0,
          plugin_snapshot_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS outbox (
          execution_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (execution_id, event_seq)
        );

        CREATE TABLE IF NOT EXISTS plugin_states (
          plugin_id TEXT PRIMARY KEY,
          plugin_json TEXT NOT NULL,
          active_json TEXT
        );

        CREATE TABLE IF NOT EXISTS plugin_sync_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision TEXT NOT NULL,
          synced_at TEXT NOT NULL
        );
      `);
      const columns = this.db
        .prepare("PRAGMA table_info(executions)")
        .all() as unknown as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "plugin_snapshot_json")) {
        this.db.exec(
          "ALTER TABLE executions ADD COLUMN plugin_snapshot_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getExecutionRow(executionId: string): ExecutionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT execution_id, command_json, state, attempt, admitted_at, updated_at, last_event_seq, plugin_snapshot_json
         FROM executions
         WHERE execution_id = ?`,
        )
        .get(executionId) as unknown as ExecutionRow | undefined) ?? null
    );
  }

  private requireExecutionRow(executionId: string): ExecutionRow {
    const row = this.getExecutionRow(executionId);
    if (!row) throw new Error(`Unknown execution ${executionId}`);
    return row;
  }

  private toExecution(row: ExecutionRow): StoredExecution {
    if (!isExecutionState(row.state)) {
      throw new TypeError(
        `Stored execution ${row.execution_id} has invalid state ${row.state}`,
      );
    }
    const command = parseClientCommand(JSON.parse(row.command_json));
    if (!command) {
      throw new TypeError(
        `Stored execution ${row.execution_id} has an invalid command`,
      );
    }
    return {
      executionId: row.execution_id,
      command,
      state: row.state,
      attempt: row.attempt,
      admittedAt: row.admitted_at,
      updatedAt: row.updated_at,
      lastEventSeq: row.last_event_seq,
      pluginSnapshot: parsePluginSnapshot(row.plugin_snapshot_json),
    };
  }

  getLastPluginSyncRevision(): string | null {
    const row = this.db
      .prepare("SELECT revision FROM plugin_sync_state WHERE singleton = 1")
      .get() as unknown as { revision: string } | undefined;
    return row?.revision ?? null;
  }

  recordPluginSyncSuccess(revision: string): void {
    if (typeof revision !== "string" || revision.trim().length === 0) {
      throw new TypeError("Plugin sync revision must be a nonempty string");
    }
    this.db
      .prepare(
        `INSERT INTO plugin_sync_state (singleton, revision, synced_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, synced_at = excluded.synced_at`,
      )
      .run(revision, now());
  }

  listPluginStates(): StoredPluginState[] {
    const rows = this.db
      .prepare(
        "SELECT plugin_json, active_json FROM plugin_states ORDER BY plugin_id ASC",
      )
      .all() as unknown as PluginStateRow[];
    return rows.map((row) => ({
      plugin: parseInstalledPlugin(row.plugin_json),
      active: row.active_json ? parseInstalledPlugin(row.active_json) : null,
    }));
  }

  savePluginState(state: StoredPluginState): void {
    assertInstalledPlugin(state.plugin);
    if (state.active) assertInstalledPlugin(state.active);
    this.db
      .prepare(
        `INSERT INTO plugin_states (plugin_id, plugin_json, active_json)
         VALUES (?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           plugin_json = excluded.plugin_json,
           active_json = excluded.active_json`,
      )
      .run(
        state.plugin.id,
        JSON.stringify(state.plugin),
        state.active ? JSON.stringify(state.active) : null,
      );
  }

  private assertLegalTransition(
    current: ExecutionRow,
    nextState: ExecutionState,
  ): void {
    if (!isExecutionState(current.state)) {
      throw new TypeError(
        `Stored execution ${current.execution_id} has invalid state ${current.state}`,
      );
    }
    if (!LEGAL_TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(
        `Cannot transition execution ${current.execution_id} from ${current.state} to ${nextState}`,
      );
    }
  }

  private transitionRow(
    current: ExecutionRow,
    nextState: ExecutionState,
    payload?: Record<string, unknown>,
  ): ClientEvent {
    const occurredAt = now();
    const event: ClientEvent = {
      executionId: current.execution_id,
      eventSeq: current.last_event_seq + 1,
      type: nextState as ClientEventType,
      occurredAt,
    };
    if (payload) event.payload = payload;

    this.db
      .prepare(
        `UPDATE executions
         SET state = ?, updated_at = ?, last_event_seq = ?
         WHERE execution_id = ?`,
      )
      .run(nextState, occurredAt, event.eventSeq, current.execution_id);
    this.insertOutboxEvent(event);
    return event;
  }

  private insertOutboxEvent(event: ClientEvent): void {
    this.db
      .prepare(
        `INSERT INTO outbox (execution_id, event_seq, event_json)
         VALUES (?, ?, ?)`,
      )
      .run(event.executionId, event.eventSeq, JSON.stringify(event));
  }

  private parseStoredEvent(eventJson: string): ClientEvent {
    const parsed = parseClientEventBatch({
      type: "event.push",
      events: [JSON.parse(eventJson)],
    });
    if (!parsed) {
      throw new TypeError("Stored outbox event is invalid");
    }
    return parsed[0]!;
  }

  private assertValidEvent(event: ClientEvent): void {
    if (
      !parseClientEventBatch({
        type: "event.push",
        events: [event],
      })
    ) {
      throw new TypeError("Cannot append an invalid client event");
    }
  }
}
