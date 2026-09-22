import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeApprovalRequest,
  encodeApprovalResponse,
  parseApprovalRequest,
  parseApprovalResponse,
  parseRunnerChildMessage,
  parseRunnerStart,
} from "./runner-wire.js";

describe("runner wire validation", () => {
  it("rejects unknown keys in a start frame and its declared input", () => {
    const base = {
      type: "run.start",
      executionId: "execution-1",
      input: { platform: "codex", prompt: "hello" },
    };

    assert.notEqual(parseRunnerStart(base), null);
    assert.equal(parseRunnerStart({ ...base, command: "sh" }), null);
    assert.equal(
      parseRunnerStart({
        ...base,
        input: { ...base.input, executable: "codex" },
      }),
      null,
    );
  });

  it("rejects unknown keys in child frames and normalized events", () => {
    const base = {
      type: "event",
      event: { type: "text_delta", payload: { text: "hello" } },
    };

    assert.notEqual(parseRunnerChildMessage(base), null);
    assert.equal(parseRunnerChildMessage({ ...base, shell: true }), null);
    assert.equal(
      parseRunnerChildMessage({
        ...base,
        event: { ...base.event, executable: "codex" },
      }),
      null,
    );
  });
});

describe("runner tool approval wire", () => {
  it("round-trips an approval request through encode and parse", () => {
    const request = {
      type: "tool_approval.request" as const,
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
    };
    const parsed = parseApprovalRequest(JSON.parse(encodeApprovalRequest(request)));
    assert.deepEqual(parsed, request);
  });

  it("rejects malformed approval requests", () => {
    assert.equal(
      parseApprovalRequest({ type: "tool_approval.request", requestId: "", toolName: "Bash", toolInput: {} }),
      null,
    );
    assert.equal(
      parseApprovalRequest({ type: "tool_approval.request", requestId: "r1", toolName: "Bash", toolInput: "x" }),
      null,
    );
    assert.equal(parseApprovalRequest({ type: "event", event: { type: "done" } }), null);
  });

  it("round-trips an approval response and rejects malformed ones", () => {
    const response = {
      type: "tool_approval.response" as const,
      requestId: "req-1",
      decision: "deny" as const,
      reason: "not today",
    };
    const parsed = parseApprovalResponse(
      JSON.parse(encodeApprovalResponse(response)),
    );
    assert.deepEqual(parsed, response);
    assert.equal(parseApprovalResponse({ ...response, decision: "maybe" }), null);
    assert.equal(parseApprovalResponse({ ...response, requestId: "" }), null);
    const { reason: _reason, ...withoutReason } = response;
    assert.deepEqual(parseApprovalResponse(withoutReason), withoutReason);
  });
});
