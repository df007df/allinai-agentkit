import http from "node:http";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAgentHub } from "../hub/index.js";
import type { AgentHub, HubStore } from "../hub/index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { DEFAULT_HUB_WS_PATH } from "../routes.js";
import { TokenRegistry, createRegistryAuthorizer } from "./token-registry.js";
import { ObservableStore } from "./observable-store.js";
import { ConsoleState } from "./state.js";
import type { ConsoleStreamContext } from "./observe.js";
import {
  broadcastConsole,
  handleConsoleObserve,
} from "./observe.js";
import {
  handleConsoleLoginApprove,
  handleConsoleLoginDeny,
} from "./login-bridge.js";
import { handleConsoleToolApproval } from "./tool-approval.js";
import { handleConsoleRun } from "./runs.js";
import { createStaticHandler } from "./static.js";
import {
  CONSOLE_OBSERVE_PATH,
  CONSOLE_RUNS_PATH,
  CONSOLE_TOOL_APPROVAL_PATH,
  LOGIN_APPROVE_PATH,
  LOGIN_DENY_PATH,
} from "../routes.js";

export type ConsoleRuntime = {
  hub: AgentHub<string>;
  registry: TokenRegistry;
  state: ConsoleState;
  stream: ConsoleStreamContext;
  close(): Promise<void>;
};

export function createConsoleRuntime(options?: {
  store?: HubStore<string>;
}): ConsoleRuntime {
  const registry = new TokenRegistry();
  const state = new ConsoleState();
  const stream: ConsoleStreamContext = {
    state,
    subscribers: new Set<ServerResponse>(),
    sequence: { value: 0 },
    hostWarning: null,
  };
  const hub = createAgentHub<string>({
    authorize: createRegistryAuthorizer(registry),
    store: new ObservableStore<string>(
      options?.store ?? new MemoryHubStore<string>(),
      (observation) => {
        state.apply(observation);
        broadcastConsole(stream, observation);
      },
    ),
  });
  return {
    hub,
    registry,
    state,
    stream,
    async close() {
      await hub.close();
    },
  };
}

/** Returns true when the request was handled. Order: observe → login → beforeStatic → static. */
export function createConsoleRouter(
  runtime: ConsoleRuntime,
  options?: {
    staticRoot?: string;
    beforeStatic?: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<boolean>;
  },
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const staticHandler = options?.staticRoot
    ? createStaticHandler(options.staticRoot)
    : null;
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://console.invalid");
    if (request.method === "GET" && url.pathname === CONSOLE_OBSERVE_PATH) {
      handleConsoleObserve(runtime.stream, request, response);
      return true;
    }
    // The console write endpoints are unauthenticated by design: their only
    // protection is the loopback-only deployment contract. When the host is
    // non-loopback (hostWarning set), refuse them before any handler runs so
    // a LAN-reachable console cannot mint tokens or relay approvals.
    if (
      runtime.stream.hostWarning !== null &&
      request.method === "POST" &&
      (url.pathname === LOGIN_APPROVE_PATH ||
        url.pathname === LOGIN_DENY_PATH ||
        url.pathname === CONSOLE_TOOL_APPROVAL_PATH ||
        url.pathname === CONSOLE_RUNS_PATH)
    ) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "loopback_only" }));
      return true;
    }
    if (request.method === "POST" && url.pathname === LOGIN_APPROVE_PATH) {
      await handleConsoleLoginApprove(runtime, request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === LOGIN_DENY_PATH) {
      await handleConsoleLoginDeny(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === CONSOLE_TOOL_APPROVAL_PATH) {
      await handleConsoleToolApproval(runtime, request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === CONSOLE_RUNS_PATH) {
      await handleConsoleRun(runtime, request, response);
      return true;
    }
    if (options?.beforeStatic) {
      if (await options.beforeStatic(request, response)) return true;
    }
    if (staticHandler) {
      staticHandler(request, response);
      return true;
    }
    return false;
  };
}

export type ConsoleSiteHandle = {
  url: string;
  hubUrl: string;
  runtime: ConsoleRuntime;
  close(): Promise<void>;
};

export async function startConsoleServer(options?: {
  port?: number;
  host?: string;
  store?: HubStore<string>;
  staticRoot?: string;
}): Promise<ConsoleSiteHandle> {
  const host = options?.host ?? "127.0.0.1";
  const runtime = createConsoleRuntime({ store: options?.store });
  runtime.stream.hostWarning = isLoopbackHost(host)
    ? null
    : `console 正监听非回环地址（--host ${host}），仅限受信任本机网络使用`;
  const router = createConsoleRouter(runtime, {
    staticRoot: options?.staticRoot,
  });
  const server = http.createServer();
  runtime.hub.attach(server, {
    fallback: (request, response) => {
      void router(request, response)
        .then((handled) => {
          if (handled) return; // responder owns the response end
          if (!response.headersSent) response.writeHead(404);
          response.end(JSON.stringify({ error: "not_found" }));
        })
        .catch(() => {
          // Aborted POST bodies throw in readJsonBody; without this catch the
          // rejection is unhandled and kills the process.
          if (!response.headersSent) {
            response.writeHead(400, { "content-type": "application/json" });
          }
          try {
            response.end(JSON.stringify({ error: "bad_request" }));
          } catch {
            // The client is gone; nothing left to answer.
          }
        });
    },
  });
  server.listen(options?.port ?? 4317, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("console server failed to listen");
  }
  const url = `http://${host}:${address.port}`;
  return {
    url,
    hubUrl: `${url.replace("http", "ws")}${DEFAULT_HUB_WS_PATH}`,
    runtime,
    async close() {
      for (const response of runtime.stream.subscribers) response.destroy();
      runtime.stream.subscribers.clear();
      await runtime.hub.close();
      server.close();
      await once(server, "close");
    },
  };
}

/** Shared loopback gate: embedders (web/server.ts) arm hostWarning with it too. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
