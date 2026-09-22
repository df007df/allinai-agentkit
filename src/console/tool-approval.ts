import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleRuntime } from "./runtime.js";
import { CONSOLE_PRINCIPAL } from "./token-registry.js";

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Relay a human tool-approval decision to the owning agent daemon through the
 * existing WS offer channel: the daemon receives task.offer and writes back to
 * its runner inside supervisor.handleCommand — no new execution is created.
 */
export async function handleConsoleToolApproval(
  runtime: ConsoleRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const executionId =
    typeof body.executionId === "string" ? body.executionId : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const decision =
    body.decision === "allow" || body.decision === "deny" ? body.decision : "";
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  if (!clientId || !executionId || !requestId || !decision) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "invalid_approval_request",
        required: ["clientId", "executionId", "requestId", "decision"],
      }),
    );
    return;
  }
  try {
    const offer = await runtime.hub.offer({
      principal: CONSOLE_PRINCIPAL,
      targetClientId: clientId,
      command: {
        kind: "respond_tool_approval",
        commandId: randomUUID(),
        executionId,
        requestId,
        decision,
        ...(reason ? { reason } : {}),
      },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ delivered: Boolean(offer.offerId) }));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "approval_relay_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
