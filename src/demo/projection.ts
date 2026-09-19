import type { HubObservation } from "./observable-store.js";

export type DemoClientView = { clientId: string; lastSeen: number };

export type DemoPendingOfferView = {
  offerId: string;
  targetClientId: string;
  commandKind: string;
};

/** Display projection built purely from store observations. */
export class DemoProjection {
  private readonly clients = new Map<string, DemoClientView>();
  private pendingOffers: DemoPendingOfferView[] = [];

  apply(observation: HubObservation): void {
    switch (observation.kind) {
      case "client.registered":
      case "client.heartbeat":
        this.clients.set(observation.clientId, {
          clientId: observation.clientId,
          lastSeen: observation.at,
        });
        break;
      case "offer.enqueued":
        this.pendingOffers.push({
          offerId: observation.offerId,
          targetClientId: observation.targetClientId,
          commandKind: observation.commandKind,
        });
        break;
      case "offers.delivered": {
        // 显示近似：按投递数量移除该 client 最早的待投递 offer。
        let remaining = observation.count;
        this.pendingOffers =
          this.pendingOffers.filter((offer) =>
            offer.targetClientId === observation.clientId && remaining > 0
              ? (remaining -= 1, false)
              : true,
          );
        break;
      }
      default:
        // plugin.acknowledged / inventory.recorded 不改投影状态：它们已通过
        // startDemoSiteCore 的 sink 原样进入 SSE observation 广播（页面时间线）。
        break;
    }
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  snapshot(): {
    clients: DemoClientView[];
    pendingOffers: DemoPendingOfferView[];
    serverTime: number;
  } {
    return {
      clients: [...this.clients.values()],
      pendingOffers: [...this.pendingOffers],
      serverTime: Date.now(),
    };
  }
}
