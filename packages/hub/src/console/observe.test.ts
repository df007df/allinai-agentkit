import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { ConsoleState } from "./state.js";
import type { HubObservation } from "./observable-store.js";
import {
  broadcastConsole,
  handleConsoleObserve,
  type ConsoleStreamContext,
} from "./observe.js";

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.close();
    server.closeAllConnections();
    await once(server, "close").catch(() => undefined);
  }
});

function feedObservation(state: ConsoleState): HubObservation {
  const observation: HubObservation = {
    kind: "client.registered",
    clientId: "sse-client",
    at: Date.now(),
  };
  state.apply(observation);
  return observation;
}

function startServer(context: ConsoleStreamContext): Promise<string> {
  const server = http.createServer((request, response) => {
    handleConsoleObserve(context, request, response);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  });
}

/** Opens a raw GET; resolves with the first SSE chunk plus handles. */
function firstChunk(url: string): Promise<{
  text: string;
  request: http.ClientRequest;
  response: http.IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      request.socket?.setNoDelay(true);
      response.once("data", (chunk: Buffer) => {
        resolve({ text: chunk.toString("utf8"), request, response });
      });
    });
    request.on("error", reject);
  });
}

/** Resolves with the next chunk written after this call, or null on timeout. */
function nextChunk(
  response: http.IncomingMessage,
  timeoutMs = 2_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      response.off("data", onData);
      resolve(null);
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    };
    response.once("data", onData);
  });
}

async function drain(response: http.IncomingMessage): Promise<void> {
  response.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("observe streams snapshot frame with clients/events/serverTime/warning", async () => {
  const state = new ConsoleState();
  feedObservation(state);
  const context: ConsoleStreamContext = {
    state,
    subscribers: new Set(),
    sequence: { value: 0 },
    hostWarning: "shared host",
  };
  const url = await startServer(context);
  const { text, response } = await firstChunk(url);
  assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.match(text, /^event: snapshot\ndata: /);
  assert.ok(text.endsWith("\n\n"));
  const payload = JSON.parse(text.slice("event: snapshot\ndata: ".length));
  assert.ok(Array.isArray(payload.clients));
  assert.ok(Array.isArray(payload.events));
  assert.ok(Array.isArray(payload.observations));
  assert.equal(typeof payload.serverTime, "number");
  assert.equal(payload.warning, "shared host");
  assert.equal(payload.clients[0]?.clientId, "sse-client");
  assert.equal(context.subscribers.size, 1);
  await drain(response);
  assert.equal(context.subscribers.size, 0);
});

test("broadcastConsole fans out observation frames with incremented seq", async () => {
  const state = new ConsoleState();
  const observation = feedObservation(state);
  const context: ConsoleStreamContext = {
    state,
    subscribers: new Set(),
    sequence: { value: 0 },
    hostWarning: null,
  };
  const url = await startServer(context);
  const { request, response } = await firstChunk(url);
  broadcastConsole(context, observation);
  const chunk = await nextChunk(response);
  assert.ok(chunk, "timed out waiting for observation frame");
  assert.match(chunk, /^event: observation\ndata: /);
  assert.ok(chunk.endsWith("\n\n"));
  const payload = JSON.parse(
    chunk.slice("event: observation\ndata: ".length),
  ) as { seq: number; observation: HubObservation };
  assert.equal(payload.seq, 1);
  assert.equal(payload.observation.kind, "client.registered");
  assert.equal(payload.observation.clientId, "sse-client");
  assert.equal(context.sequence.value, 1);

  broadcastConsole(context, observation);
  const second = await nextChunk(response);
  assert.ok(second);
  const secondPayload = JSON.parse(
    second.slice("event: observation\ndata: ".length),
  ) as { seq: number };
  assert.equal(secondPayload.seq, 2);

  await drain(response);
  assert.equal(context.subscribers.size, 0);
  request.destroy();
});

test("subscribers empty after client close", async () => {
  const state = new ConsoleState();
  const context: ConsoleStreamContext = {
    state,
    subscribers: new Set(),
    sequence: { value: 0 },
    hostWarning: null,
  };
  const url = await startServer(context);
  const { response } = await firstChunk(url);
  assert.equal(context.subscribers.size, 1);
  await drain(response);
  assert.equal(context.subscribers.size, 0);
});
