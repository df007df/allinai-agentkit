import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A minimal loopback HTTP bridge in front of the daemon's control surface.
 * The Codex PreToolUse hook (installed by `agentkit codex-hooks`) is a plain
 * shell script: it POSTs the pending tool call here and treats the JSON
 * reply as the human decision. Only tool-approval routing lives on HTTP;
 * everything else stays on the authenticated Unix-socket control server.
 */

export type ToolApprovalHttpBridgeOptions = {
  /** Answer a pending tool approval; mirrors AgentControl.respondToolApproval. */
  respondToolApproval: (
    executionId: string,
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
  ) => Promise<void>;
  /** Resolve the executionId that owns a runner-level approval request id. */
  resolveExecutionId: (requestId: string) => string | null;
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
    session_id?: unknown;
    requestId?: unknown;
    tool_name?: unknown;
  };
};

/**
 * Hooks deliver the runner request id in `payload.requestId` (our codex-hooks
 * template embeds the child's stdin JSON verbatim). Because the hook payload
 * does not carry an agentkit executionId, the daemon resolves the owner by
 * scanning active runs — the request id is a random UUID, so cross-run
 * collisions are not a practical concern.
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
            : typeof parsed.payload?.session_id === "string"
              ? null
              : null;
        const executionId = requestId
          ? options.resolveExecutionId(requestId)
          : null;
        if (!requestId || !executionId) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              decision: "deny",
              reason: "approval request not owned by this daemon",
            }),
          );
          return;
        }
        await options.respondToolApproval(executionId, requestId, "allow");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ decision: "allow" }));
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
