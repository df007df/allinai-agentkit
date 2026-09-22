import http from "node:http";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import next from "next";

/**
 * EMBEDDING CONTRACT (Task 2 review): `createConsoleRouter`'s static handler
 * serves BARE, UNPREFIXED paths from its `staticRoot` (`/x` → `x.html`, and a
 * bare visit redirects to `/_agentkit/`). An embedder that mounts
 * `createConsoleRouter` on its own server therefore takes over every unmatched
 * path once the static handler is configured. Embedders must mount the router
 * under a reserved prefix, or strictly AFTER their own routes so their
 * handlers see the request first.
 *
 * This package's custom server makes that deterministic: ONLY paths under
 * `/_agentkit` (AGENTKIT_ROOT_PREFIX) are routed to the console router
 * (hub WebSocket upgrade + observe/login endpoints + 404); every other path —
 * including `/` — goes to Next.js. Embedders copying this wiring get the same
 * isolation for free.
 */

import { AGENTKIT_ROOT_PREFIX, DEFAULT_HUB_WS_PATH } from "@allin-ai/agentkit/routes";
import {
  createConsoleRuntime,
  createConsoleRouter,
  isLoopbackHost,
} from "@allin-ai/agentkit/console";

type ConsoleRouter = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

/**
 * The hub's request fallback: console-owned `/_agentkit/*` traffic goes to
 * the console router (unknown prefixed paths answer a JSON 404); everything
 * else is handed to Next. Extracted as a factory so the wiring is testable
 * without booting Next (web/server.test.ts).
 */
export function createAgentkitFallback(params: {
  router: ConsoleRouter;
  nextHandler: (request: IncomingMessage, response: ServerResponse) => void;
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    void (async () => {
      const pathname = new URL(
        request.url ?? "/",
        "http://web.invalid",
      ).pathname;
      if (
        pathname === AGENTKIT_ROOT_PREFIX ||
        pathname.startsWith(`${AGENTKIT_ROOT_PREFIX}/`)
      ) {
        const handled = await params.router(request, response);
        if (!handled && !response.headersSent) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
        }
        return;
      }
      params.nextHandler(request, response);
    })().catch(() => {
      // Aborted POST bodies throw in readJsonBody; without this catch the
      // rejection is unhandled and kills the process.
      if (!response.headersSent) {
        try {
          response.writeHead(400, { "content-type": "application/json" });
        } catch {
          // Headers already sent by a losing race; fall through to end().
        }
      }
      try {
        response.end(JSON.stringify({ error: "bad_request" }));
      } catch {
        // The client is gone; nothing left to answer.
      }
    });
  };
}

export async function startWebHost(options?: {
  port?: number;
  host?: string;
  dev?: boolean;
}): Promise<{
  url: string;
  hubUrl: string;
  /** Console runtime handle; exposes stream.hostWarning for tests/embedders. */
  runtime: ReturnType<typeof createConsoleRuntime>;
  close(): Promise<void>;
}> {
  const host = options?.host ?? "127.0.0.1";
  const dev = options?.dev ?? process.argv.includes("--dev");
  const runtime = createConsoleRuntime();
  // Mirrors startConsoleServer: the console write endpoints are unauthenticated
  // by design and rely on loopback-only deployment. Arm the warning (which the
  // router turns into 403s) whenever the host is non-loopback, so this gate
  // actually fires in the web package too.
  runtime.stream.hostWarning = isLoopbackHost(host)
    ? null
    : `console 正监听非回环地址（--host ${host}），仅限受信任本机网络使用`;
  const router = createConsoleRouter(runtime);

  const app = next({ dev, dir: import.meta.dirname });
  await app.prepare();
  const nextHandler = app.getRequestHandler();

  const server = http.createServer();
  // hub.attach registers the server's ONLY `request` listener; all non-hub
  // traffic flows through the fallback below (never also server.on("request")).
  runtime.hub.attach(server, {
    fallback: createAgentkitFallback({ router, nextHandler }),
  });
  server.listen(options?.port ?? 4317, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("web server failed to listen");
  }
  const url = `http://${host}:${address.port}`;
  // Task 11 review hard requirement: the CLI must never derive the hub
  // endpoint from the URL alone — this path-carrying hubUrl is the live path.
  const hubUrl = `${url.replace(/^http/, "ws")}${DEFAULT_HUB_WS_PATH}`;
  return {
    url,
    hubUrl,
    runtime,
    async close() {
      // SSE subscribers hold the server's sockets open; destroy them first or
      // server.close() never settles (mirrors startConsoleServer.close).
      for (const response of runtime.stream.subscribers) response.destroy();
      runtime.stream.subscribers.clear();
      await runtime.close();
      server.close();
      await once(server, "close");
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const portFlag = process.argv.indexOf("--port");
  void startWebHost({
    port: portFlag > -1 ? Number(process.argv[portFlag + 1]) : undefined,
  }).then((w) => {
    console.log(`agentkit console: ${w.url}`);
    console.log(`agentkit hub ws:  ${w.hubUrl}`);
  });
}
