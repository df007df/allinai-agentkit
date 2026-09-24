import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import * as publicHub from "../hub.js";
import { HUB_PATH_PREFIX } from "../routes.js";
import type {
  ClientCommand,
  ClientEvent,
  HubDownlink,
} from "../protocol/index.js";
import type {
  AgentHubOptions,
  HubClientRegistration,
  HubEventBatch,
  HubHeartbeat,
  HubInventoryReport,
  HubOfferDelivery,
  HubOfferInput,
  HubPluginAcknowledgement,
  HubStore,
  StoredOffer,
} from "./types.js";

type Principal = { owner: string; secret: string };
const principal: Principal = { owner: "alice", secret: "never-on-wire" };
const otherPrincipal: Principal = { owner: "bob", secret: "other-secret" };
const hello = {
  type: "client.hello",
  protocolVersion: 2,
  clientId: "client-1",
};
const command = (id: string): ClientCommand => ({
  kind: "agent.run",
  commandId: id,
  executionId: `execution-${id}`,
  taskId: "task-1",
  attempt: 0,
  runtime: "codex",
  payload: { prompt: "hello" },
});

class RecordingStore implements HubStore<Principal> {
  calls: Array<{ method: string; input: unknown }> = [];
  owners = new Map<string, string>();
  offers: Array<StoredOffer & { owner: string }> = [];
  events = new Map<string, ClientEvent>();
  enqueueGate: Promise<void> = Promise.resolve();
  registrationGate: Promise<void> = Promise.resolve();

  async registerClient(input: HubClientRegistration<Principal>) {
    this.calls.push({ method: "register", input });
    await this.registrationGate;
    const owner = this.owners.get(input.clientId);
    if (owner && owner !== input.principal.owner)
      throw new Error("ownership conflict");
    this.owners.set(input.clientId, input.principal.owner);
    return {
      clientId: input.clientId,
      connectionKey: `${input.principal.owner}:${input.clientId}`,
    };
  }
  async heartbeat(input: HubHeartbeat<Principal>) {
    this.calls.push({ method: "heartbeat", input });
  }
  async listPendingOffers(input: HubOfferDelivery<Principal>) {
    this.calls.push({ method: "pending", input });
    return this.offers.filter(
      (offer) =>
        offer.owner === input.principal.owner &&
        offer.targetClientId === input.clientId,
    );
  }
  async enqueueOffer(input: HubOfferInput<Principal>) {
    this.calls.push({ method: "enqueue", input });
    await this.enqueueGate;
    const offer = {
      offerId: input.command.commandId,
      targetClientId: input.targetClientId,
      connectionKey: `${input.principal.owner}:${input.targetClientId}`,
      command: input.command,
    };
    if (
      !this.offers.some(
        (item) =>
          item.owner === input.principal.owner &&
          item.offerId === offer.offerId,
      )
    ) {
      this.offers.push({ ...offer, owner: input.principal.owner });
    }
    return offer;
  }
  async ingestEvents(input: HubEventBatch<Principal>) {
    this.calls.push({ method: "events", input });
    for (const event of input.events)
      this.events.set(
        `${input.principal.owner}:${event.executionId}:${event.eventSeq}`,
        event,
      );
    // Simulates a persisted contiguous watermark from earlier process lifetimes.
    return { "execution-one": 41 };
  }
  async acknowledgePluginSync(input: HubPluginAcknowledgement<Principal>) {
    this.calls.push({ method: "plugin", input });
  }
  async recordInventory(
    input: HubInventoryReport<Principal>,
  ): Promise<void> {
    this.calls.push({ method: "inventory", input });
  }
  async getInventory(input: { principal: Principal; clientId: string }) {
    this.calls.push({ method: "getInventory", input });
    return null;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for hub effect");
    await setImmediate();
  }
}

