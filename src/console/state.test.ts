import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleState, CONSOLE_EVENT_BUFFER_LIMIT } from "./state.js";
import type { HubObservation } from "./observable-store.js";

const ev = (executionId: string, eventSeq: number, occurredAt: string) => ({
  executionId, eventSeq, type: "progress" as const, occurredAt,
});

const approval = (requestId: string, toolName = "Bash") => ({
  kind: "tool_approval.requested" as const,
  clientId: "c1",
  approval: {
    executionId: "e1",
    requestId,
    toolName,
    toolInput: { command: "ls" } as Record<string, unknown>,
  },
  at: 1,
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

test("pending approvals derive from observations and clear on respond offers", () => {
  const state = new ConsoleState({ events: 10, observations: 10 });
  state.apply(approval("r1"));
  state.apply({
    ...approval("r2"),
    approval: { ...approval("r2").approval, toolName: "Write" },
  });
  let snap = state.snapshot();
  assert.deepEqual(
    snap.pendingApprovals.map((p) => p.requestId),
    ["r1", "r2"],
    "requested approvals must appear in the snapshot for reconnect hydration",
  );
  assert.equal(snap.pendingApprovals[0]?.toolName, "Bash");
  assert.equal(snap.pendingApprovals[0]?.clientId, "c1");
  assert.equal(snap.pendingApprovals[0]?.executionId, "e1");

  // Unrelated offers must not clear anything.
  state.apply({
    kind: "offer.enqueued",
    offerId: "o1",
    targetClientId: "c1",
    commandKind: "agent.run",
    at: 3,
  });
  assert.equal(state.snapshot().pendingApprovals.length, 2);

  // A human decision flowing to the daemon clears exactly its request.
  state.apply({
    kind: "offer.enqueued",
    offerId: "o2",
    targetClientId: "c1",
    commandKind: "respond_tool_approval",
    approvalRequestId: "r1",
    at: 4,
  });
  snap = state.snapshot();
  assert.deepEqual(snap.pendingApprovals.map((p) => p.requestId), ["r2"]);
});

test("pending approvals survive observation ring trimming", () => {
  const state = new ConsoleState({ events: 5, observations: 3 });
  state.apply(approval("r1"));
  for (let i = 0; i < 10; i++) {
    state.apply({ kind: "client.heartbeat", clientId: "c1", at: 2 + i });
  }
  // The approval card must not fall out with the trimmed ring: a reconnecting
  // mobile client relies on the snapshot to redraw it.
  assert.equal(state.snapshot().pendingApprovals.length, 1);
});
