import type {
  ClientEvent,
  InventoryReport,
  PluginSyncAcknowledgement,
} from "../../protocol/index.js";
import { bridgeLog } from "../../logger.js";
import type {
  HubClientRecord,
  HubClientRegistration,
  HubEventBatch,
  HubEventIngestResult,
  HubHeartbeat,
  HubInventoryReport,
  HubOfferDelivery,
  HubOfferInput,
  HubPluginAcknowledgement,
  HubStore,
  StoredOffer,
} from "../types.js";

type MemoryClient<Principal> = HubClientRecord & {
  principal: Principal;
  protocolVersion: number;
  lastSeen: number;
};

type MemoryOffer<Principal> = StoredOffer & { principal: Principal };

export type MemoryHubSnapshot<Principal> = {
  /** Test-only process memory. It is intentionally lost on process restart. */
  clients: Array<MemoryClient<Principal>>;
  offers: Array<MemoryOffer<Principal>>;
  events: ClientEvent[];
  seenEventSequences: Array<[string, number[]]>;
  watermarks: Record<string, number>;
  inventory: Array<[string, InventoryReport]>;
  nextConnectionKey: number;
};

export type MemoryHubClient = Omit<MemoryClient<unknown>, "principal"> & {
  pendingOutboxCount: number;
};

const TERMINAL_EVENT_TYPES = new Set([
  "done",
  "failed",
  "cancelled",
  "recovery_required",
  "rejected",
]);

/**
 * A deliberately volatile HubStore adapter for protocol tests only.
 *
 * Registrations, offers, events, and acknowledgement state are held in Maps
 * and arrays, so a process restart loses all of them. Production hosts must
 * implement HubStore with their own durable storage.
 */
export class MemoryHubStore<Principal> implements HubStore<Principal> {
  private readonly clients = new Map<string, MemoryClient<Principal>>();
  private offers: Array<MemoryOffer<Principal>> = [];
  private readonly events = new Map<string, ClientEvent>();
  private readonly seenEventSequences = new Map<string, Set<number>>();
  private readonly watermarks = new Map<string, number>();
  private readonly inventory = new Map<string, InventoryReport>();
  private nextConnectionKey = 1;

  constructor(
    private readonly onPluginSyncAcknowledgement?: (
      clientId: string,
      acknowledgement: PluginSyncAcknowledgement,
    ) => void,
  ) {}

  async registerClient(
    input: HubClientRegistration<Principal>,
  ): Promise<HubClientRecord> {
    const existing = this.clients.get(input.clientId);
    if (existing && !Object.is(existing.principal, input.principal)) {
      throw new Error("client ownership conflict");
    }
    const client = existing ?? {
      clientId: input.clientId,
      connectionKey: `memory:${this.nextConnectionKey++}:${input.clientId}`,
      principal: input.principal,
      protocolVersion: input.protocolVersion,
      lastSeen: Date.now(),
    };
    client.protocolVersion = input.protocolVersion;
    client.lastSeen = Date.now();
    this.clients.set(input.clientId, client);
    bridgeLog.info("memory-hub", "test client registered", {
      clientId: input.clientId,
    });
    return { clientId: client.clientId, connectionKey: client.connectionKey };
  }

  async heartbeat(input: HubHeartbeat<Principal>): Promise<void> {
    const client = this.assertClient(input.principal, input.clientId);
    client.lastSeen = Date.now();
  }

  async listPendingOffers(
    input: HubOfferDelivery<Principal>,
  ): Promise<StoredOffer[]> {
    const client = this.assertClient(input.principal, input.clientId);
    return this.offers
      .filter(
        (offer) =>
          offer.connectionKey === client.connectionKey &&
          Object.is(offer.principal, input.principal),
      )
      .map(({ principal: _principal, ...offer }) => offer);
  }

  async enqueueOffer(input: HubOfferInput<Principal>): Promise<StoredOffer> {
    const client = this.ensureClient(input.principal, input.targetClientId);
    const duplicate = this.offers.find(
      (offer) =>
        offer.connectionKey === client.connectionKey &&
        offer.command.commandId === input.command.commandId,
    );
    if (duplicate) return this.publicOffer(duplicate);
    const offer: MemoryOffer<Principal> = {
      offerId: input.command.commandId,
      targetClientId: input.targetClientId,
      connectionKey: client.connectionKey,
      command: input.command,
      principal: input.principal,
    };
    this.offers.push(offer);
    return this.publicOffer(offer);
  }