async function setup(
  t: TestContext,
  options: Partial<AgentHubOptions<Principal>> = {},
) {
  assert.equal(
    typeof publicHub.createAgentHub,
    "function",
    "generic createAgentHub must be exported",
  );
  const store = new RecordingStore();
  const hub = publicHub.createAgentHub<Principal>({
    store,
    authorize: async (token) => {
      await setImmediate();
      return token === "valid" ? principal : null;
    },
    ...options,
  });
  const server = http.createServer();
  const fallbacks: string[] = [];
  hub.attach(server, {
    fallback: (req, res) => {
      fallbacks.push(req.url!);
      res.writeHead(200);
      res.end("application");
    },
    onUnknownUpgrade: (req, socket) => {
      fallbacks.push(req.url!);
      socket.end("HTTP/1.1 418 Teapot\r\nConnection: close\r\n\r\n");
    },
  });
  assert.equal(server.listening, false, "attach must not start a listener");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await hub.close();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  async function connect(
    token = "valid",
    path = `${options.pathPrefix ?? HUB_PATH_PREFIX}/ws`,
  ) {
    const socket = new WebSocket(
      `${base.replace("http", "ws")}${path}?token=${token}`,
    );
    sockets.push(socket);
    const messages: unknown[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await once(socket, "open");
    return { socket, messages };
  }
  return { store, hub, server, base, connect, fallbacks };
}

test("awaits asynchronous authorization before HTTP/WS access", async (t) => {
  const { base, connect, store } = await setup(t);
  const denied = new WebSocket(
    `${base.replace("http", "ws")}${HUB_PATH_PREFIX}/ws?token=bad`,
  );
  denied.on("error", () => {});
  const [error] = await once(denied, "error");
  assert.match(String(error), /401/);
  assert.equal(store.calls.length, 0);
  const response = await fetch(`${base}${HUB_PATH_PREFIX}/ws?token=bad`);
  assert.equal(response.status, 401);
  const allowedResponse = await fetch(`${base}${HUB_PATH_PREFIX}/ws`, {
    headers: { authorization: "Bearer valid" },
  });
  assert.equal(allowedResponse.status, 426);
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
});

test("hello registers the authenticated principal and replays persisted offers in store order", async (t) => {
  const { connect, store } = await setup(t);
  await store.enqueueOffer({
    principal,
    targetClientId: "client-1",
    command: command("two"),
  });
  await store.enqueueOffer({
    principal,
    targetClientId: "client-1",
    command: command("one"),
  });
  store.calls.length = 0;
  const { socket, messages } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => messages.length === 2);
  assert.deepEqual(messages, [
    { type: "task.offer", command: command("two") },
    { type: "task.offer", command: command("one") },
  ]);
  assert.deepEqual(
    store.calls.map((call) => call.method),
    ["register", "pending"],
  );
  assert.equal(
    (store.calls[0].input as HubClientRegistration<Principal>).principal,
    principal,
  );
  assert.equal(JSON.stringify(messages).includes(principal.secret), false);
  const intruder = await connect();
  const closed = once(intruder.socket, "close");
  intruder.socket.send(JSON.stringify({ ...hello, userId: "bob" }));
  assert.equal((await closed)[0], 1008);
  assert.equal(
    store.calls.filter((call) => call.method === "register").length,
    1,
  );
});

test("persists before online delivery and replays after all live sockets disconnect", async (t) => {
  const { connect, store, hub } = await setup(t);
  const first = await connect();
  first.socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  let persist!: () => void;
  store.enqueueGate = new Promise<void>((resolve) => {
    persist = resolve;
  });
  const offered = hub.offer({
    principal,
    targetClientId: "client-1",
    command: command("one"),
  });
  await until(() => store.calls.some((call) => call.method === "enqueue"));
  assert.deepEqual(first.messages, []);
  persist();
  assert.equal((await offered).offerId, "one");
  await until(() => first.messages.length === 1);
  assert.deepEqual(first.messages[0], {
    type: "task.offer",
    command: command("one"),
  });
  const closed = once(first.socket, "close");
  first.socket.close();
  await closed;
  const second = await connect();
  second.socket.send(JSON.stringify(hello));
  await until(() => second.messages.length === 1);
  assert.deepEqual(second.messages, first.messages);
  assert.equal(
    store.offers.length,
    1,
    "sending must not remove durable offers",
  );
});

