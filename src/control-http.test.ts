import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startToolApprovalHttpBridge,
  type ToolApprovalHttpBridge,
} from "./control-http.js";

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${url}/control/tool-approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("tool approval HTTP bridge", () => {
  it("resolves the owning execution and forwards allow decisions", async () => {
    const calls: Array<{
      executionId: string;
      requestId: string;
      decision: string;
    }> = [];
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        respondToolApproval: async (executionId, requestId, decision) => {
          calls.push({ executionId, requestId, decision });
        },
        resolveExecutionId: (requestId) =>
          requestId === "req-1" ? "exec-9" : null,
      });

      const ok = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-1", tool_name: "Bash" },
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { decision: "allow" });
      assert.deepEqual(calls, [
        { executionId: "exec-9", requestId: "req-1", decision: "allow" },
      ]);

      // Unknown request ids are denied fail-closed without touching the runner.
      const unknown = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-unknown" },
      });
      assert.deepEqual(unknown.json, {
        decision: "deny",
        reason: "approval request not owned by this daemon",
      });
      assert.equal(calls.length, 1);
    } finally {
      await bridge?.close();
    }
  });

  it("answers 404 for non-approval paths and denies malformed bodies", async () => {
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        respondToolApproval: async () => {},
        resolveExecutionId: () => null,
      });

      const miss = await fetch(`${bridge.url}/unrelated`);
      assert.equal(miss.status, 404);

      const malformed = await fetch(`${bridge.url}/control/tool-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(malformed.status, 200);
      const body = (await malformed.json()) as Record<string, unknown>;
      assert.equal(body.decision, "deny");
    } finally {
      await bridge?.close();
    }
  });
});
