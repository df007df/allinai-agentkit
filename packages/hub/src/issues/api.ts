/**
 * REST surface for the issue domain, mountable two ways:
 *
 *  - `createIssueApiRoutes` — AgentApiRoute[] for `/_agentkit/api/v1/issues/*`,
 *    authenticated by agent tokens via `createAgentApiRouter` (machine-facing);
 *  - `createIssueConsoleHandlers` — console endpoints under
 *    `/_agentkit/console/issues*`, loopback-only like every other console
 *    write endpoint (browser-facing).
 *
 * Both delegate to one IssueStore instance; there is no second source of
 * truth and handlers never parse credentials themselves.
 */

import type { AgentApiRoute } from "../agent-api.js";
import {
  CONSOLE_ISSUES_PATH,
  CONSOLE_ISSUE_INBOX_PATH,
} from "../routes.js";
import { IssueStore } from "./store.js";
import {
  isIssuePriority,
  isIssueStatus,
  type ActorRef,
  type IssuePriority,
  type IssueStatus,
} from "./types.js";

/** Principal carried by the registry authenticator: the registered token. */
export type IssueApiIdentity = {
  token: string;
  clientId: string;
  issuedAt: number;
};

/**
 * Machine-facing authors are ALWAYS the verified token identity: an agent
 * cannot pose as a member or as another agent, regardless of body contents.
 */
function tokenAuthor(identity: { clientId: string }): {
  type: "agent";
  id: string;
} {
  return { type: "agent", id: identity.clientId };
}

function actorFromBody(value: unknown): ActorRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const type = record.type;
  if (typeof id !== "string" || !id) return undefined;
  if (type !== "member" && type !== "agent") return undefined;
  return { type, id };
}

function requireActor(value: unknown, fallback: ActorRef): ActorRef {
  return actorFromBody(value) ?? fallback;
}

function json(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorPayload(error: unknown): { status: number; error: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return { status: 404, error: message };
  if (/must be|Invalid|required/i.test(message)) return { status: 400, error: message };
  return { status: 500, error: message };
}

function parseIssueStatus(value: unknown): IssueStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isIssueStatus(value)) {
    throw new Error(`Invalid issue status: ${String(value)}`);
  }
  return value;
}

function parseIssuePriority(value: unknown): IssuePriority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isIssuePriority(value)) {
    throw new Error(`Invalid issue priority: ${String(value)}`);
  }
  return value;
}

const LOCAL_FALLBACK: ActorRef = { type: "member", id: "local-member" };

/** Convenience factory matching console-runtime call sites. */
export function createIssueStore(
  dbPath: string,
  options?: ConstructorParameters<typeof IssueStore>[1],
): IssueStore {
  return new IssueStore(dbPath, options);
}

/**
 * Machine-facing routes under `/_agentkit/api/v1`. Mounted through
 * `createAgentApiRouter`, so authentication has already run by the time a
 * handler executes.
 */
export function createIssueApiRoutes(store: IssueStore): AgentApiRoute<IssueApiIdentity>[] {
  return [
    {
      method: "GET",
      path: "/issues",
      handler: ({ response, request, identity }) => {
        const url = new URL(request.url ?? "/", "http://api.invalid");
        const status = url.searchParams.get("status");
        const limit = url.searchParams.get("limit");
        json(response, 200, {
          issues: store.listIssues({
            status: status ? parseIssueStatus(status) : undefined,
            limit: limit ? Number(limit) : undefined,
          }),
        });
      },
    },
    {
      method: "POST",
      path: "/issues",
      handler: ({ response, body, identity }) => {
        try {
          const issue = store.createIssue({
            title: String(body.title ?? ""),
            body: typeof body.body === "string" ? body.body : undefined,
            status: parseIssueStatus(body.status),
            priority: parseIssuePriority(body.priority),
            projectId: typeof body.projectId === "string" ? body.projectId : undefined,
            assignee: actorFromBody(body.assignee) ?? null,
            author: tokenAuthor(identity),
          });
          json(response, 201, { issue });
        } catch (error) {
          const { status, error: message } = errorPayload(error);
          json(response, status, { error: message });
        }
      },
    },
    {
      method: "GET",
      path: "/issues/:issueRef",
      handler: ({ response, params, identity }) => {
        try {
          const issue = store.getIssue(params.issueRef!);
          if (!issue) {
            json(response, 404, { error: `Issue not found: ${params.issueRef}` });
            return;
          }
          json(response, 200, {
            issue,
            comments: store.listComments(issue.id),
            subscribers: store.listSubscribers(issue.id),
            executions: store.listExecutions(issue.id),
          });
        } catch (error) {
          const { status, error: message } = errorPayload(error);
          json(response, status, { error: message });
        }
      },
    },
    {
      method: "PATCH",
      path: "/issues/:issueRef",
      handler: ({ response, params, body, identity }) => {
        try {
          const issue = store.updateIssue(params.issueRef!, {
            title: typeof body.title === "string" ? body.title : undefined,
            body: typeof body.body === "string" ? body.body : undefined,
            status: parseIssueStatus(body.status),
            priority: parseIssuePriority(body.priority),
            assignee:
              "assignee" in body
                ? (actorFromBody(body.assignee) ?? null)
                : undefined,
            actor: tokenAuthor(identity),
          });
          json(response, 200, { issue });
        } catch (error) {
          const { status, error: message } = errorPayload(error);
          json(response, status, { error: message });
        }
      },
    },
    {
      method: "GET",
      path: "/issues/:issueRef/comments",
      handler: ({ response, params, identity }) => {
        try {
          json(response, 200, { comments: store.listComments(params.issueRef!) });
        } catch (error) {
          const { status, error: message } = errorPayload(error);
          json(response, status, { error: message });
        }
      },
    },
    {
      method: "POST",
      path: "/issues/:issueRef/comments",
      handler: ({ response, params, body, identity }) => {
        try {
          const comment = store.createComment({
            issueId: params.issueRef!,
            body: String(body.body ?? ""),
            author: tokenAuthor(identity),
            parentId: typeof body.parentId === "string" ? body.parentId : undefined,
            skipNotify: body.skipNotify === true,
          });
          json(response, 201, { comment });
        } catch (error) {
          const { status, error: message } = errorPayload(error);
          json(response, status, { error: message });
        }
      },
    },
    {
      method: "GET",
      path: "/inbox/:actorType/:actorId",
      handler: ({ response, params, identity }) => {
        const actorType = params.actorType;
        if (actorType !== "member" && actorType !== "agent") {
          json(response, 400, { error: "actorType must be member or agent" });
          return;
        }
        json(response, 200, {
          items: store.listInbox(
            { type: actorType, id: params.actorId! },
            { limit: 200 },
          ),
        });
      },
    },
  ];
}

