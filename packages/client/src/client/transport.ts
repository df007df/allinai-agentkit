import type {
  ClientCommand,
  ClientEvent,
  InventoryReport,
  PluginConfig,
  PluginSyncAcknowledgement,
} from "./types.js";

export type ClientTransportHandlers = {
  command(command: ClientCommand): Promise<void>;
  /** Desired Git plugin state; the plugin host is added in a later task. */
  pluginSync?(input: {
    revision: string;
    plugins: PluginConfig[];
    /** Query-only downlink: report inventory and apply no side effects. */
    inventoryQuery: boolean;
  }): Promise<void>;
  connected(): Promise<void>;
};

/**
 * Connection boundary between the durable Client Core and a Hub protocol
 * implementation. Transports deliver at least once; the state store supplies
 * the local idempotency and the per-execution event outbox.
 */
export type ClientTransport = {
  connect(handlers: ClientTransportHandlers): Promise<void>;
  push(events: ClientEvent[]): Promise<Record<string, number>>;
  /** Optional while older Hubs ignore plugin desired-state acknowledgements. */
  reportPluginSync?(acknowledgement: PluginSyncAcknowledgement): Promise<void>;
  /** Optional while older Hubs tolerate missing inventory reports. */
  reportInventory?(report: InventoryReport): Promise<void>;
  close(): Promise<void>;
};

/** The isolated runtime runner port. It must never be used for capabilities. */
export type RunStarter = {
  start(command: Extract<ClientCommand, { kind: "agent.run" }>): Promise<void>;
  cancel(executionId: string): Promise<void>;
};
