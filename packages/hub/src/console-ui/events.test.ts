import assert from "node:assert/strict";
import { test } from "node:test";
import { connectAgentEvents, mergeConsoleClientObservation } from "./events.js";

test("observe callbacks receive the observation inside the server's SSE envelope", () => {
  let source: EventTarget | undefined;
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  class BrowserEventSource extends EventTarget {
    constructor() { super(); source = this; }
    close(): void {}
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: BrowserEventSource });
  const observations: unknown[] = [];
  const stream = connectAgentEvents({ onSnapshot() {}, onObservation(value) { observations.push(value); } });
  try {
    source!.dispatchEvent(new MessageEvent("observation", { data: JSON.stringify({
      seq: 1, observation: { kind: "client.registered", clientId: "live-client", at: 123 },
    }) }));
    assert.deepEqual(observations, [{ kind: "client.registered", clientId: "live-client", at: 123 }]);
  } finally {
    stream.close();
    if (original) Object.defineProperty(globalThis, "EventSource", original);
    else Reflect.deleteProperty(globalThis, "EventSource");
  }
});

test("a client registering after the page opens appears in the live client list", () => {
  const clients = mergeConsoleClientObservation([], {
    kind: "client.registered", clientId: "live-client", name: "Live Agent", at: 100,
  });
  assert.deepEqual(clients, [{ clientId: "live-client", name: "Live Agent", lastSeen: 100, projects: [], plugins: [] }]);
});

test("inventory updates live project choices without replacing client identity", () => {
  const original = [{ clientId: "live-client", name: "Live Agent", lastSeen: 100, projects: ["old"], plugins: [] }];
  const clients = mergeConsoleClientObservation(original, {
    kind: "inventory.recorded", clientId: "live-client", at: 150,
    report: { type: "inventory.report", reportedAt: "2026-10-04T00:00:00Z", platforms: [], plugins: [], projects: [{ name: "new" }] },
  });
  assert.deepEqual(clients, [{ clientId: "live-client", name: "Live Agent", lastSeen: 100, projects: ["new"], plugins: [] }]);
  assert.deepEqual(original[0]?.projects, ["old"]);
});

test("a reconnect updates lastSeen without losing projects or duplicating the client", () => {
  const clients = mergeConsoleClientObservation(
    [{ clientId: "live-client", name: "Live Agent", lastSeen: 100, projects: ["web"], plugins: [] }],
    { kind: "client.heartbeat", clientId: "live-client", at: 200 },
  );
  assert.deepEqual(clients, [{ clientId: "live-client", name: "Live Agent", lastSeen: 200, projects: ["web"], plugins: [] }]);
});
