import assert from "node:assert/strict";
import { test } from "node:test";
import { startConsoleServer } from "./index.js";
import { CONSOLE_TOOL_APPROVAL_PATH } from "../routes.js";

test("tool-approval endpoint validates and relays decisions via hub offers", async () => {
  const site = await startConsoleServer({ port: 0 });
  try {
    const invalid = await fetch(`${site.url}${CONSOLE_TOOL_APPROVAL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1" }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /invalid_approval_request/);

    // Unknown client: the hub enqueues the offer for durable offline delivery
    // (same semantics the demo-era handler had), so the relay reports accepted.
    const unknown = await fetch(`${site.url}${CONSOLE_TOOL_APPROVAL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "missing-client",
        executionId: "exec-1",
        requestId: "req-1",
        decision: "allow",
      }),
    });
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { delivered: true });
  } finally {
    await site.close();
  }
});
