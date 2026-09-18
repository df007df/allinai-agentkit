import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ClientCommand, ClientEvent } from "./types.js";
import { ClientStateStore } from "./state-store.js";

const OCCURRED_AT = "2026-09-18T00:00:00.000Z";

function agentRun(executionId = "e1"): ClientCommand {
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

function event(
  executionId: string,
  eventSeq: number,
  type: ClientEvent["type"],
): ClientEvent {
  return { executionId, eventSeq, type, occurredAt: OCCURRED_AT };
}

describe("ClientStateStore", () => {
  let dir: string;
  let dbPath: string;
  let store: ClientStateStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-state-"));
    dbPath = path.join(dir, "state.db");
    store = new ClientStateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("admits an execution once and returns its prior state on redelivery", () => {
    const command = agentRun();

    assert.equal(store.admit(command).disposition, "inserted");
    const duplicate = store.admit(command);

    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(duplicate.execution.state, "received");
    assert.equal(store.listExecutions().length, 1);
    assert.deepEqual(
      store.listUnackedEvents("e1").map(({ eventSeq, type }) => ({
        eventSeq,
        type,
      })),
      [{ eventSeq: 1, type: "received" }],
    );
  });

  it("persists a pre-run plugin snapshot and only the last successful plugin sync revision", () => {
    const snapshot = [
      {
        id: "demo",
        resolvedCommit: "a".repeat(40),
      },
    ];

    store.admit(agentRun(), { pluginSnapshot: snapshot });
    store.recordPluginSyncSuccess("plugins-v1");
    store.close();
    store = new ClientStateStore(dbPath);

    assert.deepEqual(store.getExecution("e1")?.pluginSnapshot, snapshot);
    assert.equal(store.getLastPluginSyncRevision(), "plugins-v1");
    assert.deepEqual(store.listUnackedEvents("e1")[0]?.payload, {
      pluginSnapshot: snapshot,
    });
  });

  it("retains events until the matching acknowledgement watermark", () => {
    store.admit(agentRun());
    assert.equal(
      store.appendEvent({
        executionId: "e1",
        type: "progress",
        occurredAt: OCCURRED_AT,
      }).eventSeq,
      2,
    );
    store.appendEvent(event("e1", 3, "progress"));

    store.acknowledge("e1", 2);

    assert.deepEqual(
      store.listUnackedEvents("e1").map((row) => row.eventSeq),
      [3],
    );
  });

  it("atomically records a legal state transition and its outbox event", () => {
    store.admit(agentRun());

    const running = store.transition("e1", "running", {
      runtime: "codex",
    });

    assert.equal(running.eventSeq, 2);
    assert.equal(store.getExecution("e1")?.state, "running");
    assert.deepEqual(
      store.listUnackedEvents("e1").map((row) => row.type),
      ["received", "running"],
    );
  });

  it("records cancellation before a runner launches", () => {
    store.admit(agentRun());

    const cancelled = store.transition("e1", "cancelled");

    assert.equal(cancelled.eventSeq, 2);
    assert.equal(cancelled.type, "cancelled");
    assert.equal(store.getExecution("e1")?.state, "cancelled");
    assert.deepEqual(
      store.listUnackedEvents("e1").map(({ eventSeq, type }) => ({
        eventSeq,
        type,
      })),
      [
        { eventSeq: 1, type: "received" },
        { eventSeq: 2, type: "cancelled" },
      ],
    );
  });

  it("rejects illegal state transitions", () => {
    store.admit(agentRun());

    assert.throws(
      () => store.transition("e1", "done"),
      /Cannot transition execution e1 from received to done/,
    );
  });

  it("does not let appendEvent bypass the state machine", () => {
    store.admit(agentRun());

    assert.throws(
      () => store.appendEvent(event("e1", 2, "done")),
      /Only progress events may be appended directly/,
    );

    assert.equal(store.getExecution("e1")?.state, "received");
    assert.deepEqual(
      store.listUnackedEvents("e1").map(({ eventSeq, type }) => ({
        eventSeq,
        type,
      })),
      [{ eventSeq: 1, type: "received" }],
    );
  });

  it("marks running executions as recovery_required after restart", () => {
    store.admit(agentRun());
    store.transition("e1", "running");
    store.acknowledge("e1", 2);
    store.close();
    store = new ClientStateStore(dbPath);

    const recovered = store.markRecoveryRequired();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.eventSeq, 3);
    assert.equal(store.getExecution("e1")?.state, "recovery_required");
    assert.deepEqual(
      store.listUnackedEvents("e1").map(({ eventSeq, type }) => ({
        eventSeq,
        type,
      })),
      [{ eventSeq: 3, type: "recovery_required" }],
    );
  });
});
