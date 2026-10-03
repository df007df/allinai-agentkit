import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentApiRouter } from "../agent-api.js";
import {
  createIssueApiRoutes,
  createIssueConsoleHandlers,
  createIssueStore,
  type IssueApiIdentity,
} from "./api.js";
import { formatMentionLink } from "./mention.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONSOLE_ISSUES_PATH, CONSOLE_ISSUE_INBOX_PATH } from "../routes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkit-issues-api-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return createIssueStore(path.join(dir, "issues.db"), {
    actors: [{ id: "agent-browser", displayName: "浏览器助手" }],
  });
}

/** Minimal req/res shims exercising the handler functions directly. */
function shim(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): {
  request: IncomingMessage;
  response: ServerResponse;
  json<T = Record<string, unknown>>(): Promise<{ status: number; body: T }>;
} {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const request = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
  let status = 0;
  let payload = "";
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    writeHead(code: number) {
      status = code;
      headersSent = true;
    },
    end(text: string) {
      payload = text;
    },
  } as unknown as ServerResponse;
  return {
    request,
    response,
    async json<T = Record<string, unknown>>(): Promise<{ status: number; body: T }> {
      return { status, body: JSON.parse(payload) as T };
    },
  };
}

describe("issues console handlers", () => {
  it("creates, lists, comments and reads the local inbox", async () => {
    const store = tempStore();
    const handlers = createIssueConsoleHandlers(store);

    const created = shim("POST", CONSOLE_ISSUES_PATH, {
      action: "create",
      title: "浏览器崩了",
    });
    assert.equal(await handlers.handleIssues(created.request, created.response), true);
    const createdBody = await created.json<{ issue: { id: string; issueKey: string } }>();
    assert.equal(createdBody.status, 201);
    assert.equal(createdBody.body.issue.issueKey, "ISSUE-1");

    const comment = shim("POST", CONSOLE_ISSUES_PATH, {
      action: "comment",
      ref: "ISSUE-1",
      body: "复现步骤见附件 @浏览器助手 分析下",
    });
    await handlers.handleIssues(comment.request, comment.response);
    const commentBody =
      await comment.json<{ comment: { mentions: Array<{ type: string; id: string }> } }>();
    assert.equal(commentBody.status, 201);
    assert.deepEqual(commentBody.body.comment.mentions, [
      { type: "agent", id: "agent-browser" },
    ]);

    const listed = shim("GET", CONSOLE_ISSUES_PATH);
    await handlers.handleIssues(listed.request, listed.response);
    const listBody =
      await listed.json<{ issues: Array<{ issueKey: string; openCommentCount: number }> }>();
    assert.equal(listBody.body.issues.length, 1);
    assert.equal(listBody.body.issues[0]!.openCommentCount, 1);

    const detail = shim(
      "GET",
      `${CONSOLE_ISSUES_PATH}?ref=${encodeURIComponent("ISSUE-1")}`,
    );
    await handlers.handleIssues(detail.request, detail.response);
    const detailBody = await detail.json<{ comments: unknown[] }>();
    assert.equal(detailBody.body.comments.length, 1);

    const inbox = shim("GET", CONSOLE_ISSUE_INBOX_PATH);
    handlers.handleInbox(inbox.response);
    const inboxBody = await inbox.json<{ items: unknown[] }>();
    // Author is the local member and the only mentioned actor is an agent:
    // nothing lands in the member inbox.
    assert.equal(inboxBody.body.items.length, 0);
  });

  it("notifies mentioned members through the local inbox", async () => {
    const store = tempStore();
    const handlers = createIssueConsoleHandlers(store);
    const created = shim("POST", CONSOLE_ISSUES_PATH, { action: "create", title: "t" });
    await handlers.handleIssues(created.request, created.response);

    const comment = shim("POST", CONSOLE_ISSUES_PATH, {
      action: "comment",
      ref: "ISSUE-1",
      body: `@Bob 请确认 ${formatMentionLink("member", "bob", "Bob")}`,
    });
    await handlers.handleIssues(comment.request, comment.response);

    const inbox = shim("GET", `${CONSOLE_ISSUE_INBOX_PATH}?actor=bob`);
    handlers.handleInbox(inbox.response, inbox.request);
    const inboxBody =
      await inbox.json<{ items: Array<{ id: string; type: string; read: boolean }> }>();
    assert.equal(inboxBody.body.items.length, 1);
    assert.equal(inboxBody.body.items[0]!.type, "mentioned");

    const markRead = shim("POST", CONSOLE_ISSUES_PATH, {
      action: "inbox.read",
      itemId: inboxBody.body.items[0]!.id,
    });
    await handlers.handleIssues(markRead.request, markRead.response);
    assert.equal((await markRead.json<{ ok: boolean }>()).body.ok, true);
  });

  it("maps domain errors to 404/400 statuses", async () => {
    const store = tempStore();
    const handlers = createIssueConsoleHandlers(store);
    const missing = shim("GET", `${CONSOLE_ISSUES_PATH}?ref=ISSUE-404`);
    await handlers.handleIssues(missing.request, missing.response);
    assert.equal((await missing.json()).status, 404);

    const invalid = shim("POST", CONSOLE_ISSUES_PATH, { action: "create", title: "  " });
    await handlers.handleIssues(invalid.request, invalid.response);
    assert.equal((await invalid.json()).status, 400);
  });
});

