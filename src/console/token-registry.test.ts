import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRegistryAuthorizer, TokenRegistry } from "./token-registry.js";

describe("token registry", () => {
  it("registers, verifies and revokes tokens", () => {
    const registry = new TokenRegistry();
    const record = registry.register("client-1");
    assert.equal(record.clientId, "client-1");
    assert.match(record.token, /^console-/);
    assert.deepEqual(registry.verify(record.token), record);
    assert.equal(registry.verify("missing"), null);
    assert.equal(registry.revoke(record.token), true);
    assert.equal(registry.verify(record.token), null);
  });

  it("authorizer accepts registered tokens as the registry principal", async () => {
    const registry = new TokenRegistry();
    const record = registry.register("client-1");
    const authorize = createRegistryAuthorizer(registry);
    // "demo-user" is the registry principal; the authorizer must keep
    // returning it so hub offer delivery keeps matching.
    assert.equal(await authorize(record.token, {} as never), "demo-user");
    assert.equal(await authorize("nope", {} as never), null);
  });
});
