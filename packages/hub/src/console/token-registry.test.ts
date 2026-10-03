import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createRegistryAuthorizer,
  MemoryTokenStore,
  SqliteTokenStore,
  TokenRegistry,
} from "./token-registry.js";

describe("token registry", () => {
  it("registers, verifies and revokes tokens (memory store)", async () => {
    const registry = new TokenRegistry(new MemoryTokenStore());
    const record = await registry.register("client-1");
    assert.equal(record.clientId, "client-1");
    assert.match(record.token, /^console-/);
    assert.deepEqual(await registry.verify(record.token), record);
    assert.equal(await registry.verify("missing"), null);
    assert.equal(await registry.revoke(record.token), true);
    assert.equal(await registry.verify(record.token), null);
  });

  it("authorizer accepts registered tokens as the registry principal", async () => {
    const registry = new TokenRegistry();
    const record = await registry.register("client-1");
    const authorize = createRegistryAuthorizer(registry);
    // "demo-user" is the registry principal; the authorizer must keep
    // returning it so hub offer delivery keeps matching.
    assert.equal(await authorize(record.token, {} as never), "demo-user");
    assert.equal(await authorize("nope", {} as never), null);
  });

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("persists tokens across reopen (sqlite store)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentkit-tokens-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "tokens.db");

    const first = new TokenRegistry(new SqliteTokenStore(file));
    const record = await first.register("persisted-client");
    await first.close();

    const second = new TokenRegistry(new SqliteTokenStore(file));
    assert.equal((await second.verify(record.token))?.clientId, "persisted-client");
    assert.equal((await second.list()).length, 1);
    assert.equal(await second.revoke(record.token), true);
    assert.equal(await second.verify(record.token), null);
    await second.close();
  });
});
