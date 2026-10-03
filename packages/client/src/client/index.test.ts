import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentClientConfigurationError as DirectConfigurationError } from "./types.js";
import { ClientStateStore as DirectStateStore } from "./state-store.js";
import { ClientSupervisor as DirectSupervisor } from "./supervisor.js";
import { WsClientTransport as DirectWsClientTransport } from "./ws-transport.js";
import * as client from "./index.js";

test("the public client entry aggregates the client core without loading runtime SDKs", () => {
  assert.equal(client.ClientStateStore, DirectStateStore);
  assert.equal(client.ClientSupervisor, DirectSupervisor);
  assert.equal(client.WsClientTransport, DirectWsClientTransport);
  assert.equal(client.AgentClientConfigurationError, DirectConfigurationError);
});
