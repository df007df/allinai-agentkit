import assert from "node:assert/strict";
import { test } from "node:test";

test("Hub and Client expose independently usable public APIs", async () => {
  const hub = await import("@allin-ai/agentkit-hub");
  const client = await import("@allin-ai/agentkit-client");
  assert.equal(typeof hub.createAgentHub, "function");
  assert.equal(typeof client.ClientSupervisor, "function");
  assert.equal(typeof client.WsClientTransport, "function");
  assert.equal("ClientSupervisor" in hub, false);
  assert.equal("createRunnerManager" in hub, false);
  assert.equal("createAgentHub" in client, false);
});

test("the two packages encode and decode the same protocol", async () => {
  const hub = await import("@allin-ai/agentkit-hub/protocol");
  const client = await import("@allin-ai/agentkit-client/protocol");
  const hello = { type: "client.hello", clientId: "split-client", protocolVersion: 2 };
  assert.deepEqual(hub.parseClientHello(client.encodeClientHello("split-client")), hello);
  assert.equal(hub.AGENT_CLIENT_PROTOCOL_VERSION, client.AGENT_CLIENT_PROTOCOL_VERSION);
});