  async ingestEvents(
    input: HubEventBatch<Principal>,
  ): Promise<HubEventIngestResult> {
    this.assertClient(input.principal, input.clientId);
    const result: HubEventIngestResult = {};
    for (const event of input.events) {
      const seen = this.seenEventSequences.get(event.executionId) ?? new Set();
      this.seenEventSequences.set(event.executionId, seen);
      const key = `${event.executionId}:${event.eventSeq}`;
      if (!seen.has(event.eventSeq)) {
        seen.add(event.eventSeq);
        this.events.set(key, event);
      }
      let watermark = this.watermarks.get(event.executionId) ?? 0;
      while (seen.has(watermark + 1)) watermark += 1;
      this.watermarks.set(event.executionId, watermark);
      result[event.executionId] = watermark;
      if (event.eventSeq <= watermark && event.type === "received") {
        this.offers = this.offers.filter(
          (offer) =>
            !(
              offer.connectionKey === this.clientKey(input.clientId) &&
              offer.command.executionId === event.executionId &&
              offer.command.kind !== "cancel"
            ),
        );
      }
      if (event.eventSeq <= watermark && TERMINAL_EVENT_TYPES.has(event.type)) {
        this.offers = this.offers.filter(
          (offer) =>
            !(
              offer.connectionKey === this.clientKey(input.clientId) &&
              offer.command.executionId === event.executionId &&
              offer.command.kind === "cancel"
            ),
        );
      }
    }
    return result;
  }

  async acknowledgePluginSync(
    input: HubPluginAcknowledgement<Principal>,
  ): Promise<void> {
    this.assertClient(input.principal, input.clientId);
    this.onPluginSyncAcknowledgement?.(input.clientId, input.acknowledgement);
  }

  async recordInventory(
    input: HubInventoryReport<Principal>,
  ): Promise<void> {
    this.assertClient(input.principal, input.clientId);
    this.inventory.set(input.clientId, input.report);
    bridgeLog.info("memory-hub", "test inventory recorded", {
      clientId: input.clientId,
    });
  }

  async getInventory(input: {
    principal: Principal;
    clientId: string;
  }): Promise<InventoryReport | null> {
    this.assertClient(input.principal, input.clientId);
    return this.inventory.get(input.clientId) ?? null;
  }

  listClients(): MemoryHubClient[] {
    return [...this.clients.values()].map(
      ({ principal: _principal, ...client }) => ({
        ...client,
        pendingOutboxCount: this.offers.filter(
          (offer) => offer.connectionKey === client.connectionKey,
        ).length,
      }),
    );
  }

  listEvents(executionId?: string): ClientEvent[] {
    return [...this.events.values()].filter(
      (event) => !executionId || event.executionId === executionId,
    );
  }

  snapshot(): MemoryHubSnapshot<Principal> {
    return {
      clients: [...this.clients.values()].map((client) => ({ ...client })),
      offers: this.offers.map((offer) => ({ ...offer })),
      events: this.listEvents().map((event) => ({ ...event })),
      seenEventSequences: [...this.seenEventSequences.entries()].map(
        ([executionId, sequences]) => [executionId, [...sequences]],
      ),
      watermarks: Object.fromEntries(this.watermarks),
      inventory: [...this.inventory.entries()].map(
        ([clientId, report]) => [clientId, { ...report }] as const,
      ),
      nextConnectionKey: this.nextConnectionKey,
    };
  }

  restore(snapshot: MemoryHubSnapshot<Principal>): void {
    this.clients.clear();
    snapshot.clients.forEach((client) =>
      this.clients.set(client.clientId, { ...client }),
    );
    this.offers = snapshot.offers.map((offer) => ({ ...offer }));
    this.events.clear();
    snapshot.events.forEach((event) =>
      this.events.set(`${event.executionId}:${event.eventSeq}`, { ...event }),
    );
    this.seenEventSequences.clear();
    snapshot.seenEventSequences.forEach(([executionId, sequences]) =>
      this.seenEventSequences.set(executionId, new Set(sequences)),
    );
    this.watermarks.clear();
    Object.entries(snapshot.watermarks).forEach(([executionId, watermark]) =>
      this.watermarks.set(executionId, watermark),
    );
    this.inventory.clear();
    snapshot.inventory.forEach(([clientId, report]) =>
      this.inventory.set(clientId, { ...report }),
    );
    this.nextConnectionKey = snapshot.nextConnectionKey;
  }

  private ensureClient(
    principal: Principal,
    clientId: string,
  ): MemoryClient<Principal> {
    const existing = this.clients.get(clientId);
    if (existing) {
      if (!Object.is(existing.principal, principal))
        throw new Error("client ownership conflict");
      return existing;
    }
    const client: MemoryClient<Principal> = {
      clientId,
      connectionKey: `memory:${this.nextConnectionKey++}:${clientId}`,
      principal,
      protocolVersion: 2,
      lastSeen: Date.now(),
    };
    this.clients.set(clientId, client);
    return client;
  }

  private assertClient(
    principal: Principal,
    clientId: string,
  ): MemoryClient<Principal> {
    const client = this.clients.get(clientId);
    if (!client || !Object.is(client.principal, principal))
      throw new Error("client ownership conflict");
    return client;
  }

  private clientKey(clientId: string): string {
    const client = this.clients.get(clientId);
    if (!client) throw new Error("unknown client");
    return client.connectionKey;
  }

  private publicOffer({
    principal: _principal,
    ...offer
  }: MemoryOffer<Principal>): StoredOffer {
    return offer;
  }
}
