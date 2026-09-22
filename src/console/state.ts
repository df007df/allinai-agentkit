import type { ClientEvent } from "../protocol/index.js";
import type { HubObservation } from "./observable-store.js";

export const CONSOLE_EVENT_BUFFER_LIMIT = 500;
export const CONSOLE_OBSERVATION_BUFFER_LIMIT = 200;

export type ConsoleClientView = { clientId: string; lastSeen: number };

/**
 * A tool approval still awaiting (or recently answered without a matching
 * offer) a human decision. Derived from hub observations so a reconnecting
 * console can redraw the card from the snapshot alone.
 */
export type ConsolePendingApproval = {
  clientId: string;
  executionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type ConsoleSnapshot = {
  clients: ConsoleClientView[];
  events: ClientEvent[];
  observations: HubObservation[];
  pendingApprovals: ConsolePendingApproval[];
  serverTime: number;
};

export class ConsoleState {
  private readonly clients = new Map<string, ConsoleClientView>();
  private events: ClientEvent[] = [];
  private observations: HubObservation[] = [];
  /**
   * Requested approvals keyed by requestId. This is deliberately separate
   * from the observation ring: the ring trims (heartbeats alone evict a card),
   * but a pending approval must survive until the matching human decision
   * flows back through the hub.
   */
  private readonly pendingApprovals = new Map<string, ConsolePendingApproval>();
  private readonly eventLimit: number;
  private readonly observationLimit: number;

  constructor(limits?: { events?: number; observations?: number }) {
    this.eventLimit = limits?.events ?? CONSOLE_EVENT_BUFFER_LIMIT;
    this.observationLimit = limits?.observations ?? CONSOLE_OBSERVATION_BUFFER_LIMIT;
  }

  apply(observation: HubObservation): void {
    switch (observation.kind) {
      case "client.registered":
      case "client.heartbeat":
        this.clients.set(observation.clientId, {
          clientId: observation.clientId,
          lastSeen: observation.at,
        });
        break;
      case "events.ingested":
        this.events = trim(
          [...this.events, ...observation.events.map((e) => ({ ...e }))],
          this.eventLimit,
        );
        break;
      case "tool_approval.requested":
        this.pendingApprovals.set(observation.approval.requestId, {
          clientId: observation.clientId,
          executionId: observation.approval.executionId,
          requestId: observation.approval.requestId,
          toolName: observation.approval.toolName,
          toolInput: observation.approval.toolInput,
        });
        break;
      case "offer.enqueued":
        if (
          observation.commandKind === "respond_tool_approval" &&
          observation.approvalRequestId
        ) {
          this.pendingApprovals.delete(observation.approvalRequestId);
        }
        break;
    }
    this.observations = trim([...this.observations, observation], this.observationLimit);
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  snapshot(): ConsoleSnapshot {
    return {
      clients: [...this.clients.values()],
      events: [...this.events].sort(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) || a.eventSeq - b.eventSeq,
      ),
      observations: [...this.observations],
      pendingApprovals: [...this.pendingApprovals.values()],
      serverTime: Date.now(),
    };
  }
}

function trim<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}
