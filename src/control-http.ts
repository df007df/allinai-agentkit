import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A minimal loopback HTTP bridge in front of the daemon's control surface.
 * The Codex PreToolUse hook (installed by `agentkit codex-hooks`) is a plain
 * shell script: it POSTs the pending tool call here and treats the JSON
 * reply as the human decision. Only tool-approval routing lives on HTTP;
 * everything else stays on the authenticated Unix-socket control server.
 *
 * The bridge NEVER decides on its own: it only replays decisions a human
 * already made through the console (offer channel → supervisor → the daemon's
 * decision map). A hook POST whose request id has no recorded human decision
 * is denied fail-closed, so unauthenticated SSE or hook replay traffic cannot
 * silently allow anything.
 */

export type ToolApprovalHttpBridgeOptions = {
  /**
   * Resolves the human decision previously recorded for a request id, or null
   * when no console-originated decision has arrived (fail closed → deny).
   */
  resolveDecision: (
    requestId: string,
  ) => { decision: "allow" | "deny"; reason?: string } | null;
  host?: string;
  port?: number;
};

export type ToolApprovalHttpBridge = {
  url: string;
  close(): Promise<void>;
};

type ApprovalPayload = {
  platform?: unknown;
  payload?: {
    requestId?: unknown;
  };
};

/**
 * Hooks deliver the runner request id in `payload.requestId` (our codex-hooks
 * template embeds the child's stdin JSON verbatim). The reply is purely a
 * replay: the daemon records decisions in {@link recordToolApprovalDecision}
 * when a human answers through the console, and the hook's synchronous POST
 * picks that decision up.
 */
export async function startToolApprovalHttpBridge(
  options: ToolApprovalHttpBridgeOptions,
): Promise<ToolApprovalHttpBridge> {
  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (
          request.method !== "POST" ||
          !request.url ||
          !request.url.startsWith("/control/tool-approval")
        ) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ decision: "deny", reason: "not_found" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        let parsed: ApprovalPayload;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          parsed = {};
        }
        const requestId =
          typeof parsed.payload?.requestId === "string"
            ? parsed.payload.requestId
            : "";
        const decision = requestId
          ? options.resolveDecision(requestId)
          : null;
        if (!decision) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              decision: "deny",
              reason: "unknown_request_id",
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            decision.reason
              ? { decision: decision.decision, reason: decision.reason }
              : { decision: decision.decision },
          ),
        );
      })().catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(
          JSON.stringify({
            decision: "deny",
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
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Bounded map of human tool-approval decisions seen from the authenticated
 * control surface (supervisor.respondToolApproval executions). The hook
 * bridge replays exactly these; everything else denies fail-closed.
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