test("serializes hello and event batches and acknowledges the store watermark on every retry", async (t) => {
  const { connect, store } = await setup(t);
  let register!: () => void;
  store.registrationGate = new Promise<void>((resolve) => {
    register = resolve;
  });
  const { socket, messages } = await connect();
  const event: ClientEvent = {
    executionId: "execution-one",
    eventSeq: 1,
    type: "received",
    occurredAt: "2026-09-18T00:00:00Z",
  };
  socket.send(JSON.stringify(hello));
  socket.send(JSON.stringify({ type: "event.push", events: [event] }));
  await until(() => store.calls.some((call) => call.method === "register"));
  assert.equal(
    store.calls.some((call) => call.method === "events"),
    false,
  );
  register();
  await until(() => messages.length === 1);
  socket.send(JSON.stringify({ type: "event.push", events: [event] }));
  await until(() => messages.length === 2);
  assert.deepEqual(messages, [
    { type: "event.ack", watermarks: { "execution-one": 41 } },
    { type: "event.ack", watermarks: { "execution-one": 41 } },
  ]);
  assert.equal(store.events.size, 1);
  const ingested = store.calls.filter((call) => call.method === "events");
  assert.equal(ingested.length, 2);
  assert.deepEqual(ingested[0].input, {
    principal,
    clientId: "client-1",
    events: [event],
  });
});

test("persists plugin acknowledgements and WebSocket heartbeat with connection ownership", async (t) => {
  const { connect, store } = await setup(t);
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  const acknowledgement = {
    type: "plugin.sync.ack",
    revision: "rev-1",
    status: "applied",
    plugins: [],
  };
  socket.send(JSON.stringify(acknowledgement));
  socket.ping();
  await until(
    () =>
      store.calls.some((call) => call.method === "plugin") &&
      store.calls.some((call) => call.method === "heartbeat"),
  );
  assert.deepEqual(
    store.calls.find((call) => call.method === "plugin")!.input,
    { principal, clientId: "client-1", acknowledgement },
  );
  assert.deepEqual(
    store.calls.find((call) => call.method === "heartbeat")!.input,
    { principal, clientId: "client-1" },
  );
});

test("hub keepalive pings registered clients and refreshes the store heartbeat", async (t) => {
  const { connect, store } = await setup(t, { heartbeatIntervalMs: 40 });
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  // The Hub pings every 40ms; the ws client auto-pongs; each pong is a heartbeat.
  await until(
    () =>
      store.calls.filter((call) => call.method === "heartbeat").length >= 3,
  );
  const beats = store.calls.filter((call) => call.method === "heartbeat");
  assert.ok(beats.length >= 3, `expected repeated heartbeats, saw ${beats.length}`);
});

test("heartbeatIntervalMs: 0 disables keepalive pings", async (t) => {
  const { connect, store } = await setup(t, { heartbeatIntervalMs: 0 });
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  await sleep(120);
  assert.equal(
    store.calls.filter((call) => call.method === "heartbeat").length,
    0,
    "no heartbeat should arrive without keepalive",
  );
});

test("leaves non-Hub HTTP and upgrades, including legacy daemon routes, to the application", async (t) => {
  const { base, fallbacks, connect, store } = await setup(t, {
    pathPrefix: "/custom/hub",
  });
  for (const path of [
    "/page",
    "/api/daemon/register",
    `${HUB_PATH_PREFIX}/ws`,
  ]) {
    assert.equal(await (await fetch(`${base}${path}`)).text(), "application");
  }
  await assert.rejects(connect("valid", "/application-ws"), /418/);
  assert.deepEqual(fallbacks, [
    "/page",
    "/api/daemon/register",
    `${HUB_PATH_PREFIX}/ws`,
    "/application-ws?token=valid",
  ]);
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "register"));
});

