import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveExecutions, eventsForExecution } from "./executions.js";
import type { ClientEvent } from "../protocol/index.js";

const ev = (over: Partial<ClientEvent>): ClientEvent => ({
  executionId: "e1", eventSeq: 0, type: "progress",
  occurredAt: "2026-01-01T00:00:00Z", ...over,
});

test("derives one view per execution with latest state, sorted most recent first", () => {
  const events = [
    ev({ executionId: "old", occurredAt: "2026-01-01T00:00:00Z" }),
    ev({ executionId: "e1", eventSeq: 1, type: "done", occurredAt: "2026-01-02T00:00:00Z" }),
    ev({ executionId: "e1", eventSeq: 0, type: "running", occurredAt: "2026-01-01T12:00:00Z" }),
  ];
  const views = deriveExecutions(events);
  assert.equal(views.length, 2);
  assert.equal(views[0].executionId, "e1");
  assert.equal(views[0].state, "done");
  assert.equal(views[0].eventCount, 2);
  assert.equal(views[1].executionId, "old");
});

test("eventsForExecution orders by eventSeq", () => {
  const events = [
    ev({ eventSeq: 1 }), ev({ eventSeq: 0, type: "received" }),
    ev({ executionId: "other" }),
  ];
  const got = eventsForExecution(events, "e1");
  assert.deepEqual(got.map((e) => e.eventSeq), [0, 1]);
});
