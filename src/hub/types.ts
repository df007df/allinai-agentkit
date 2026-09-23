import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  ClientCommand,
  ClientEventBatch,
  ClientHello,
  HubEventAcknowledgement,
  InventoryReport,
  PluginConfig,
  PluginSyncAcknowledgement,
} from "../protocol/index.js";

/** Principal is opaque: the Hub never serializes it or derives it from client input. */
export type HubAuthorizer<Principal> = (
  token: string,
  request: IncomingMessage,
) => Promise<Principal | null>;
export interface HubClientRegistration<Principal> {
  principal: Principal;
  clientId: ClientHello["clientId"];
  protocolVersion: ClientHello["protocolVersion"];
  /** Optional display name from client.hello; absent means "show clientId". */
  name?: ClientHello["name"];
}
export interface HubClientRecord {
  clientId: string;
  /** Latest display name reported by the client, when it provided one. */
  name?: string;
  /** Host-issued stable opaque key, unique per authorized owner/client pair. Never on wire. */
  connectionKey: string;
}
export interface HubHeartbeat<Principal> {
  principal: Principal;
  clientId: string;
  name?: string;
}
export interface HubOfferInput<Principal> {
  principal: Principal;
  targetClientId: string;
  command: ClientCommand;
}
export interface StoredOffer {
  offerId: string;
  targetClientId: string;
  /** Must match the target's registerClient key. Never on wire. */
  connectionKey: string;
  command: ClientCommand;
}
export interface HubOfferDelivery<Principal> {
  principal: Principal;
  clientId: string;
}
export interface HubEventBatch<Principal> {
  principal: Principal;
  clientId: string;
  events: ClientEventBatch["events"];
}
export type HubEventIngestResult = HubEventAcknowledgement["watermarks"];
export interface HubPluginAcknowledgement<Principal> {
  principal: Principal;
  clientId: string;
  acknowledgement: PluginSyncAcknowledgement;
}
export interface HubInventoryReport<Principal> {
  principal: Principal;
  clientId: string;
  report: InventoryReport;
}

/**
 * All methods enforce host-owned authorization for principal/clientId.
 * registerClient must reject ownership conflicts, even without a live socket.
 * connectionKey stays stable across registration and enqueueOffer; the Hub
 * cannot compare opaque principals to establish ownership.
 */
export interface HubStore<Principal> {
  registerClient(
    input: HubClientRegistration<Principal>,
  ): Promise<HubClientRecord>;
  heartbeat(input: HubHeartbeat<Principal>): Promise<void>;
  /** Return only authorized unacknowledged offers, in durable delivery order. */
  listPendingOffers(input: HubOfferDelivery<Principal>): Promise<StoredOffer[]>;
  /** Commit before resolving and deduplicate immutable command identities. */
  enqueueOffer(input: HubOfferInput<Principal>): Promise<StoredOffer>;
  /**
   * Deduplicate (executionId,eventSeq), persist events, return contiguous stored
   * watermarks. Retire run offers on received, cancel offers on terminal events.
   * Never acknowledge events before durable commit.
   */
  ingestEvents(input: HubEventBatch<Principal>): Promise<HubEventIngestResult>;
  acknowledgePluginSync(
    input: HubPluginAcknowledgement<Principal>,
  ): Promise<void>;
  /** Persist the latest inventory report; ownership must be enforced here. */
  recordInventory(input: HubInventoryReport<Principal>): Promise<void>;
  /** Return the client's latest report, or null when the store has none. */
  getInventory(input: {
    principal: Principal;
    clientId: string;
  }): Promise<InventoryReport | null>;
}
export interface AgentHubOptions<Principal> {
  authorize: HubAuthorizer<Principal>;
  store: HubStore<Principal>;
  /** Default /_agentkit/hub/v2; absolute path without trailing slash. */
  pathPrefix?: string;
  maxPayloadBytes?: number;
}
export interface HubAttachOptions {
  /** Supply the application's handler; attach to a server without request handlers. */
  fallback?: (request: IncomingMessage, response: ServerResponse) => void;
  onUnknownUpgrade?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
}
export interface AgentHub<Principal> {
  /** Attach once; the caller owns listen() and closing the HTTP server. */
  attach(server: Server, options?: HubAttachOptions): void;
  offer(input: HubOfferInput<Principal>): Promise<StoredOffer>;
  /**
   * Push desired plugin state to a connected client. Offline or unknown
   * clients reject; hosts re-push on the client's next registration.
   */
  syncPlugins(input: {
    principal: Principal;
    targetClientId: string;
    revision: string;
    plugins: PluginConfig[];
    /** Ask the client to answer with an inventory.report. */
    inventoryQuery?: boolean;
  }): Promise<{ delivered: boolean }>;
  /** Latest inventory report for a client; ownership is enforced in the store. */
  getInventory(input: {
    principal: Principal;
    clientId: string;
  }): Promise<InventoryReport | null>;
  /** Detach handlers and close Hub sockets without closing the caller's server. */
  close(): Promise<void>;
}
