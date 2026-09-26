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
  it("replays recorded human decisions and relays neutral for unknown ids", async () => {
    const decisions = new Map<string, { decision: "allow" | "deny"; reason?: string }>([
      ["req-1", { decision: "allow" }],
      ["req-2", { decision: "deny", reason: "not in this workspace" }],
    ]);
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        resolveDecision: (requestId) => decisions.get(requestId) ?? null,
      });

      const ok = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-1", tool_name: "Bash" },
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { decision: "allow" });

      const denied = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-2" },
      });
      assert.equal(denied.status, 200);
      assert.deepEqual(denied.json, {
        decision: "deny",
        reason: "not in this workspace",
      });

      // No human decision has arrived for this request id: relay a neutral
      // non-deny. The bridge never invents a deny — hooks are report-only
      // and pass everything through unless a human explicitly denied.
      const unknown = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-unknown" },
      });
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.json, {
        decision: "allow",
        reason: "no_record",
      });
    } finally {
      await bridge?.close();
    }
  });

  it("answers 404 for non-approval paths and relays neutral for malformed bodies", async () => {
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        resolveDecision: () => null,
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
      assert.equal(body.decision, "allow");
      assert.equal(body.reason, "no_record");
    } finally {
      await bridge?.close();
    }
  });
});
