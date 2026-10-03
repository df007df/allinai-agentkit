import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";
import { CONSOLE_ISSUES_PATH, CONSOLE_ISSUE_INBOX_PATH } from "../routes.js";
import { createConsoleRouter, createConsoleRuntime } from "../console/runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Minimal Node-style req/res pair driven straight into the console router. */
async function callRouter(
  router: ReturnType<typeof createConsoleRouter>,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  const request = {
    method,
    url: pathname,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  } as unknown as IncomingMessage;
  let code = 0;
  let raw = "";
  const response = {
    headersSent: false,
    writeHead(c: number) {
      code = c;
      (response as { headersSent: boolean }).headersSent = true;
    },
    end(text: string) {
      raw = text;
    },
  } as unknown as ServerResponse;
  assert.equal(await router(request, response), true);
  return { status: code, payload: JSON.parse(raw || "{}") as Record<string, unknown> };
}

describe("issues endpoints through the console router", () => {
  it("serves issue CRUD and inbox behind the loopback gate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentkit-issues-e2e-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const runtime = createConsoleRuntime({
      issuesDbPath: path.join(dir, "issues.db"),
      tokensDbPath: path.join(dir, "tokens.db"),
    });
    cleanups.push(() => void runtime.close());
    const router = createConsoleRouter(runtime);

    // Non-loopback arm: issue write endpoints must 403 before any handler.
    runtime.stream.hostWarning = "test: non-loopback";
    const blocked = await callRouter(router, "POST", CONSOLE_ISSUES_PATH, {
      action: "create",
      title: "x",
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.payload.error, "loopback_only");

    // Loopback: create → comment → list → inbox, all through the router.
    runtime.stream.hostWarning = null;
    const created = await callRouter(router, "POST", CONSOLE_ISSUES_PATH, {
      action: "create",
      title: "router 层集成",
    });
    assert.equal(created.status, 201);
    assert.equal(
      (created.payload.issue as { issueKey: string }).issueKey,
      "ISSUE-1",
    );

    const commented = await callRouter(router, "POST", CONSOLE_ISSUES_PATH, {
      action: "comment",
      ref: "ISSUE-1",
      body: "集成评论",
    });
    assert.equal(commented.status, 201);

    const listed = await callRouter(router, "GET", CONSOLE_ISSUES_PATH);
    const issues = listed.payload.issues as Array<{ openCommentCount: number }>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.openCommentCount, 1);

    const inbox = await callRouter(router, "GET", CONSOLE_ISSUE_INBOX_PATH);
    assert.equal(Array.isArray(inbox.payload.items), true);

    // Both hub-side stores landed in the requested files.
    assert.equal(existsSync(path.join(dir, "issues.db")), true);
    assert.equal(existsSync(path.join(dir, "tokens.db")), true);
  });
});
