import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRegistryAuthorizer,
  DEMO_PRINCIPAL,
  TokenRegistry,
} from "./token-registry.js";

describe("token registry", () => {
  it("registers, verifies and revokes tokens", () => {
    const registry = new TokenRegistry();
    const record = registry.register("client-1");
    assert.equal(record.clientId, "client-1");
    assert.equal(record.label, "login");
    assert.deepEqual(registry.verify(record.token), record);
    assert.equal(registry.verify("missing"), null);
    assert.equal(registry.revoke(record.token), true);
    assert.equal(registry.verify(record.token), null);
  });

  it("authorizer accepts registered tokens as the demo principal", async () => {
    const registry = new TokenRegistry();
    const record = registry.register("client-1", "bootstrap");
    const authorize = createRegistryAuthorizer(registry);
    assert.equal(await authorize(record.token, {} as never), DEMO_PRINCIPAL);
    assert.equal(await authorize("nope", {} as never), null);
  });
});
