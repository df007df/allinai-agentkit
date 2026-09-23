import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import type { ClientCommand } from "../../protocol/index.js";
import { createMemoryHub, MemoryHubStore } from "./index.js";

const command = (id: string): ClientCommand => ({
  kind: "agent.run",
  commandId: `command-${id}`,
  executionId: `execution-${id}`,
  taskId: "task-1",
  attempt: 1,
  runtime: "codex",
  payload: { prompt: "hello" },
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for hub effect");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("test-only memory hub", () => {
  it("replays a pending offer from its store after every live socket disconnects", async () => {
    const hub = createMemoryHub({ token: "test-token" });
    const server = http.createServer();
    hub.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `ws://127.0.0.1:${address.port}/_agentkit/hub/v2/ws?token=test-token`;

    try {
      const first = new WebSocket(endpoint);
      await once(first, "open");
      first.send(
        JSON.stringify({
          type: "client.hello",
          protocolVersion: 2,
          clientId: "client-1",
        }),
      );
      await until(() =>
        hub.listClients().some((client) => client.clientId === "client-1"),
      );

      await hub.offer({
        principal: "test-token",
        targetClientId: "client-1",
        command: command("one"),
      });
      const firstOffer = once(first, "message");
      assert.equal(
        JSON.parse(String((await firstOffer)[0])).command.commandId,
        "command-one",
      );
      const closed = once(first, "close");
      first.close();
      await closed;

      const second = new WebSocket(endpoint);
      await once(second, "open");
      const replay = once(second, "message");
      second.send(
        JSON.stringify({
          type: "client.hello",
          protocolVersion: 2,
          clientId: "client-1",
        }),
      );
      assert.equal(
        JSON.parse(String((await replay)[0])).command.commandId,
        "command-one",
      );
      assert.equal(hub.snapshot().offers.length, 1);
      second.close();
    } finally {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("deduplicates events, preserves offer order, and restores only when explicitly asked", async () => {
    const store = new MemoryHubStore<string>();
    await store.enqueueOffer({
      principal: "owner",
      targetClientId: "client-1",
      command: command("first"),
    });
    const retry = { ...command("second"), executionId: "execution-first" };
    await store.enqueueOffer({
      principal: "owner",
      targetClientId: "client-1",
      command: retry,
    });
    await store.enqueueOffer({
      principal: "owner",
      targetClientId: "client-1",
      command: command("third"),
    });
    const pending = await store.listPendingOffers({
      principal: "owner",
      clientId: "client-1",
    });
    assert.deepEqual(
      pending.map((offer) => offer.command.commandId),
      ["command-first", "command-second", "command-third"],
    );

    const event = {
      executionId: "execution-first",
      eventSeq: 1,
      type: "received" as const,
      occurredAt: "2026-09-18T00:00:00.000Z",
    };
    assert.deepEqual(
      await store.ingestEvents({
        principal: "owner",
        clientId: "client-1",
        events: [event, event],
      }),
      {
        "execution-first": 1,
      },
    );
    assert.equal(store.listEvents("execution-first").length, 1);
    const snapshot = store.snapshot();
    const restored = new MemoryHubStore<string>();
    restored.restore(snapshot);
    assert.equal(restored.listEvents("execution-first").length, 1);
    assert.deepEqual(
      await restored.listPendingOffers({
        principal: "owner",
        clientId: "client-1",
      }),
      [pending[2]],
    );
  });

  it("stores and returns the latest inventory report per client", async () => {
    const hub = createMemoryHub({ token: "test-token" });
    try {
      await hub.store.registerClient({
        principal: "test-token",
        clientId: "c1",
        protocolVersion: 2,
      });
      const report = {
        type: "inventory.report" as const,
        reportedAt: "2026-09-19T00:00:00.000Z",
        platforms: [],
        plugins: [],
        projects: [],
      };
      await hub.store.recordInventory({
        principal: "test-token",
        clientId: "c1",
        report,
      });
      assert.deepEqual(
        await hub.getInventory({ principal: "test-token", clientId: "c1" }),
        report,
      );
      // Ownership is enforced in the store: another principal cannot read c1.
      await assert.rejects(
        hub.getInventory({ principal: "someone-else", clientId: "c1" }),
        /ownership conflict/,
      );
      const updated = { ...report, reportedAt: "2026-09-19T01:00:00.000Z" };
      await hub.store.recordInventory({
        principal: "test-token",
        clientId: "c1",
        report: updated,
      });
      assert.equal(
        (
          await hub.getInventory({ principal: "test-token", clientId: "c1" })
        )?.reportedAt,
        "2026-09-19T01:00:00.000Z",
      );
    } finally {
      await hub.close();
    }
  });
});