/** Read a JSON body once, tolerant of empty payloads. */
async function readBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
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

/**
 * Console-facing handlers under `/_agentkit/console/issues`. The caller (the
 * console router) owns the loopback-only gate; these functions assume it ran.
 */
export function createIssueConsoleHandlers(store: IssueStore): {
  handleIssues(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<boolean>;
  handleInbox(response: import("node:http").ServerResponse, request?: import("node:http").IncomingMessage): void;
} {
  return {
    async handleIssues(request, response) {
      const url = new URL(request.url ?? "/", "http://console.invalid");
      try {
        if (request.method === "GET") {
          const issueRef = url.searchParams.get("ref");
          if (issueRef) {
            const issue = store.getIssue(issueRef);
            if (!issue) {
              json(response, 404, { error: `Issue not found: ${issueRef}` });
            } else {
              json(response, 200, {
                issue,
                comments: store.listComments(issue.id),
                subscribers: store.listSubscribers(issue.id),
                executions: store.listExecutions(issue.id),
              });
            }
            return true;
          }
          const status = url.searchParams.get("status");
          json(response, 200, {
            issues: store.listIssues({
              status: status ? parseIssueStatus(status) : undefined,
            }),
          });
          return true;
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          const action = typeof body.action === "string" ? body.action : "";
          if (action === "create") {
            const issue = store.createIssue({
              title: String(body.title ?? ""),
              body: typeof body.body === "string" ? body.body : undefined,
              priority: parseIssuePriority(body.priority),
              assignee: actorFromBody(body.assignee) ?? null,
            });
            json(response, 201, { issue });
            return true;
          }
          if (action === "update" && typeof body.ref === "string") {
            const issue = store.updateIssue(body.ref, {
              status: parseIssueStatus(body.status),
              priority: parseIssuePriority(body.priority),
              title: typeof body.title === "string" ? body.title : undefined,
              assignee:
                "assignee" in body
                  ? (actorFromBody(body.assignee) ?? null)
                  : undefined,
              actor: requireActor(body.actor, LOCAL_FALLBACK),
            });
            json(response, 200, { issue });
            return true;
          }
          if (action === "comment" && typeof body.ref === "string") {
            const comment = store.createComment({
              issueId: body.ref,
              body: String(body.body ?? ""),
              parentId: typeof body.parentId === "string" ? body.parentId : undefined,
            });
            json(response, 201, { comment });
            return true;
          }
          if (action === "inbox.read" && typeof body.itemId === "string") {
            store.markInboxRead(body.itemId);
            json(response, 200, { ok: true });
            return true;
          }
          if (action === "inbox.archive" && typeof body.itemId === "string") {
            store.archiveInbox(body.itemId);
            json(response, 200, { ok: true });
            return true;
          }
          json(response, 400, { error: `Unknown issues action: ${action}` });
          return true;
        }
        json(response, 405, { error: "method_not_allowed" });
        return true;
      } catch (error) {
        const { status, error: message } = errorPayload(error);
        json(response, status, { error: message });
        return true;
      }
    },
    handleInbox(response, request) {
      let recipient: ActorRef = LOCAL_FALLBACK;
      if (request) {
        const url = new URL(request.url ?? "/", "http://console.invalid");
        const actor = url.searchParams.get("actor");
        // `actor=bob` (member) or `actor=agent:agent-browser`.
        const [type, id] = actor?.includes(":")
          ? (actor.split(":", 2) as [string, string])
          : ["member", actor ?? ""];
        if (id && (type === "member" || type === "agent")) {
          recipient = { type, id };
        }
      }
      json(response, 200, {
        items: store.listInbox(recipient, { limit: 200 }),
      });
    },
  };
}

/** True when the console router should hand the request to the issues handlers. */
export function isIssueConsolePath(pathname: string): boolean {
  return (
    pathname === CONSOLE_ISSUES_PATH ||
    pathname === CONSOLE_ISSUES_PATH + "/" ||
    pathname.startsWith(CONSOLE_ISSUES_PATH + "?") ||
    pathname === CONSOLE_ISSUE_INBOX_PATH
  );
}
