import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startToolApprovalHttpBridge,
  ToolApprovalDecisionMap,
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
  it("mints requestIds on registration and replays pre-recorded decisions", async () => {
    const decisions = new ToolApprovalDecisionMap();
    const registered: Array<{ requestId: string; platform: string; toolName: string }> = [];
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        resolveDecision: (requestId) => decisions.resolve(requestId),
        onRequestRegistered: (request) => registered.push(request),
      });

      // Phase 1: a POST without a requestId registers and mints one.
      const registration = await post(bridge.url, {
        platform: "codex",
        payload: { request: { tool_name: "Bash", tool_input: { command: "ls" } } },
      });
      assert.equal(registration.status, 200);
      const minted = registration.json.requestId;
      assert.equal(typeof minted, "string");
      assert.ok(minted!.length > 0);
      assert.equal(registered.length, 1);
      assert.equal(registered[0]!.toolName, "Bash");
      assert.equal(registered[0]!.platform, "codex");

      // Pre-recorded decisions replay immediately (fast path).
      decisions.record("req-1", "allow");
      decisions.record("req-2", "deny", "not in this workspace");
      const ok = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-1", tool_name: "Bash" },
      });
      assert.deepEqual(ok.json, { decision: "allow" });
      const denied = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-2" },
      });
      assert.deepEqual(denied.json, {
        decision: "deny",
        reason: "not in this workspace",
      });
    } finally {
      await bridge?.close();
    }
  });

  it("parks phase 2 until notifyDecision wakes it, denies only on human deny", async () => {
    const decisions = new ToolApprovalDecisionMap();
    let bridge: (ToolApprovalHttpBridge & {
      notifyDecision: (id: string, d: { decision: "allow" | "deny"; reason?: string } | null) => void;
    }) | null = null;
    try {
      bridge = (await startToolApprovalHttpBridge({
        port: 0,
        resolveDecision: (requestId) => decisions.resolve(requestId),
        waitMs: 60_000,
      })) as never;

      // Park a phase-2 call, then deliver the human deny mid-flight.
      const parked = post(bridge.url, {
        platform: "claude",
        payload: { requestId: "req-park", tool_name: "Bash" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      decisions.record("req-park", "deny", "human said no");
      bridge.notifyDecision("req-park", { decision: "deny", reason: "human said no" });
      const reply = await parked;
      assert.deepEqual(reply.json, {
        decision: "deny",
        reason: "human said no",
      });
    } finally {
      await bridge?.close();
    }
  });

  it("relays neutral after the wait budget expires without a decision", async () => {
    let bridge: ToolApprovalHttpBridge | null = null;
    try {
      bridge = await startToolApprovalHttpBridge({
        port: 0,
        resolveDecision: () => null,
        waitMs: 150,
      });
      const started = Date.now();
      const expired = await post(bridge.url, {
        platform: "codex",
        payload: { requestId: "req-never" },
      });
      assert.ok(Date.now() - started >= 140, "phase 2 must park for the budget");
      assert.deepEqual(expired.json, {
        decision: "allow",
        reason: "wait_timeout",
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

      // A malformed body parses as no payload: phase 1 semantics — mint an
      // id rather than fail. The hook then retries correlation with it.
      const malformed = await fetch(`${bridge.url}/control/tool-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(malformed.status, 200);
      const body = (await malformed.json()) as Record<string, unknown>;
      assert.equal(typeof body.requestId, "string");
    } finally {
      await bridge?.close();
    }
  });
});
