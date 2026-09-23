import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleRuntime } from "./runtime.js";
import { CONSOLE_PRINCIPAL } from "./token-registry.js";
import { CLIENT_RUNTIME_IDS, type RuntimeId } from "../protocol/index.js";

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += chunk.toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as unknown) as Record<string, unknown> : {};
  } catch {
    throw new Error("invalid JSON body");
  }
}

/**
 * Trigger an agent run on one client from the console: relays the prompt (and
 * optional locally-registered project name) through the hub offer channel as
 * an agent.run command. Admission still happens on the client — the local
 * policy decides auto/approval/deny exactly as for any other Hub run.
 */
export async function handleConsoleRun(
  runtime: ConsoleRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const runtime_ = typeof body.runtime === "string" ? body.runtime : "";
  const project = typeof body.project === "string" ? body.project : undefined;
  if (!clientId || !prompt.trim() || !CLIENT_RUNTIME_IDS.includes(runtime_ as RuntimeId)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "invalid_run_request",
        required: ["clientId", "prompt (nonempty)", "runtime"],
        allowedRuntimes: CLIENT_RUNTIME_IDS,
      }),
    );
    return;
  }
  try {
    const offer = await runtime.hub.offer({
      principal: CONSOLE_PRINCIPAL,
      targetClientId: clientId,
      command: {
        kind: "agent.run",
        commandId: randomUUID(),
        executionId: randomUUID(),
        taskId: `console-${randomUUID()}`,
        attempt: 1,
        runtime: runtime_ as RuntimeId,
        payload: {
          prompt,
          ...(project ? { project } : {}),
        },
      },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        delivered: Boolean(offer.offerId),
        offerId: offer.offerId,
        executionId: offer.command.kind === "agent.run" ? offer.command.executionId : undefined,
      }),
    );
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "run_relay_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
