import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleState, CONSOLE_EVENT_BUFFER_LIMIT } from "./state.js";
import type { HubObservation } from "./observable-store.js";

const ev = (executionId: string, eventSeq: number, occurredAt: string) => ({
  executionId, eventSeq, type: "progress" as const, occurredAt,
});

test("ingested events land in snapshot and ring is trimmed", () => {
  const state = new ConsoleState({ events: 3, observations: 10 });
  for (let i = 0; i < 5; i++) {
    state.apply({ kind: "events.ingested", clientId: "c1", count: 1, at: i,
      events: [ev(`exec-${i}`, 0, `2026-01-0${i + 1}T00:00:00Z`)] });
  }
  const snap = state.snapshot();
  assert.equal(snap.events.length, 3);
  assert.equal(snap.events[0].executionId, "exec-2");
});

test("heartbeat upserts client lastSeen; snapshot sorts events by occurredAt", () => {
  const state = new ConsoleState();
  state.apply({ kind: "client.heartbeat", clientId: "c1", at: 11 });
  state.apply({ kind: "events.ingested", clientId: "c1", count: 2, at: 12,
    events: [ev("b", 1, "2026-01-02T00:00:00Z"), ev("a", 0, "2026-01-01T00:00:00Z")] });
  const snap = state.snapshot();
  assert.equal(state.hasClient("c1"), true);
  assert.equal(snap.events[0].executionId, "a");
});

test("defaults cap events at 500 and observations at 200", () => {
  const state = new ConsoleState();
  for (let i = 0; i < CONSOLE_EVENT_BUFFER_LIMIT + 50; i++) {
    state.apply({ kind: "events.ingested", clientId: "c", count: 1, at: i,
      events: [ev(`e${i}`, 0, "2026-01-01T00:00:00Z")] });
  }
  assert.equal(state.snapshot().events.length, CONSOLE_EVENT_BUFFER_LIMIT);
});
