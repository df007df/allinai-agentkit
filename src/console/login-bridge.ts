import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenRegistry } from "./token-registry.js";

export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

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

function appendQuery(target: string, params: Record<string, string>): string {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function handleConsoleLoginApprove(
  context: { registry: TokenRegistry },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const state = typeof body.state === "string" ? body.state : "";
  const redirectUri =
    typeof body.redirectUri === "string" ? body.redirectUri : "";
  if (!clientId || !state || !isLoopbackRedirect(redirectUri)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_login_request" }));
    return;
  }
  const record = context.registry.register(clientId);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      redirectUrl: appendQuery(redirectUri, {
        token: record.token,
        state,
      }),
    }),
  );
}

export async function handleConsoleLoginDeny(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const state = typeof body.state === "string" ? body.state : "";
  const redirectUri =
    typeof body.redirectUri === "string" ? body.redirectUri : "";
  if (!state || !isLoopbackRedirect(redirectUri)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_login_request" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      redirectUrl: appendQuery(redirectUri, {
        error: "access_denied",
        state,
      }),
    }),
  );
}