describe("issues agent api routes", () => {
  it("serves the full issue surface under the business namespace", async () => {
    const store = tempStore();
    const router = createAgentApiRouter<IssueApiIdentity>({
      // The issue routes derive the author from identity.clientId.
      authenticate: async (token) =>
        token === "good"
          ? { principal: { token, clientId: "agent-cli", issuedAt: 0 }, clientId: "agent-cli" }
          : null,
      routes: createIssueApiRoutes(store),
    });

    async function call(
      method: string,
      pathname: string,
      body?: Record<string, unknown>,
      token = "good",
    ): Promise<{ status: number; payload: Record<string, unknown> }> {
      const headers = { authorization: `Bearer ${token}` } as NodeJS.Dict<string>;
      const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
      const request = {
        method,
        url: pathname,
        headers,
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      } as unknown as IncomingMessage;
      let status = 0;
      let raw = "";
      let headersSent = false;
      const response = {
        get headersSent() {
          return headersSent;
        },
        writeHead(code: number) {
          status = code;
          headersSent = true;
        },
        end(text: string) {
          raw = text;
        },
      } as unknown as ServerResponse;
      assert.equal(await router(request, response), true);
      return { status, payload: JSON.parse(raw) as Record<string, unknown> };
    }

    const created = await call("POST", "/_agentkit/api/v1/issues", {
      title: "API 建 issue",
    });
    assert.equal(created.status, 201);
    // Author is forced to the token identity even though none was supplied.
    const createdIssue = created.payload.issue as {
      issueKey: string;
      assigneeActorId: string | null;
    };
    assert.equal(createdIssue.issueKey, "ISSUE-1");

    const commented = await call("POST", "/_agentkit/api/v1/issues/ISSUE-1/comments", {
      body: "机器写入的评论",
      // Spoofed author must be ignored: the token identity wins.
      author: { type: "member", id: "mallory" },
    });
    assert.equal(commented.status, 201);
    assert.equal(
      (commented.payload.comment as { authorActorId: string }).authorActorId,
      "agent-cli",
    );

    const detail = await call("GET", "/_agentkit/api/v1/issues/ISSUE-1");
    assert.equal(detail.status, 200);
    assert.equal((detail.payload.comments as unknown[]).length, 1);

    const patched = await call("PATCH", "/_agentkit/api/v1/issues/ISSUE-1", {
      status: "in_progress",
    });
    assert.equal(patched.status, 200);
    assert.equal((patched.payload.issue as { status: string }).status, "in_progress");

    // Inbox notifies member subscribers only (agents are driven by mention
    // dispatch, not inbox). The M3 conclusion loop: a human creates an issue
    // (member subscriber), the agent reports back over the API, the human
    // gets a new_comment notification.
    store.createIssue({ title: "人类发起" });
    await call("POST", "/_agentkit/api/v1/issues/ISSUE-2/comments", {
      body: "结论：已修复，见 PR #42",
    });
    const humanInbox = await call(
      "GET",
      "/_agentkit/api/v1/inbox/member/local-member",
    );
    const items = humanInbox.payload.items as Array<{ type: string }>;
    assert.equal(items.at(-1)?.type, "new_comment");
    const agentInbox = await call(
      "GET",
      "/_agentkit/api/v1/inbox/agent/agent-cli",
    );
    assert.equal(
      (agentInbox.payload.items as unknown[]).length,
      0,
      "agent subscribers are not inbox recipients",
    );

    const unauthorized = await call("GET", "/_agentkit/api/v1/issues", undefined, "bad");
    assert.equal(unauthorized.status, 401);
  });
});