test("uses the attach fallback once on a server with no application request listener", async (t) => {
  const { base, fallbacks, server } = await setup(t);
  assert.equal(server.listenerCount("request"), 1);
  const response = await fetch(`${base}/application-page`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "application");
  assert.deepEqual(fallbacks, ["/application-page"]);
});

test("rejects an unknown upgrade when the host did not supply an upgrade fallback", async (t) => {
  const hub = publicHub.createAgentHub<Principal>({
    authorize: async () => principal,
    store: new RecordingStore(),
  });
  const server = http.createServer();
  hub.attach(server, {
    fallback: (_request, response) => response.end("application"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const socket = net.connect(address.port, "127.0.0.1");
  t.after(async () => {
    socket.destroy();
    await hub.close();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  await once(socket, "connect");
  const disconnected = once(socket, "close");
  socket.write(
    "GET /application-ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await Promise.race([
    disconnected,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("unknown upgrade socket remained open")),
        300,
      );
    }),
  ]);
  await hub.close();
  let serverClosed = false;
  server.close(() => {
    serverClosed = true;
  });
  await until(() => serverClosed);
});

test("rejects owner conflicts without superseding the authorized socket", async (t) => {
  const { connect, store, hub } = await setup(t, {
    authorize: async (token) =>
      token === "bob" ? otherPrincipal : { ...principal },
  });
  const first = await connect();
  first.socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  const intruder = await connect("bob");
  const denied = once(intruder.socket, "close");
  intruder.socket.send(JSON.stringify(hello));
  assert.equal((await denied)[0], 1008);
  assert.equal(first.socket.readyState, WebSocket.OPEN);
  const second = await connect();
  const superseded = once(first.socket, "close");
  second.socket.send(JSON.stringify(hello));
  assert.equal((await superseded)[0], 1000);
  await hub.offer({
    principal: otherPrincipal,
    targetClientId: "client-1",
    command: command("bob"),
  });
  await hub.offer({
    principal,
    targetClientId: "client-1",
    command: command("alice"),
  });
  await until(() => second.messages.length > 0);
  assert.deepEqual(
    (second.messages as HubDownlink[]).map(
      (message) => message.type === "task.offer" && message.command.commandId,
    ),
    ["alice"],
  );
});

test("closes malformed and uninitialized connections without persisting events", async (t) => {
  const { connect, store } = await setup(t);
  for (const message of [
    "not json",
    JSON.stringify({ type: "event.push", events: [] }),
  ]) {
    const { socket } = await connect();
    const closed = once(socket, "close");
    socket.send(message);
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(store.calls.length, 0);
});

test("rejects path prefixes that cannot describe an exact HTTP path", () => {
  assert.equal(typeof publicHub.createAgentHub, "function");
  for (const pathPrefix of [
    "relative",
    "/trailing/",
    "/",
    "/hub?query=1",
    "/hub#fragment",
  ]) {
    assert.throws(
      () =>
        publicHub.createAgentHub({
          authorize: async () => principal,
          store: new RecordingStore(),
          pathPrefix,
        }),
      /pathPrefix/,
    );
  }
});

test("failed persistence never produces a delivery or an event acknowledgement", async (t) => {
  const { connect, store, hub } = await setup(t);
  const { socket, messages } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  store.enqueueOffer = async () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(
    hub.offer({
      principal,
      targetClientId: "client-1",
      command: command("one"),
    }),
    /storage unavailable/,
  );
  assert.deepEqual(messages, []);
  store.ingestEvents = async () => {
    throw new Error("storage unavailable");
  };
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "event.push", events: [] }));
  assert.equal((await closed)[0], 1011);
  assert.deepEqual(messages, []);
});

test("close releases even uninitialized sockets and detaches only its own server handlers", async (t) => {
  const { connect, hub, server, base } = await setup(t);
  const { socket } = await connect();
  const disconnected = once(socket, "close");
  await hub.close();
  await disconnected;
  await hub.close();
  assert.equal(server.listening, true);
  assert.equal(server.listenerCount("request"), 0);
  assert.equal(server.listenerCount("upgrade"), 0);
  server.on("request", (_request, response) => response.end("still serving"));
  assert.equal(
    await (await fetch(`${base}/application`)).text(),
    "still serving",
  );
});

