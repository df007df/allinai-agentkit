import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  parseClientCommand,
  parseClientEventBatch,
  parseClientHello,
  parseHubDownlink,
  parseHubEventAcknowledgement,
  parseInventoryReport,
  parsePluginSyncAcknowledgement,
  type InventoryReport,
  type PluginConfig,
} from "../protocol/index.js";
import { bridgeLog } from "../logger.js";
import { HUB_PATH_PREFIX } from "../routes.js";
import type {
  AgentHub,
  AgentHubOptions,
  HubAttachOptions,
  HubClientRecord,
  HubOfferInput,
  StoredOffer,
} from "./types.js";

type ConnectedSocket<Principal> = HubClientRecord & {
  principal: Principal;
  socket: WebSocket;
};

/** Protocol orchestration only: durable state and ownership belong to the host Store. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export function createAgentHub<Principal>(
  options: AgentHubOptions<Principal>,
): AgentHub<Principal> {
  const pathPrefix = options.pathPrefix ?? HUB_PATH_PREFIX;
  if (
    !pathPrefix.startsWith("/") ||
    pathPrefix.endsWith("/") ||
    /[?#\\\s]/.test(pathPrefix) ||
    new URL(pathPrefix, "http://hub.invalid").pathname !== pathPrefix
  ) {
    throw new TypeError(
      "pathPrefix must be an absolute path with no trailing slash, query or fragment",
    );
  }
  const wsPath = `${pathPrefix}/ws`;
  const store = options.store;
  // Keys are issued by the host; Principal stays opaque even for routing.
  const sockets = new Map<string, ConnectedSocket<Principal>>();
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  // Transport resources only; these sockets are not yet owned by WebSocketServer.
  const pendingUpgrades = new Set<Duplex>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 1_048_576,
  });
  let attached: Server | undefined;
  let attachOptions: HubAttachOptions = {};
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function url(request: IncomingMessage): URL | null {
    try {
      return new URL(request.url ?? "/", "http://hub.invalid");
    } catch {
      return null;
    }
  }

  async function authorize(
    request: IncomingMessage,
    requestUrl: URL,
  ): Promise<Principal | null> {
    const token =
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ??
      requestUrl.searchParams.get("token") ??
      "";
    try {
      return await options.authorize(token, request);
    } catch {
      return null;
    }
  }

  async function httpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const principal = await authorize(request, requestUrl);
    response.writeHead(principal === null ? 401 : 426, {
      "Content-Type": "application/json",
      ...(principal === null ? {} : { Upgrade: "websocket" }),
    });
    response.end(
      JSON.stringify({
        error: principal === null ? "unauthorized" : "websocket_required",
      }),
    );
  }

  function onRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = url(request);
    if (!requestUrl) {
      response.writeHead(400);
      response.end();
      return;
    }
    if (requestUrl.pathname !== wsPath) {
      if (attachOptions.fallback) attachOptions.fallback(request, response);
      else {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    void httpRequest(request, response, requestUrl);
  }

  function active(connection: ConnectedSocket<Principal>): boolean {
    return (
      !closed &&
      connection.socket.readyState === WebSocket.OPEN &&
      sockets.get(connection.connectionKey) === connection
    );
  }

  async function deliver(
    connection: ConnectedSocket<Principal>,
  ): Promise<void> {
    const offers = await store.listPendingOffers({
      principal: connection.principal,
      clientId: connection.clientId,
    });
    for (const offer of offers) {
      if (!active(connection)) return;
      if (
        offer.connectionKey !== connection.connectionKey ||
        offer.targetClientId !== connection.clientId
      ) {
        throw new Error("Store returned an offer for another connection");
      }
      const command = parseClientCommand(offer.command);
      if (!command) throw new Error("Store returned an invalid command");
      connection.socket.send(JSON.stringify({ type: "task.offer", command }));
    }
  }

  function connect(socket: WebSocket, principal: Principal): void {
    let connection: ConnectedSocket<Principal> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    // Only in-flight work is queued here; no event/offer history is retained.
    let tail = Promise.resolve();
    function queue(work: () => Promise<void>): void {
      tail = tail
        .then(async () => {
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          if (connection && !active(connection)) return;
          await work();
        })
        .catch(() => {
          socket.close(1011, "Hub store failure");
        });
    }
    socket.on("message", (raw: RawData) =>
      queue(async () => {
        let message: unknown;
        try {
          message = JSON.parse(
            (Array.isArray(raw)
              ? Buffer.concat(raw)
              : Buffer.from(raw as ArrayBuffer)
            ).toString("utf8"),
          );
        } catch {
          socket.close(1008, "invalid message");
          return;
        }
        if (!connection) {
          const hello = parseClientHello(message);
          if (!hello) {
            socket.close(1008, "client.hello required");
            return;
          }
          let record: HubClientRecord;
          try {
            record = await store.registerClient({
              principal,
              clientId: hello.clientId,
              protocolVersion: hello.protocolVersion,
              ...(hello.name ? { name: hello.name } : {}),
            });
          } catch {
            socket.close(1008, "client registration rejected");
            return;
          }
          if (
            record.clientId !== hello.clientId ||
            typeof record.connectionKey !== "string" ||
            !record.connectionKey.trim()
          ) {
            socket.close(1008, "client ownership conflict");
            return;
          }
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          const prior = sockets.get(record.connectionKey);
          if (prior && prior.clientId !== record.clientId) {
            socket.close(1008, "client ownership conflict");
            return;
          }
          connection = {
            clientId: record.clientId,
            connectionKey: record.connectionKey,
            principal,
            socket,
            ...(hello.name ? { name: hello.name } : {}),
          };
          sockets.set(record.connectionKey, connection);
          if (heartbeatIntervalMs > 0 && !keepaliveTimer) {
            // The Hub drives keepalive: clients on the WHATWG WebSocket (the
            // daemon's Node builtin) have no ping() call, but every compliant
            // implementation auto-pongs. Each pong refreshes the store
            // heartbeat, which keeps lastSeen live for console views.
            keepaliveTimer = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.ping();
            }, heartbeatIntervalMs);
            keepaliveTimer.unref?.();
          }
          prior?.socket.close(1000, "superseded connection");
          await deliver(connection);
          if (options.onClientRegistered) {
            try {
              await options.onClientRegistered({
                principal,
                clientId: record.clientId,
                connectionKey: record.connectionKey,
              });
            } catch (error) {
              // A failing level-up hook must not take the connection down;
              // the client still functions with its current plugins.
              bridgeLog.warn("agent-hub", "onClientRegistered hook failed", {
                clientId: record.clientId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return;
        }
        const acknowledgement = parsePluginSyncAcknowledgement(message);
        if (acknowledgement) {
          await store.acknowledgePluginSync({
            principal,
            clientId: connection.clientId,
            acknowledgement,
          });
          return;
        }
        const inventory = parseInventoryReport(message);
        if (inventory) {
          await store.recordInventory({
            principal,
            clientId: connection.clientId,
            report: inventory,
          });
          return;
        }
        const events = parseClientEventBatch(message);
        if (!events) {
          // Forward compatibility: a newer client may send message types this
          // Hub does not know. Dropping the socket would break mixed-version
          // fleets, so unknown frames are logged and ignored.
          bridgeLog.warn("agent-hub", "Ignoring unknown client message", {
            type: (message as Record<string, unknown>).type,
          });
          return;
        }
        const watermarks = await store.ingestEvents({
          principal,
          clientId: connection.clientId,
          events,
        });
        const ack = parseHubEventAcknowledgement({
          type: "event.ack",
          watermarks,
        });
        if (!ack) throw new Error("Store returned invalid event watermarks");
        if (active(connection)) socket.send(JSON.stringify(ack));
      }),
    );
    // v2 has no JSON heartbeat frame. WS control frames preserve its wire contract.
    function heartbeat(): void {
      queue(async () => {
        if (!connection) {
          socket.close(1008, "client.hello required");
          return;
        }
        await store.heartbeat({
          principal,
          clientId: connection.clientId,
          ...(connection.name ? { name: connection.name } : {}),
        });
      });
    }
    socket.on("ping", heartbeat);
    socket.on("pong", heartbeat);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (connection && sockets.get(connection.connectionKey) === connection)
        sockets.delete(connection.connectionKey);
    });
  }

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    requestUrl: URL,
  ): Promise<void> {
    const principal = await authorize(request, requestUrl);
    if (closed || socket.destroyed) {
      socket.destroy();
      return;
    }
    if (principal === null) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws, principal));
  }

  function onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const requestUrl = url(request);
    if (!requestUrl) {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== wsPath) {
      if (attachOptions.onUnknownUpgrade) {
        attachOptions.onUnknownUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
      return;
    }
    pendingUpgrades.add(socket);
    const forget = () => {
      pendingUpgrades.delete(socket);
    };
    const failed = () => {
      socket.destroy();
    };
    socket.once("close", forget);
    socket.once("error", failed);
    void upgrade(request, socket, head, requestUrl)
      .catch(() => socket.destroy())
      .finally(() => {
        pendingUpgrades.delete(socket);
        socket.off("close", forget);
        socket.off("error", failed);
      });
  }

  return {
    attach(server, opts = {}) {
      if (closed || attached)
        throw new Error("AgentHub can only attach once before close");
      attached = server;
      attachOptions = opts;
      server.on("request", onRequest);
      server.on("upgrade", onUpgrade);
    },
    async offer(input: HubOfferInput<Principal>): Promise<StoredOffer> {
      if (closed) throw new Error("AgentHub is closed");
      const command = parseClientCommand(input.command);
      if (!command || !input.targetClientId.trim())
        throw new TypeError("Invalid offer");
      const stored = await store.enqueueOffer({
        principal: input.principal,
        targetClientId: input.targetClientId,
        command,
      });
      const connection = sockets.get(stored.connectionKey);
      if (connection && active(connection)) {
        try {
          await deliver(connection);
        } catch {
          connection.socket.close(1011, "Hub store failure");
        }
      }
      return stored;
    },
    syncPlugins(input: {
      principal: Principal;
      targetClientId: string;
      revision: string;
      plugins: PluginConfig[];
      inventoryQuery?: boolean;
    }): Promise<{ delivered: boolean }> {
      if (closed) throw new Error("AgentHub is closed");
      if (!input.targetClientId.trim() || !input.revision.trim()) {
        throw new TypeError("Invalid plugin sync");
      }
      // Protocol round-trip keeps the desired state wire-shaped.
      const downlink = parseHubDownlink({
        type: "plugin.sync",
        revision: input.revision,
        plugins: input.plugins,
        ...(input.inventoryQuery ? { inventoryQuery: true } : {}),
      });
      if (!downlink || downlink.type !== "plugin.sync") {
        throw new TypeError("Invalid plugin sync");
      }
      let connected: ConnectedSocket<Principal> | null = null;
      for (const connection of sockets.values()) {
        if (
          connection.clientId === input.targetClientId &&
          Object.is(connection.principal, input.principal)
        ) {
          connected = connection;
          break;
        }
      }
      if (!connected || !active(connected)) return Promise.resolve({ delivered: false });
      connected.socket.send(JSON.stringify(downlink));
      return Promise.resolve({ delivered: true });
    },
    getInventory(input: {
      principal: Principal;
      clientId: string;
    }): Promise<InventoryReport | null> {
      // Ownership validation lives in the store, consistent with recordInventory.
      return store.getInventory(input);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      attached?.off("request", onRequest);
      attached?.off("upgrade", onUpgrade);
      for (const socket of pendingUpgrades) socket.destroy();
      pendingUpgrades.clear();
      for (const socket of wss.clients) socket.terminate();
      sockets.clear();
      closePromise = new Promise<void>((resolve) => wss.close(() => resolve()));
      return closePromise;
    },
  };
}
