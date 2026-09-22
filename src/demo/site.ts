import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { createAgentHub, type AgentHub, type HubStore } from "../hub/index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { ObservableStore } from "./observable-store.js";
import { DemoProjection } from "./projection.js";
import { createStaticHandler, resolveWebRoot } from "./static.js";
import { createAgentApiRouter } from "../agent-api.js";
import {
  createRegistryAuthorizer,
  DEMO_PRINCIPAL,
  TokenRegistry,
} from "./token-registry.js";
import {
  DEFAULT_HUB_WS_PATH,
  CONSOLE_INVENTORY_PATH,
  CONSOLE_INVENTORY_QUERY_PATH,
  CONSOLE_OBSERVE_PATH,
  CONSOLE_OFFERS_PATH,
  CONSOLE_PLUGIN_SYNC_PATH,
  LOGIN_APPROVE_PATH,
  LOGIN_DENY_PATH,
} from "../routes.js";

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

function parseDemoRuntime(
  value: string,
): "codex" | "claude" | "pi" | "zcode" {
  switch (value) {
    case "codex":
    case "claude":
    case "pi":
    case "zcode":
      return value;
    default:
      return "codex";
  }
}

async function handleOffers(
  context: DemoRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const runtimeCandidate =
    typeof body.runtime === "string" ? body.runtime : "";
  const project =
    typeof body.project === "string" && body.project.trim()
      ? body.project.trim()
      : undefined;
  if (!clientId || !prompt) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_offer_request" }));
    return;
  }
  if (!context.projection.hasClient(clientId)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown_client" }));
    return;
  }
  const runtime = parseDemoRuntime(runtimeCandidate);
  const offer = await context.hub.offer({
    principal: DEMO_PRINCIPAL,
    targetClientId: clientId,
    command: {
      kind: "agent.run",
      commandId: randomUUID(),
      executionId: randomUUID(),
      taskId: `demo-${randomUUID()}`,
      attempt: 1,
      runtime,
      payload: { prompt, ...(project ? { project } : {}) },
    },
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ offerId: offer.offerId }));
}

async function handlePluginSync(
  context: DemoRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const revision =
    typeof body.revision === "string" && body.revision.trim()
      ? body.revision.trim()
      : `demo-${Date.now()}`;
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];
  if (!clientId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_plugin_sync_request" }));
    return;
  }
  if (!context.projection.hasClient(clientId)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown_client" }));
    return;
  }
  try {
    const result = await context.hub.syncPlugins({
      principal: DEMO_PRINCIPAL,
      targetClientId: clientId,
      revision,
      plugins: plugins as never,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "invalid_plugin_sync",
      }),
    );
  }
}

async function handleInventoryQuery(
  context: DemoRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!clientId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_inventory_request" }));
    return;
  }
  if (!context.projection.hasClient(clientId)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown_client" }));
    return;
  }
  const result = await context.hub.syncPlugins({
    principal: DEMO_PRINCIPAL,
    targetClientId: clientId,
    revision: `inventory-${Date.now()}`,
    plugins: [],
    inventoryQuery: true,
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
}

function handleInventoryGet(
  context: DemoRouterContext,
  pathname: string,
  response: ServerResponse,
): void {
  const clientId = decodeURIComponent(
    pathname.slice(`${CONSOLE_INVENTORY_PATH}/`.length),
  );
  void context.hub
    .getInventory({ principal: DEMO_PRINCIPAL, clientId })
    .then((report) => {
      if (!report) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no_report" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(report));
    })
    .catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "internal_error" }));
    });
}

export function createDemoRouter(
  context: DemoRouterContext,
): (request: IncomingMessage, response: ServerResponse) => void {
  const staticHandler = createStaticHandler(resolveWebRoot());
  // 示例业务挂载面：站点声明路由，鉴权由组件自动装配（身份从 token 派生）。
  const agentApi = createAgentApiRouter({
    authenticate: (token) => {
      const record = context.registry.verify(token);
      if (!record) return null;
      return { principal: DEMO_PRINCIPAL, clientId: record.clientId };
    },
    routes: [
      {
        method: "GET",
        path: "/whoami",
        handler: ({ identity, response }) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              clientId: identity.clientId,
              principal: identity.principal,
            }),
          );
        },
      },
      {
        method: "POST",
        path: "/tasks",
        handler: async ({ identity, body, response }) => {
          const prompt = typeof body.prompt === "string" ? body.prompt : "";
          if (!prompt) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "prompt_required" }));
            return;
          }
          try {
            const offer = await context.hub.offer({
              principal: identity.principal,
              targetClientId: identity.clientId,
              command: {
                kind: "agent.run",
                commandId: randomUUID(),
                executionId: randomUUID(),
                taskId: `api-${randomUUID()}`,
                attempt: 1,
                runtime: parseDemoRuntime(
                  typeof body.runtime === "string" ? body.runtime : "",
                ),
                payload: {
                  prompt,
                  ...(typeof body.project === "string" && body.project.trim()
                    ? { project: body.project.trim() }
                    : {}),
                },
              },
            });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ offerId: offer.offerId }));
          } catch (error) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "invalid_task",
              }),
            );
          }
        },
      },
    ],
  });
  return (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://demo.invalid");
        if (
          request.method === "GET" &&
          url.pathname === CONSOLE_OBSERVE_PATH
        ) {
          handleObserve(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === LOGIN_APPROVE_PATH) {
          await handleLoginApprove(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === LOGIN_DENY_PATH) {
          await handleLoginDeny(request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === CONSOLE_OFFERS_PATH) {
          await handleOffers(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === CONSOLE_PLUGIN_SYNC_PATH) {
          await handlePluginSync(context, request, response);
          return;
        }
        if (request.method === "POST" && url.pathname === CONSOLE_INVENTORY_QUERY_PATH) {
          await handleInventoryQuery(context, request, response);
          return;
        }
        if (request.method === "GET" && url.pathname.startsWith(`${CONSOLE_INVENTORY_PATH}/`)) {
          handleInventoryGet(context, url.pathname, response);
          return;
        }
        if (await agentApi(request, response)) return;
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
  registry: TokenRegistry;
  close(): Promise<void>;
};

export async function startDemoSiteCore(options: {
  port?: number;
  host?: string;
  store?: HubStore<string>;
}): Promise<DemoSiteHandle> {
  const host = options.host ?? "127.0.0.1";
  const registry = new TokenRegistry();
  const projection = new DemoProjection();
  const subscribers = new Set<ServerResponse>();
  const sequence = { value: 0 };
  const memory = options.store ?? new MemoryHubStore<string>();
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
  const url = `http://${host}:${address.port}`;
  return {
    url,
    hubUrl: `${url.replace("http", "ws")}${DEFAULT_HUB_WS_PATH}`,
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
