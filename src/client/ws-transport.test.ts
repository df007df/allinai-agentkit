import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentClientConfigurationError } from "./types.js";
import { WsClientTransport, type ClientWebSocketLike } from "./ws-transport.js";
import type { ClientCommand, ClientEvent } from "./types.js";

function agentRun(
  executionId = "e1",
): Extract<ClientCommand, { kind: "agent.run" }> {
  return {
    kind: "agent.run",
    commandId: `command-${executionId}`,
    executionId,
    taskId: `task-${executionId}`,
    attempt: 1,
    runtime: "codex",
    payload: { prompt: "hello" },
  };
}

function event(executionId = "e1"): ClientEvent {
  return {
    executionId,
    eventSeq: 1,
    type: "received",
    occurredAt: "2026-09-18T00:00:00.000Z",
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("WsClientTransport", () => {
  it("sends hello, accepts only validated v2 frames, acks events, and reconnects", async () => {
    fakeSockets.splice(0, fakeSockets.length);
    const sockets = fakeSockets;
    const delivered: ClientCommand[] = [];
    const pluginRevisions: string[] = [];
    let connected = 0;

    const transport = new WsClientTransport({
      hubBaseUrl: "http://hub.example",
      token: "test-token",
      clientId: "client-a",
      WebSocketImpl: FakeWebSocket as unknown as new (
        url: string,
      ) => ClientWebSocketLike,
      reconnectBaseMs: 1,
      reconnectMaxMs: 4,
    });

    await transport.connect({
      command: async (command) => {
        delivered.push(command);
      },
      pluginSync: async ({ revision }) => {
        pluginRevisions.push(revision);
      },
      connected: async () => {
        connected += 1;
      },
    });
    await nextTurn();

    assert.equal(sockets.length, 1);
    assert.match(sockets[0]!.url, /\/api\/agent-hub\/v2\/ws/);
    assert.match(sockets[0]!.url, /token=test-token/);
    assert.deepEqual(
      sockets[0]!.sent.map((text) => JSON.parse(text)),
      [{ type: "client.hello", protocolVersion: 2, clientId: "client-a" }],
    );
    assert.equal(connected, 1);

    // Unknown traffic and malformed v2 data are ignored before reaching handlers.
    sockets[0]!.message({ type: "unrecognized.message" });
    sockets[0]!.message({
      type: "task.offer",
      command: { executionId: "missing-fields" },
    });
    await nextTurn();
    assert.equal(delivered.length, 0);

    sockets[0]!.message({ type: "task.offer", command: agentRun() });
    sockets[0]!.message({
      type: "plugin.sync",
      revision: "plugins-1",
      plugins: [
        { id: "acme", gitUrl: "https://example.test/acme.git", enabled: true },
      ],
    });
    await nextTurn();
    assert.equal(delivered[0]?.executionId, "e1");
    assert.deepEqual(pluginRevisions, ["plugins-1"]);

    const acknowledgement = transport.push([event()]);
    await nextTurn();
    assert.equal(JSON.parse(sockets[0]!.sent.at(-1)!).type, "event.push");
    sockets[0]!.message({ type: "event.ack", watermarks: { e1: 1 } });
    assert.deepEqual(await acknowledgement, { e1: 1 });

    await transport.reportPluginSync({
      type: "plugin.sync.ack",
      revision: "plugins-v1",
      status: "applied",
      plugins: [{ id: "acme", resolvedCommit: "a".repeat(40) }],
    });
    assert.deepEqual(JSON.parse(sockets[0]!.sent.at(-1)!), {
      type: "plugin.sync.ack",
      revision: "plugins-v1",
      status: "applied",
      plugins: [{ id: "acme", resolvedCommit: "a".repeat(40) }],
    });

    sockets[0]!.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 12));
    assert.ok(sockets.length >= 2);
    assert.ok(connected >= 2);
    await transport.close();
  });

  it("uses the v2 Hub WebSocket route for HTTP and HTTPS origins", async () => {
    fakeSockets.splice(0, fakeSockets.length);

    for (const [hubBaseUrl, expected] of [
      [
        "http://hub.example",
        "ws://hub.example/api/agent-hub/v2/ws?token=test-token",
      ],
      [
        "https://hub.example",
        "wss://hub.example/api/agent-hub/v2/ws?token=test-token",
      ],
    ] as const) {
      const transport = new WsClientTransport({
        hubBaseUrl,
        token: "test-token",
        clientId: "client-a",
        WebSocketImpl: FakeWebSocket as unknown as new (
          url: string,
        ) => ClientWebSocketLike,
      });
      await transport.connect({
        command: async () => undefined,
        connected: async () => undefined,
      });
      await nextTurn();
      assert.equal(fakeSockets.at(-1)?.url, expected);
      await transport.close();
    }
  });

  it("builds the Hub WebSocket endpoint from the origin without credentials", async () => {
    fakeSockets.splice(0, fakeSockets.length);
    const transport = new WsClientTransport({
      hubBaseUrl: "https://user:password@hub.example/ignored-base-path",
      token: "test-token",
      clientId: "client-a",
      WebSocketImpl: FakeWebSocket as unknown as new (
        url: string,
      ) => ClientWebSocketLike,
    });

    await transport.connect({
      command: async () => undefined,
      connected: async () => undefined,
    });
    await nextTurn();

    assert.equal(
      fakeSockets[0]?.url,
      "wss://hub.example/api/agent-hub/v2/ws?token=test-token",
    );
    await transport.close();
  });

  it("normalizes a supplied Hub path prefix before adding the WebSocket route", async () => {
    fakeSockets.splice(0, fakeSockets.length);
    const transport = new WsClientTransport({
      hubBaseUrl: "https://hub.example",
      pathPrefix: "/host-agent-hub/",
      token: "test-token",
      clientId: "client-a",
      WebSocketImpl: FakeWebSocket as unknown as new (
        url: string,
      ) => ClientWebSocketLike,
    });

    await transport.connect({
      command: async () => undefined,
      connected: async () => undefined,
    });
    await nextTurn();

    assert.equal(
      fakeSockets[0]?.url,
      "wss://hub.example/host-agent-hub/ws?token=test-token",
    );
    await transport.close();
  });

  it("rejects invalid Hub path prefixes before opening a WebSocket", () => {
    for (const pathPrefix of [
      "",
      "agent-hub",
      "/agent-hub?preview=1",
      "/agent-hub#section",
    ]) {
      assert.throws(
        () =>
          new WsClientTransport({
            hubBaseUrl: "http://hub.example",
            pathPrefix,
            token: "test-token",
            clientId: "client-a",
            WebSocketImpl: ThrowingWebSocket,
          }),
        AgentClientConfigurationError,
      );
    }
  });
});

class FakeWebSocket implements ClientWebSocketLike {
  readyState = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    fakeSockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const fakeSockets: FakeWebSocket[] = [];

class ThrowingWebSocket implements ClientWebSocketLike {
  readyState = 3;
  onmessage = null;
  onclose = null;
  onerror = null;
  onopen = null;

  constructor(_url: string) {
    throw new Error("WebSocket must not open for an invalid configuration");
  }

  send(_data: string): void {}
  close(): void {}
}
