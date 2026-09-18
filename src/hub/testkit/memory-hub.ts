import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createAgentHub } from "../agent-hub.js";
import type { AgentHub, AgentHubOptions, HubAuthorizer } from "../types.js";
import { MemoryHubStore, type MemoryHubSnapshot } from "./memory-store.js";

export type CreateMemoryHubOptions<Principal = string> = Omit<
  Partial<AgentHubOptions<Principal>>,
  "store" | "authorize"
> & {
  /** Test-only default credential; generated when omitted. */
  token?: string;
  /** Test-only shorthand that maps an accepted token to that string principal. */
  authorizeToken?: (
    candidate: string,
    request: IncomingMessage,
  ) => boolean | Promise<boolean>;
  authorize?: HubAuthorizer<Principal>;
  onPluginSyncAcknowledgement?: (
    clientId: string,
    acknowledgement: import("../../protocol/index.js").PluginSyncAcknowledgement,
  ) => void;
};

export type MemoryHub<Principal> = AgentHub<Principal> & {
  /** Test-only, volatile adapter; process restart loses every stored value. */
  readonly store: MemoryHubStore<Principal>;
  readonly token: string;
  listClients: () => ReturnType<MemoryHubStore<Principal>["listClients"]>;
  listEvents: (
    executionId?: string,
  ) => ReturnType<MemoryHubStore<Principal>["listEvents"]>;
  snapshot: () => MemoryHubSnapshot<Principal>;
  restore: (snapshot: MemoryHubSnapshot<Principal>) => void;
};

/** @internal Test-only Hub composition. It never owns or starts an HTTP listener. */
export function createMemoryHub<Principal = string>(
  options: CreateMemoryHubOptions<Principal> = {},
): MemoryHub<Principal> {
  const token = options.token ?? `memory-hub-${randomUUID()}`;
  const store = new MemoryHubStore<Principal>(
    options.onPluginSyncAcknowledgement,
  );
  const authorize: HubAuthorizer<Principal> =
    options.authorize ??
    (async (candidate, request) => {
      if (options.authorizeToken) {
        return (await options.authorizeToken(candidate, request))
          ? (candidate as Principal)
          : null;
      }
      return candidate === token ? (candidate as Principal) : null;
    });
  const hub = createAgentHub({
    authorize,
    store,
    pathPrefix: options.pathPrefix,
    maxPayloadBytes: options.maxPayloadBytes,
  });
  return {
    ...hub,
    token,
    store,
    listClients: () => store.listClients(),
    listEvents: (executionId) => store.listEvents(executionId),
    snapshot: () => store.snapshot(),
    restore: (snapshot) => store.restore(snapshot),
  };
}