for (const upgradeRequest of [false, true]) {
  test(`malformed ${upgradeRequest ? "upgrade" : "HTTP"} request targets cannot crash the host`, async () => {
    // A separate host process makes an uncaught request-handler exception an
    // observable process failure without installing an exception-swallowing hook.
    const script = `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import net from 'node:net';
      import { once } from 'node:events';
      import { WebSocket } from 'ws';
      import { createAgentHub } from ${JSON.stringify(new URL("../hub.js", import.meta.url).href)};
      let authorized = 0;
      const hub = createAgentHub({
        authorize: async () => { authorized++; return 'owner'; },
        store: {
          registerClient: async ({ clientId }) => ({ clientId, connectionKey: 'owner:client' }),
          listPendingOffers: async () => [],
        },
      });
      const server = http.createServer();
      hub.attach(server, { fallback: (_req, res) => res.end('application') });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      const malformed = net.connect(port, '127.0.0.1');
      let response = '';
      malformed.setEncoding('utf8');
      malformed.on('data', chunk => response += chunk);
      malformed.setTimeout(1000, () => malformed.destroy(new Error('malformed socket left open')));
      await once(malformed, 'connect');
      const finished = once(malformed, 'close');
      malformed.write(${JSON.stringify(`GET //[/ HTTP/1.1\r\nHost: localhost\r\n${upgradeRequest ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13" : "Connection: close"}\r\n\r\n`)});
      await finished;
      ${upgradeRequest ? "assert.equal(response, '');" : "assert.ok(response.startsWith('HTTP/1.1 400 '));"}
      assert.equal(authorized, 0);
      assert.equal(await (await fetch('http://127.0.0.1:' + port + '/page')).text(), 'application');
      const valid = new WebSocket('ws://127.0.0.1:' + port + '/_agentkit/hub/v2/ws');
      await once(valid, 'open');
      assert.equal(authorized, 1);
      const disconnected = once(valid, 'close');
      valid.close();
      await disconnected;
      await hub.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    `;
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { timeout: 5_000 },
    );
  });
}

test("close aborts pending upgrade authorization and late authorization cannot resurrect a client", async (t) => {
  let started!: () => void;
  const authorizationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let authorize!: (value: Principal) => void;
  const authorization = new Promise<Principal>((resolve) => {
    authorize = resolve;
  });
  const { hub, server, base, store } = await setup(t, {
    authorize: async () => {
      started();
      return authorization;
    },
  });
  const socket = net.connect(Number(new URL(base).port), "127.0.0.1");
  t.after(() => socket.destroy());
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    response += data;
  });
  await once(socket, "connect");
  socket.write(
    `GET ${HUB_PATH_PREFIX}/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await authorizationStarted;
  const disconnected = once(socket, "close");
  try {
    await hub.close();
    await Promise.race([
      disconnected,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "pending authorization socket remained open after hub.close",
              ),
            ),
          300,
        );
        disconnected.finally(() => clearTimeout(timer));
      }),
    ]);
    let hostClosed = false;
    server.close(() => {
      hostClosed = true;
    });
    await until(() => hostClosed);
    assert.deepEqual(store.calls, []);
  } finally {
    // Even the RED case releases its authorizer and raw socket for test cleanup.
    authorize(principal);
    socket.destroy();
  }
  await setImmediate();
  assert.equal(response.includes("101 Switching Protocols"), false);
  assert.deepEqual(store.calls, []);
});

