import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { createAgentHub, type AgentHub } from "../hub/index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { ObservableStore } from "./observable-store.js";
import { DemoProjection } from "./projection.js";
import { createStaticHandler, resolveWebRoot } from "./static.js";
import {
  createRegistryAuthorizer,
  DEMO_PRINCIPAL,
  TokenRegistry,
} from "./token-registry.js";

export type DemoRouterContext = {
  hub: AgentHub<string>;
  registry: TokenRegistry;
  projection: DemoProjection;
  subscribers: Set<ServerResponse>;
  sequence: { value: number };
  /** 非 null 时（--host 非回环）随 SSE 快照下发页面警示文案。 */
  hostWarning: string | null;
};

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

async function handleLoginApprove(
  context: DemoRouterContext,
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
  const record = context.registry.register(clientId, "login");
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

async function handleLoginDeny(
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

export function createDemoRouter(
  context: DemoRouterContext,
): (request: IncomingMessage, response: ServerResponse) => void {
  const staticHandler = createStaticHandler(resolveWebRoot());
  // offers 路由在后续任务中在此分派（见 Task 8）。
  return (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://demo.invalid");
        if (
          request.method === "GET" &&
          url.pathname === "/api/demo/observe"
        ) {
          handleObserve(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === "/login/approve") {
          await handleLoginApprove(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === "/login/deny") {
          await handleLoginDeny(request, response);
          return;
        }
        staticHandler(request, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: "internal_error" }));
      }
    })();
  };
}

function handleObserve(
  context: DemoRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `event: snapshot\ndata: ${JSON.stringify({
      ...context.projection.snapshot(),
      warning: context.hostWarning,
    })}\n\n`,
  );
  context.subscribers.add(response);
  const ping = setInterval(() => response.write(": ping\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(ping);
    context.subscribers.delete(response);
  });
}

export type DemoSiteHandle = {
  url: string;
  hubUrl: string;
  bootstrapToken: string;
  registry: TokenRegistry;
  close(): Promise<void>;
};

export async function startDemoSiteCore(options: {
  port?: number;
  host?: string;
}): Promise<DemoSiteHandle> {
  const host = options.host ?? "127.0.0.1";
  const registry = new TokenRegistry();
  const projection = new DemoProjection();
  const subscribers = new Set<ServerResponse>();
  const sequence = { value: 0 };
  const memory = new MemoryHubStore<string>();
  const store = new ObservableStore<string>(memory, (observation) => {
    projection.apply(observation);
    broadcast(subscribers, sequence, observation);
  });
  const hub = createAgentHub<string>({
    authorize: createRegistryAuthorizer(registry),
    store,
  });
  const context: DemoRouterContext = {
    hub,
    registry,
    projection,
    subscribers,
    sequence,
    hostWarning: isLoopbackHost(host)
      ? null
      : `demo 正监听非回环地址（--host ${host}），仅限受信任本机网络使用`,
  };
  const server = http.createServer();
  hub.attach(server, { fallback: createDemoRouter(context) });
  server.listen(options.port ?? 4317, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("demo server failed to listen");
  }
  const bootstrap = registry.register("bootstrap-cli", "bootstrap");
  const url = `http://${host}:${address.port}`;
  return {
    url,
    hubUrl: `${url.replace("http", "ws")}/api/agent-hub/v2/ws`,
    bootstrapToken: bootstrap.token,
    registry,
    async close() {
      for (const response of subscribers) response.destroy();
      subscribers.clear();
      await hub.close();
      server.close();
      await once(server, "close");
    },
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function broadcast(
  subscribers: Set<ServerResponse>,
  sequence: { value: number },
  observation: unknown,
): void {
  const payload = `event: observation\ndata: ${JSON.stringify({
    seq: (sequence.value += 1),
    ...(observation as object),
  })}\n\n`;
  for (const response of subscribers) response.write(payload);
}

export { DEMO_PRINCIPAL };
