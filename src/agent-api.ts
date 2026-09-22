import type { IncomingMessage, ServerResponse } from "node:http";
import { RESERVED_AGENTKIT_SEGMENTS } from "./routes.js";

/**
 * Declarative mounting surface for host business routes authenticated by
 * agent tokens. The site declares routes; this component assembles the
 * authorization pipeline (extract Bearer token -> authenticate -> inject
 * identity) so handlers never parse credentials themselves.
 *
 * All routes must live under `/_agentkit/api/v1` (the reserved business
 * namespace) and must not collide with the framework's own second-level
 * segments; violations throw at construction time, not at request time.
 */

/** Identity derived from the verified token — never client-supplied. */
export type AgentApiIdentity<Principal> = {
  principal: Principal;
  clientId: string;
};

export type AgentApiRouteContext<Principal> = {
  request: IncomingMessage;
  response: ServerResponse;
  /** Matched path parameters (`:name` segments), percent-decoded. */
  params: Record<string, string>;
  /** Parsed JSON body; {} for empty or malformed bodies. */
  body: Record<string, unknown>;
  identity: AgentApiIdentity<Principal>;
};

export type AgentApiRoute<Principal> = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Pattern under the business namespace, e.g. "/tasks/:taskId". */
  path: string;
  handler: (context: AgentApiRouteContext<Principal>) => void | Promise<void>;
};

export type AgentApiAuthenticator<Principal> = (
  token: string,
  request: IncomingMessage,
) => Promise<AgentApiIdentity<Principal> | null> | AgentApiIdentity<Principal> | null;

export type AgentApiRouterOptions<Principal> = {
  authenticate: AgentApiAuthenticator<Principal>;
  routes: AgentApiRoute<Principal>[];
};

/** The one reserved namespace host business routes may occupy. */
export const AGENT_API_NAMESPACE = "/_agentkit/api/v1";

type CompiledRoute<Principal> = {
  method: AgentApiRoute<Principal>["method"];
  segments: string[];
  handler: AgentApiRoute<Principal>["handler"];
};

function compileRoute<Principal>(
  route: AgentApiRoute<Principal>,
): CompiledRoute<Principal> {
  if (!route.path.startsWith("/") || route.path.endsWith("/")) {
    throw new TypeError(
      `Agent API route path must be absolute without trailing slash: "${route.path}"`,
    );
  }
  const segments = route.path.slice(1).split("/");
  for (const segment of segments) {
    if (!segment) {
      throw new TypeError(
        `Agent API route path has an empty segment: "${route.path}"`,
      );
    }
    if (segment.startsWith(":") && segment.length < 2) {
      throw new TypeError(
        `Agent API route path has an unnamed parameter: "${route.path}"`,
      );
    }
  }
  return { method: route.method, segments, handler: route.handler };
}

function assertNamespaceFree<Principal>(
  routes: AgentApiRoute<Principal>[],
): void {
  for (const route of routes) {
    const segments = route.path.replace(/^\//, "").split("/");
    for (const segment of segments) {
      if (
        (RESERVED_AGENTKIT_SEGMENTS as readonly string[]).includes(segment)
      ) {
        throw new TypeError(
          `Agent API route "${route.path}" uses reserved segment "${segment}"`,
        );
      }
    }
  }
}

function matchRoute<Principal>(
  compiled: CompiledRoute<Principal>,
  segments: string[],
): Record<string, string> | null {
  if (compiled.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < compiled.segments.length; index += 1) {
    const pattern = compiled.segments[index]!;
    const actual = segments[index]!;
    if (pattern.startsWith(":")) {
      params[pattern.slice(1)] = decodeURIComponent(actual);
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : "";
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

/**
 * Builds a request listener handling every declared business route under
 * `/_agentkit/api/v1`. Returns false for requests outside the namespace so
 * the host router (or the console fallback chain) can continue.
 */
export function createAgentApiRouter<Principal>(
  options: AgentApiRouterOptions<Principal>,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  assertNamespaceFree(options.routes);
  const compiled = options.routes.map(compileRoute);
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://api.invalid");
    if (!url.pathname.startsWith(`${AGENT_API_NAMESPACE}/`)) return false;
    const segments = url.pathname
      .slice(AGENT_API_NAMESPACE.length + 1)
      .split("/");
    try {
      for (const route of compiled) {
        const params = matchRoute(route, segments);
        if (!params || route.method !== request.method) continue;
        const identity = await options.authenticate(
          bearerToken(request),
          request,
        );
        if (!identity) {
          sendJson(response, 401, { error: "unauthorized" });
          return true;
        }
        const body = request.method === "GET" ? {} : await readJsonBody(request);
        await route.handler({ request, response, params, body, identity });
        return true;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "internal_error",
        });
      } else {
        response.end();
      }
    }
    return true;
  };
}