test("tolerates unknown client messages without dropping the connection", async (t) => {
  const { connect, store } = await setup(t);
  const { socket, messages } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  socket.send(JSON.stringify({ type: "something.unknown", extra: 1 }));
  socket.send(JSON.stringify({ type: "event.push", events: [] }));
  await until(() => messages.length === 1);
  // RecordingStore always acknowledges the persisted watermark for execution-one.
  assert.deepEqual(messages, [
    { type: "event.ack", watermarks: { "execution-one": 41 } },
  ]);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("forwards inventory reports to the store as ownership-scoped records", async (t) => {
  const { connect, store } = await setup(t);
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  const report = {
    type: "inventory.report",
    reportedAt: "2026-09-19T00:00:00.000Z",
    platforms: [{ platform: "codex", installed: true, version: "1.2.3" }],
    plugins: [],
    projects: [{ name: "web" }],
  };
  socket.send(JSON.stringify(report));
  await until(() => store.calls.some((call) => call.method === "inventory"));
  assert.deepEqual(
    store.calls.find((call) => call.method === "inventory")!.input,
    { principal, clientId: "client-1", report },
  );
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("syncPlugins forwards the inventoryQuery flag on plugin.sync downlinks", async (t) => {
  const { hub, store, connect } = await setup(t);
  const { socket, messages } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => store.calls.some((call) => call.method === "pending"));
  const delivered = await hub.syncPlugins({
    principal,
    targetClientId: "client-1",
    revision: "plugins-v8",
    plugins: [],
    inventoryQuery: true,
  });
  assert.equal(delivered.delivered, true);
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], {
    type: "plugin.sync",
    revision: "plugins-v8",
    plugins: [],
    inventoryQuery: true,
  });
});

test("syncPlugins pushes desired plugin state to the connected owner client", async (t) => {
  const { hub, store, connect } = await setup(t);
  const { socket, messages } = await connect();
  socket.send(JSON.stringify(hello));
  // Registration is asynchronous; the socket only becomes routable after it.
  await until(() => store.calls.some((call) => call.method === "pending"));

  const desired = {
    revision: "plugins-v7",
    plugins: [
      {
        id: "demo-plugin",
        gitUrl: "https://github.com/allin-ai/demo-plugin.git",
        enabled: true,
      },
    ],
  };
  const delivered = await hub.syncPlugins({
    principal,
    targetClientId: "client-1",
    ...desired,
  });
  assert.equal(delivered.delivered, true);
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], { type: "plugin.sync", ...desired });

  // Offline clients are not deliverable; hosts re-push on registration.
  const offline = await hub.syncPlugins({
    principal,
    targetClientId: "unknown-client",
    ...desired,
  });
  assert.equal(offline.delivered, false);

  // A different principal cannot target a client it does not own.
  const foreign = await hub.syncPlugins({
    principal: otherPrincipal,
    targetClientId: "client-1",
    ...desired,
  });
  assert.equal(foreign.delivered, false);

  assert.throws(
    () =>
      hub.syncPlugins({
        principal,
        targetClientId: "client-1",
        revision: "bad",
        plugins: [{ id: "", gitUrl: "", enabled: true }] as never,
      }),
    /Invalid plugin sync/,
  );
});

test("onClientRegistered fires on first connect and every reconnect for level-up hooks", async (t) => {
  const registrations: string[] = [];
  const { connect } = await setup(t, {
    onClientRegistered: ({ clientId }) => {
      registrations.push(clientId);
    },
  });
  const first = await connect();
  first.socket.send(JSON.stringify(hello));
  await until(() => registrations.length === 1);
  first.socket.close();
  const second = await connect();
  second.socket.send(JSON.stringify(hello));
  await until(() => registrations.length === 2);
  assert.deepEqual(registrations, ["client-1", "client-1"]);
});

test("a throwing onClientRegistered hook logs but keeps the connection", async (t) => {
  let calls = 0;
  const { connect, store } = await setup(t, {
    onClientRegistered: () => {
      calls += 1;
      throw new Error("level-up exploded");
    },
  });
  const { socket } = await connect();
  socket.send(JSON.stringify(hello));
  await until(() => calls === 1);
  await until(() => store.calls.some((call) => call.method === "pending"));
  assert.equal(socket.readyState, WebSocket.OPEN);
});
