import { bridgeLog } from "../logger.js";
import {
  encodeClientEventBatch,
  encodeClientHello,
  encodePluginSyncAcknowledgement,
  parseHubDownlink,
  parseHubEventAcknowledgement,
  type ClientEvent,
  type PluginSyncAcknowledgement,
} from "../protocol/index.js";
import type { ClientTransport, ClientTransportHandlers } from "./transport.js";
import { AgentClientConfigurationError } from "./types.js";

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_PATH_PREFIX = "/api/agent-hub/v2";
const WS_OPEN = 1;

export type ClientWebSocketLike = {
  readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  send(data: string): void;
  close(): void;
};

export type WsClientTransportOptions = {
  hubBaseUrl: string;
  /** Host-owned Hub route; defaults to the protocol-v2 Hub endpoint. */
  pathPrefix?: string;
  token: string;
  clientId: string;
  WebSocketImpl?: new (url: string) => ClientWebSocketLike;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

type PendingAcknowledgement = {
  resolve(watermarks: Record<string, number>): void;
  reject(error: Error): void;
};

function normalizePathPrefix(pathPrefix?: string): string {
  const raw = pathPrefix ?? DEFAULT_PATH_PREFIX;
  const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (
    !normalized ||
    !normalized.startsWith("/") ||
    /[?#\\\s]/.test(normalized) ||
    new URL(normalized, "http://hub.invalid").pathname !== normalized
  ) {
    throw new AgentClientConfigurationError(
      "pathPrefix must be an absolute path without query, fragment, whitespace, or a trailing slash",
    );
  }
  return normalized;
}

function toWebSocketUrl(
  hubBaseUrl: string,
  pathPrefix: string,
  token: string,
): string {
  const url = new URL(new URL(hubBaseUrl).origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${pathPrefix}/ws`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function reconnectDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
}

/**
 * WebSocket transport for the protocol-v2 Client Core. It has no execution
 * policy or state: the supervisor owns those durable concerns. A reconnect
 * can replay the same offer and the state store will safely de-duplicate it.
 */
export class WsClientTransport implements ClientTransport {
  private readonly WebSocketImpl: new (url: string) => ClientWebSocketLike;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly pathPrefix: string;
  private handlers: ClientTransportHandlers | null = null;
  private socket: ClientWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private pendingAcknowledgement: PendingAcknowledgement | null = null;
  private pushTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: WsClientTransportOptions) {
    this.pathPrefix = normalizePathPrefix(options.pathPrefix);
    const implementation =
      options.WebSocketImpl ??
      (globalThis.WebSocket as unknown as
        | (new (url: string) => ClientWebSocketLike)
        | undefined);
    if (!implementation) {
      throw new Error("WebSocket is unavailable; provide WebSocketImpl");
    }
    this.WebSocketImpl = implementation;
    this.reconnectBaseMs = Math.max(
      1,
      options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
    );
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
    );
  }

  async connect(handlers: ClientTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    this.connectSocket();
  }

  async push(events: ClientEvent[]): Promise<Record<string, number>> {
    const task = this.pushTail.then(() => this.pushOne(events));
    this.pushTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async reportPluginSync(
    acknowledgement: PluginSyncAcknowledgement,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new Error("Hub WebSocket is not connected");
    }
    socket.send(
      JSON.stringify(encodePluginSyncAcknowledgement(acknowledgement)),
    );
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.rejectPendingAcknowledgement(new Error("WebSocket transport closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // A partially-open socket can throw during shutdown; it is already detached.
      }
    }
  }

  private connectSocket(): void {
    if (this.stopped || this.socket) return;
    this.clearReconnect();

    let socket: ClientWebSocketLike;
    try {
      socket = new this.WebSocketImpl(
        toWebSocketUrl(
          this.options.hubBaseUrl,
          this.pathPrefix,
          this.options.token,
        ),
      );
    } catch (error) {
      bridgeLog.warn("client-ws", "Hub connection could not start", {
        error: String(error),
      });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      try {
        socket.send(JSON.stringify(encodeClientHello(this.options.clientId)));
        this.reconnectAttempt = 0;
        void this.notifyConnected();
      } catch (error) {
        bridgeLog.warn("client-ws", "Hub hello failed", {
          error: String(error),
        });
        this.closeSocket(socket);
      }
    };
    socket.onmessage = (event) => {
      void this.consumeMessage(event.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.rejectPendingAcknowledgement(
        new Error("Hub WebSocket disconnected"),
      );
      this.scheduleReconnect();
    };
    socket.onerror = () => this.closeSocket(socket);
  }

  private async notifyConnected(): Promise<void> {
    try {
      await this.handlers?.connected();
    } catch (error) {
      bridgeLog.warn("client-ws", "Connected callback failed", {
        error: String(error),
      });
    }
  }

  private async consumeMessage(raw: unknown): Promise<void> {
    const parsed = this.parseMessage(raw);
    if (!parsed) return;

    const acknowledgement = parseHubEventAcknowledgement(parsed);
    if (acknowledgement) {
      const pending = this.pendingAcknowledgement;
      this.pendingAcknowledgement = null;
      pending?.resolve(acknowledgement.watermarks);
      return;
    }

    const downlink = parseHubDownlink(parsed);
    if (!downlink || !this.handlers) return;
    try {
      if (downlink.type === "task.offer") {
        await this.handlers.command(downlink.command);
      } else {
        await this.handlers.pluginSync?.({
          revision: downlink.revision,
          plugins: downlink.plugins,
        });
      }
    } catch (error) {
      bridgeLog.warn("client-ws", "Hub downlink handler failed", {
        type: downlink.type,
        error: String(error),
      });
    }
  }

  private parseMessage(raw: unknown): unknown | null {
    try {
      if (typeof raw === "string") return JSON.parse(raw) as unknown;
      if (raw instanceof ArrayBuffer) {
        return JSON.parse(new TextDecoder().decode(raw)) as unknown;
      }
      if (ArrayBuffer.isView(raw)) {
        return JSON.parse(
          Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
            "utf8",
          ),
        ) as unknown;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async pushOne(
    events: ClientEvent[],
  ): Promise<Record<string, number>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new Error("Hub WebSocket is not connected");
    }
    if (this.pendingAcknowledgement) {
      throw new Error("Event acknowledgement is already pending");
    }

    const payload = JSON.stringify(encodeClientEventBatch(events));
    return new Promise<Record<string, number>>((resolve, reject) => {
      this.pendingAcknowledgement = { resolve, reject };
      try {
        socket.send(payload);
      } catch (error) {
        this.rejectPendingAcknowledgement(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  private closeSocket(socket: ClientWebSocketLike): void {
    try {
      socket.close();
    } catch {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.socket) return;
    const delay = reconnectDelay(
      this.reconnectAttempt,
      this.reconnectBaseMs,
      this.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectPendingAcknowledgement(error: Error): void {
    const pending = this.pendingAcknowledgement;
    this.pendingAcknowledgement = null;
    pending?.reject(error);
  }
}
