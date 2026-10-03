import http from "node:http";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAgentHub } from "../hub/index.js";
import type { AgentHub, HubStore } from "../hub/index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { DEFAULT_HUB_WS_PATH } from "../routes.js";
import {
  CONSOLE_PRINCIPAL,
  MemoryTokenStore,
  SqliteTokenStore,
  TokenRegistry,
  createRegistryAuthorizer,
} from "./token-registry.js";
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
import {
  handleConsoleToolApproval,
  handleConsolePolicyApproval,
} from "./tool-approval.js";
import { handleConsoleRun } from "./runs.js";
import { handleConsolePluginAction } from "./plugin-action.js";
import {
  createDesiredPluginCatalog,
  handleConsolePlugins,
} from "./plugins.js";
import {
  createIssueApiRoutes,
  createIssueConsoleHandlers,
  createIssueStore,
  type IssueApiIdentity,
} from "../issues/api.js";
import { createAgentApiRouter } from "../agent-api.js";
import type { RegisteredToken } from "./token-registry.js";
import type { IssueStore, IssueStoreOptions } from "../issues/store.js";
import { createIssueDispatcher, type IssueDispatcher } from "../issues/run-dispatch.js";
import { createStaticHandler } from "./static.js";
import {
  CONSOLE_OBSERVE_PATH,
  CONSOLE_SNAPSHOT_PATH,
  CONSOLE_RUNS_PATH,
  CONSOLE_PLUGIN_ACTION_PATH,
  CONSOLE_PLUGINS_PATH,
  CONSOLE_ISSUES_PATH,
  CONSOLE_ISSUE_INBOX_PATH,
  CONSOLE_TOOL_APPROVAL_PATH,
  CONSOLE_POLICY_APPROVAL_PATH,
  LOGIN_APPROVE_PATH,
  LOGIN_DENY_PATH,
} from "../routes.js";

export type ConsoleRuntime = {
  hub: AgentHub<string>;
  registry: TokenRegistry;
  state: ConsoleState;
  stream: ConsoleStreamContext;
  /** Per-client desired plugin/skill catalog, editable from the console. */
  plugins: ReturnType<typeof createDesiredPluginCatalog>;
  /** Issue domain: store + console handlers (M2) + run dispatcher (M3). */
  issues: {
    store: IssueStore;
    handlers: IssueConsoleHandle;
    dispatcher: IssueDispatcher | null;
  };
  close(): Promise<void>;
};

export type IssueConsoleHandle = ReturnType<typeof createIssueConsoleHandlers>;

