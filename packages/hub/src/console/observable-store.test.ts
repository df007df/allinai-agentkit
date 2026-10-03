import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryHubStore } from "../hub/testkit/index.js";
import type { HubClientRegistration } from "../hub/index.js";
import { ObservableStore, type HubObservation } from "./observable-store.js";

const registration = (
  clientId: string,
): HubClientRegistration<string> => ({
  principal: "demo-user",
  clientId,
  protocolVersion: 2,
});

describe("observable store", () => {
  it("forwards every call and emits observations without changing semantics", async () => {
    const observations: HubObservation[] = [];
    const inner = new MemoryHubStore<string>();
    const store = new ObservableStore<string>(inner, (obs) =>
      observations.push(obs),
    );

    const record = await store.registerClient(registration("client-1"));
    assert.equal(record.clientId, "client-1");
    await store.heartbeat({ principal: "demo-user", clientId: "client-1" });

    const offer = await store.enqueueOffer({
      principal: "demo-user",
      targetClientId: "client-1",
      command: {
        kind: "agent.run",
        commandId: "command-1",
        executionId: "execution-1",
        taskId: "task-1",
        attempt: 1,
        runtime: "codex",
        payload: { prompt: "hello" },
      },
    });
    assert.equal(offer.command.commandId, "command-1");

    const pending = await store.listPendingOffers({
      principal: "demo-user",
      clientId: "client-1",
    });
    assert.equal(pending.length, 1);

    await store.ingestEvents({
      principal: "demo-user",
      clientId: "client-1",
      events: [],
    });

    assert.deepEqual(
      observations.map((obs) => obs.kind),
      [
        "client.registered",
        "client.heartbeat",
        "offer.enqueued",
        "offers.delivered",
        "events.ingested",
      ],
    );
    const enqueued = observations.find((obs) => obs.kind === "offer.enqueued");
    assert.equal(enqueued?.kind === "offer.enqueued" && enqueued.commandKind, "agent.run");
  });

  it("keeps store semantics when the sink throws", async () => {
    const inner = new MemoryHubStore<string>();
    const store = new ObservableStore<string>(inner, () => {
      throw new Error("sink failed");
    });
    const record = await store.registerClient(registration("client-2"));
    assert.equal(record.clientId, "client-2");
  });

  it("events.ingested observation carries the ingested ClientEvents", async () => {
    const seen: HubObservation[] = [];
    const store = new ObservableStore(new MemoryHubStore<string>(), (o) => seen.push(o));
    await store.registerClient(registration("client-3"));
    const batch = {
      principal: "demo-user",
      clientId: "client-3",
      events: [
        {
          executionId: "execution-3",
          eventSeq: 1,
          type: "received" as const,
          occurredAt: "2026-09-22T00:00:00.000Z",
        },
      ],
    };
    await store.ingestEvents(batch);
    const obs = seen.find((o) => o.kind === "events.ingested");
    assert.ok(obs && obs.kind === "events.ingested");
    assert.equal(obs.events.length, 1);
    assert.equal(obs.events[0].type, "received");
  });
});
