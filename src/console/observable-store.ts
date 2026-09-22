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
} from "../hub/index.js";
import type { ClientEvent } from "../protocol/index.js";

/** A tool-approval request surfaced from a progress event, for approver UIs. */
export type ToolApprovalObservation = {
  executionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type HubObservation =
  | { kind: "client.registered"; clientId: string; at: number }
  | { kind: "client.heartbeat"; clientId: string; at: number }
  | { kind: "offer.enqueued"; offerId: string; targetClientId: string; commandKind: string; at: number }
  | { kind: "offers.delivered"; clientId: string; count: number; at: number }
  | { kind: "events.ingested"; clientId: string; count: number; at: number; events: ClientEvent[] }
  | { kind: "plugin.acknowledged"; clientId: string; at: number }
  | { kind: "inventory.recorded"; clientId: string; at: number }
  | {
      kind: "tool_approval.requested";
      clientId: string;
      approval: ToolApprovalObservation;
      at: number;
    };

export type HubObservationSink = (observation: HubObservation) => void;

/** Read-only transparent wrapper: forwards first, notifies second, and a
 * throwing sink must never change store semantics. */
export class ObservableStore<Principal> implements HubStore<Principal> {
  constructor(
    private readonly inner: HubStore<Principal>,
    private readonly sink: HubObservationSink,
  ) {}

  private notify(observation: HubObservation): void {
    try {
      this.sink(observation);
    } catch {
      // Observations are a display-only side channel.
    }
  }

  async registerClient(
    input: HubClientRegistration<Principal>,
  ): Promise<HubClientRecord> {
    const record = await this.inner.registerClient(input);
    this.notify({
      kind: "client.registered",
      clientId: input.clientId,
      at: Date.now(),
    });
    return record;
  }

  async heartbeat(input: HubHeartbeat<Principal>): Promise<void> {
    await this.inner.heartbeat(input);
    this.notify({
      kind: "client.heartbeat",
      clientId: input.clientId,
      at: Date.now(),
    });
  }

  async listPendingOffers(
    input: HubOfferDelivery<Principal>,
  ): Promise<StoredOffer[]> {
    const offers = await this.inner.listPendingOffers(input);
    if (offers.length > 0) {
      this.notify({
        kind: "offers.delivered",
        clientId: input.clientId,
        count: offers.length,
        at: Date.now(),
      });
    }
    return offers;
  }

  async enqueueOffer(
    input: HubOfferInput<Principal>,
  ): Promise<StoredOffer> {
    const offer = await this.inner.enqueueOffer(input);
    this.notify({
      kind: "offer.enqueued",
      offerId: offer.offerId,
      targetClientId: input.targetClientId,
      commandKind: input.command.kind,
      at: Date.now(),
    });
    return offer;
  }

  async ingestEvents(
    input: HubEventBatch<Principal>,
  ): Promise<HubEventIngestResult> {
    const result = await this.inner.ingestEvents(input);
    this.notify({
      kind: "events.ingested",
      clientId: input.clientId,
      count: input.events.length,
      at: Date.now(),
      events: [...input.events],
    });
    // Surface tool-approval asks so an approver UI can act without polling.
    for (const event of input.events) {
      const approval = event.payload?.toolApproval as
        | ToolApprovalObservation
        | undefined;
      if (event.type === "progress" && approval) {
        this.notify({
          kind: "tool_approval.requested",
          clientId: input.clientId,
          approval: {
            executionId: event.executionId,
            requestId: String(approval.requestId),
            toolName: String(approval.toolName),
            toolInput:
              approval.toolInput &&
              typeof approval.toolInput === "object" &&
              !Array.isArray(approval.toolInput)
                ? (approval.toolInput as Record<string, unknown>)
                : {},
          },
          at: Date.now(),
        });
      }
    }
    return result;
  }

  async acknowledgePluginSync(
    input: HubPluginAcknowledgement<Principal>,
  ): Promise<void> {
    await this.inner.acknowledgePluginSync(input);
    this.notify({
      kind: "plugin.acknowledged",
      clientId: input.clientId,
      at: Date.now(),
    });
  }

  async recordInventory(
    input: HubInventoryReport<Principal>,
  ): Promise<void> {
    await this.inner.recordInventory(input);
    this.notify({
      kind: "inventory.recorded",
      clientId: input.clientId,
      at: Date.now(),
    });
  }

  async getInventory(input: {
    principal: Principal;
    clientId: string;
  }) {
    return this.inner.getInventory(input);
  }
}
