import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A minimal loopback HTTP bridge in front of the daemon's control surface.
 * The platform tool ask-user hooks (delivered with the agentkit-system
 * plugin) POST here in two phases; the JSON reply relays the human decision.
 * Only tool-approval routing lives on HTTP; everything else stays on the
 * authenticated Unix-socket control server.
 *
 * Phase 1 — registration: a POST whose payload carries no requestId mints a
 * fresh requestId, registers a waiter, and answers {requestId}. The hook
 * echoes that id in phase 2, so a human decision made in the console
 * (routed through the same requestId) can be matched back.
 *
 * Phase 2 — decision wait: a POST whose payload carries the requestId parks
 * until a human decision for that id arrives (recorded by the daemon's
 * respond-tool-approval wrapper) or the wait budget expires. Expired or
 * unknown ids relay a neutral non-deny so the hook (deny-only) passes the
 * tool call through. The bridge NEVER decides on its own.
 */

export type ToolApprovalHttpBridgeOptions = {
  /**
   * Resolves the human decision previously recorded for a request id, or null
   * when no console-originated decision has arrived yet.
   */
  resolveDecision: (
    requestId: string,
  ) => { decision: "allow" | "deny"; reason?: string } | null;
  /** Notified when a hook registers a new requestId (phase 1). */
  onRequestRegistered?: (request: ToolApprovalHookRequest) => void;
  host?: string;
  port?: number;
  /**
   * How long phase 2 parks before relaying a neutral answer. Human
   * decisions usually arrive in minutes; the cap exists so a forgotten
   * hook call cannot hold a socket forever.
   */
  waitMs?: number;
};

export type ToolApprovalHookRequest = {
  requestId: string;
  platform: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type ToolApprovalHttpBridge = {
  url: string;
  close(): Promise<void>;
};

type ApprovalPayload = {
  platform?: unknown;
  payload?: {
    requestId?: unknown;
    tool_name?: unknown;
    toolName?: unknown;
    tool_input?: unknown;
    input?: unknown;
    request?: unknown;
    [key: string]: unknown;
  };
};

/** Cap of concurrently parked phase-2 waiters (bounded memory). */
const MAX_WAITERS = 64;
const DEFAULT_WAIT_MS = 300_000;

export async function startToolApprovalHttpBridge(
  options: ToolApprovalHttpBridgeOptions,
): Promise<ToolApprovalHttpBridge> {
  const host = options.host ?? "127.0.0.1";
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const waiters = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      resolve: (decision: { decision: "allow" | "deny"; reason?: string }) => void;
    }
  >();

  const wakeWaiter = (
    requestId: string,
    decision: { decision: "allow" | "deny"; reason?: string } | null,
  ): void => {
    if (!decision) return;
    const waiter = waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(requestId);
    waiter.resolve(decision);
  };

  // Poll the decision map while a waiter parks. The record() call has no
  // callback surface, so a light interval is the simplest correct wake-up;
  // decisions arrive on human timescales, well above this cadence.
  const startWaiter = (
    requestId: string,
    respond: (decision: { decision: "allow" | "deny"; reason?: string }) => void,
  ): void => {
    if (waiters.size >= MAX_WAITERS) {
      // Over capacity: relay neutral immediately rather than dropping the
      // socket — the hook passes the call through (deny-only contract).
      respond({ decision: "allow", reason: "waiter_capacity" });
      return;
    }
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      respond({ decision: "allow", reason: "wait_timeout" });
    }, waitMs);
    timer.unref?.();
    waiters.set(requestId, {
      timer,
      resolve: (decision) => respond(decision),
    });
  };

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (
          request.method !== "POST" ||
          !request.url ||
          !request.url.startsWith("/control/tool-approval")
        ) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ decision: "allow", reason: "not_found" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        let parsed: ApprovalPayload;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ApprovalPayload;
        } catch {
          parsed = {};
        }
        const platform =
          typeof parsed.platform === "string" ? parsed.platform : "unknown";
        const inner = parsed.payload ?? {};
        const requestId =
          typeof inner.requestId === "string" ? inner.requestId : "";

        // Phase 1: no requestId — mint one and hand it back so the hook can
        // correlate the eventual human decision. The hook wraps the platform
        // stdin JSON under `request`; read tool fields from either level.
        if (!requestId) {
          const minted = randomUUID();
          const innerRequest =
            inner.request && typeof inner.request === "object" && !Array.isArray(inner.request)
              ? (inner.request as Record<string, unknown>)
              : {};
          const toolName =
            typeof inner.tool_name === "string"
              ? inner.tool_name
              : typeof inner.toolName === "string"
                ? inner.toolName
                : typeof innerRequest.tool_name === "string"
                  ? innerRequest.tool_name
                  : typeof innerRequest.toolName === "string"
                    ? innerRequest.toolName
                    : "unknown";
          const rawInput =
            inner.tool_input ??
            inner.input ??
            innerRequest.tool_input ??
            innerRequest.input;
          const toolInput =
            rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          options.onRequestRegistered?.({
            requestId: minted,
            platform,
            toolName,
            toolInput,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ requestId: minted }));
          return;
        }

        // Fast path: the human already decided before the hook parked.
        const existing = options.resolveDecision(requestId);
        if (existing) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(existing));
          return;
        }
        // Phase 2: park until the decision map holds this id (or timeout).
        startWaiter(requestId, (decision) => {
          if (!response.headersSent) {
            response.writeHead(200, { "content-type": "application/json" });
          }
          response.end(JSON.stringify(decision));
        });
      })().catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        // Bridge failure is not a human deny: relay neutral so the hook
        // passes the tool call through.
        response.end(
          JSON.stringify({
            decision: "allow",
            reason: error instanceof Error ? error.message : "bridge failure",
          }),
        );
      });
    },
  );
  server.listen(options.port ?? 8787, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : (options.port ?? 8787);

  // Wake any parked waiter the moment its decision lands in the map. The
  // daemon's respond-tool-approval wrapper calls this after record().
  const bridge: ToolApprovalHttpBridge & {
    notifyDecision: typeof wakeWaiter;
  } = {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    notifyDecision: wakeWaiter,
  };
  return bridge;
}

/**
 * Bounded map of human tool-approval decisions seen from the authenticated
 * control surface (supervisor.respondToolApproval executions). The hook
 * bridge replays exactly these; everything else relays neutral (deny-only).
 */
export class ToolApprovalDecisionMap {
  private readonly decisions = new Map<
    string,
    { decision: "allow" | "deny"; reason?: string }
  >();

  constructor(private readonly limit = 256) {}

  record(requestId: string, decision: "allow" | "deny", reason?: string): void {
    if (this.decisions.size >= this.limit && !this.decisions.has(requestId)) {
      const oldest = this.decisions.keys().next().value;
      if (oldest !== undefined) this.decisions.delete(oldest);
    }
    this.decisions.set(requestId, {
      decision,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  resolve(
    requestId: string,
  ): { decision: "allow" | "deny"; reason?: string } | null {
    return this.decisions.get(requestId) ?? null;
  }
}
