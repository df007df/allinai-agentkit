import assert from "node:assert/strict";
import { test } from "node:test";
import { startConsoleServer } from "./index.js";
import { CONSOLE_RUNS_PATH } from "../routes.js";

test("runs endpoint validates and enqueues agent.run offers", async () => {
  const site = await startConsoleServer({ port: 0 });
  try {
    const invalid = await fetch(`${site.url}${CONSOLE_RUNS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1" }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /invalid_run_request/);

    const badRuntime = await fetch(`${site.url}${CONSOLE_RUNS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1", prompt: "hi", runtime: "nope" }),
    });
    assert.equal(badRuntime.status, 400);

    // Unknown client: the hub enqueues the offer for durable offline delivery
    // (same semantics as the tool-approval relay), so the trigger is accepted.
    const accepted = await fetch(`${site.url}${CONSOLE_RUNS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "missing-client",
        prompt: "run the smoke task",
        runtime: "codex",
        project: "web",
      }),
    });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as {
      delivered: boolean;
      offerId: string;
      executionId: string | undefined;
    };
    assert.equal(body.delivered, true);
    assert.ok(body.offerId);
    assert.ok(body.executionId);
  } finally {
    await site.close();
  }
});
