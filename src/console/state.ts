import type { ClientEvent } from "../protocol/index.js";
import type { HubObservation } from "./observable-store.js";

export const CONSOLE_EVENT_BUFFER_LIMIT = 500;
export const CONSOLE_OBSERVATION_BUFFER_LIMIT = 200;

export type ConsoleClientView = { clientId: string; lastSeen: number };
export type ConsoleSnapshot = {
  clients: ConsoleClientView[];
  events: ClientEvent[];
  observations: HubObservation[];
  serverTime: number;
};

export class ConsoleState {
  private readonly clients = new Map<string, ConsoleClientView>();
  private events: ClientEvent[] = [];
  private observations: HubObservation[] = [];
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
      serverTime: Date.now(),
    };
  }
}

function trim<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}