export function createConsoleRuntime(options?: {
  store?: HubStore<string>;
  /** Issue DB file; omitted = in-memory issues that vanish with the process.
   *  Real hosts (the web command) pass the conventional `paths.issuesDb`. */
  issuesDbPath?: string;
  /** Console token DB file; omitted = in-memory tokens (fresh login per boot). */
  tokensDbPath?: string;
  /**
   * Directory of known agents for @name mention resolution. Defaults to the
   * live client registry (each connected client is mentionable as an agent
   * by its display name, keyed by clientId).
   */
  issueActors?: IssueStoreOptions["actors"];
  /**
   * Mention -> agent.run dispatch. Enabled by default (the dispatcher offers
   * through this hub with the console principal); pass false to disable.
   */
  issueDispatch?: false;
}): ConsoleRuntime {
  const registry = new TokenRegistry(
    options?.tokensDbPath
      ? new SqliteTokenStore(options.tokensDbPath)
      : new MemoryTokenStore(),
  );
  const state = new ConsoleState();
  // Dispatcher is assigned once the hub exists; the mention hook closes over
  // the mutable binding so the store can be created first.
  let dispatcher: IssueDispatcher | undefined;
  const issueStore = createIssueStore(options?.issuesDbPath ?? ":memory:", {
    actors:
      options?.issueActors ??
      (() =>
        state
          .snapshot()
          .clients.map((client) => ({
            id: client.clientId,
            displayName: client.name ?? client.clientId,
          }))),
    onAgentMention: (input) => dispatcher?.onAgentMention(input),
  });
  const issueHandlers = createIssueConsoleHandlers(issueStore);
  const stream: ConsoleStreamContext = {
    state,
    subscribers: new Set<ServerResponse>(),
    sequence: { value: 0 },
    hostWarning: null,
  };
  // Declared before the hub so the registration hook can close over it; the
  // hook only fires once a client connects, long after assignment.
  let plugins: ReturnType<typeof createDesiredPluginCatalog> | undefined;
  const hub = createAgentHub<string>({
    authorize: createRegistryAuthorizer(registry),
    // Client (re)connects are levelled up to the console's desired catalog:
    // edits made while a client was offline reach it without a manual re-push.
    onClientRegistered: ({ clientId }) => {
      void plugins?.push(clientId);
    },
    store: new ObservableStore<string>(
      options?.store ?? new MemoryHubStore<string>(),
      (observation) => {
        state.apply(observation);
        dispatcher?.onObservation(observation);
        broadcastConsole(stream, observation);
      },
    ),
  });
  if (options?.issueDispatch !== false) {
    dispatcher = createIssueDispatcher({
      store: issueStore,
      offer: (input) =>
        hub.offer({ principal: CONSOLE_PRINCIPAL, ...input }),
    });
  }
  plugins = createDesiredPluginCatalog(hub);
  return {
    hub,
    registry,
    state,
    stream,
    plugins,
    issues: {
      store: issueStore,
      handlers: issueHandlers,
      dispatcher: dispatcher ?? null,
    },
    async close() {
      issueStore.close();
      await registry.close();
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
    if (request.method === "GET" && url.pathname === CONSOLE_SNAPSHOT_PATH) {
      const snapshot = runtime.state.snapshot();
      // no-store: this is a live-data refetch endpoint; a heuristically cached
      // response would make the console timeline look frozen after a run.
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          ...snapshot,
          warning: runtime.stream.hostWarning,
        }),
      );
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
        url.pathname === CONSOLE_POLICY_APPROVAL_PATH ||
        url.pathname === CONSOLE_PLUGIN_ACTION_PATH ||
        url.pathname === CONSOLE_PLUGINS_PATH ||
        url.pathname === CONSOLE_ISSUES_PATH ||
        url.pathname === CONSOLE_ISSUE_INBOX_PATH ||
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
    if (request.method === "POST" && url.pathname === CONSOLE_POLICY_APPROVAL_PATH) {
      await handleConsolePolicyApproval(runtime, request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === CONSOLE_RUNS_PATH) {
      await handleConsoleRun(runtime, request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === CONSOLE_PLUGIN_ACTION_PATH) {
      await handleConsolePluginAction(runtime, request, response);
      return true;
    }
    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === CONSOLE_ISSUES_PATH
    ) {
      await runtime.issues.handlers.handleIssues(request, response);
      return true;
    }
    if (request.method === "GET" && url.pathname === CONSOLE_ISSUE_INBOX_PATH) {
      runtime.issues.handlers.handleInbox(response, request);
      return true;
    }
    if (
      (request.method === "GET" || request.method === "POST") &&
      url.pathname === CONSOLE_PLUGINS_PATH
    ) {
      await handleConsolePlugins(runtime, request, response);
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
  /** Passed through to createConsoleRuntime; conventional files by default. */
  issuesDbPath?: string;
  tokensDbPath?: string;
}): Promise<ConsoleSiteHandle> {
  const host = options?.host ?? "127.0.0.1";
  const runtime = createConsoleRuntime({
    store: options?.store,
    issuesDbPath: options?.issuesDbPath,
    tokensDbPath: options?.tokensDbPath,
  });
  runtime.stream.hostWarning = isLoopbackHost(host)
    ? null
    : `console 正监听非回环地址（--host ${host}），仅限受信任本机网络使用`;
  const router = createConsoleRouter(runtime, {
    staticRoot: options?.staticRoot,
    beforeStatic: createIssueAgentApiHandler(runtime),
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

/**
 * The issue REST surface under /_agentkit/api/v1, authenticated by console
 * registry tokens. Author identity is derived from the verified token —
 * comments created here are always attributed to the agent that made them.
 */
export function createIssueAgentApiHandler(
  runtime: ConsoleRuntime,
): ReturnType<typeof createAgentApiRouter<IssueApiIdentity>> {
  return createAgentApiRouter<IssueApiIdentity>({
    authenticate: async (token) => {
      const record: RegisteredToken | null = await runtime.registry.verify(token);
      return record
        ? { principal: record, clientId: record.clientId }
        : null;
    },
    routes: createIssueApiRoutes(runtime.issues.store),
  });
}

/** Shared loopback gate: embedders (web/server.ts) arm hostWarning with it too. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
