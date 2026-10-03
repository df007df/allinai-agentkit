import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { WsClientTransport } from "@allin-ai/agentkit-client/client";
import { MemoryHubStore } from "../hub/testkit/index.js";
import type { ClientCommand } from "../protocol/index.js";
import { startConsoleServer } from "../console/index.js";
import { CONSOLE_ISSUES_PATH } from "../routes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkit-issue-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

async function post(
  site: { url: string },
  pathname: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${site.url}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    payload: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe("issue dispatch end to end", () => {
  it("routes a console comment mention to the mentioned client as agent.run", async () => {
    const site = await startConsoleServer({
      port: 0,
      store: new MemoryHubStore<string>(),
      issuesDbPath: tempDb("issues.db"),
      tokensDbPath: tempDb("tokens.db"),
    });
    cleanups.push(() => site.close());

    const record = await site.runtime.registry.register("agent-e2e");
    const commands: ClientCommand[] = [];
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: record.token,
      clientId: "agent-e2e",
    });
    cleanups.push(() => transport.close());
    await transport.connect({
      command: async (command) => {
        commands.push(command);
      },
      connected: async () => {},
    });

    // Wait until the console state knows the client — the mention directory
    // derives from it, so the @name must resolve after registration.
    const deadline = Date.now() + 2_000;
    while (!site.runtime.state.hasClient("agent-e2e") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(site.runtime.state.hasClient("agent-e2e"));

    const created = await post(site, CONSOLE_ISSUES_PATH, {
      action: "create",
      title: "端到端触发",
    });
    assert.equal(created.status, 201);
    const issueKey = (created.payload.issue as { issueKey: string }).issueKey;

    const commented = await post(site, CONSOLE_ISSUES_PATH, {
      action: "comment",
      ref: issueKey,
      body: "@agent-e2e 来处理",
    });
    assert.equal(commented.status, 201);

    const offerDeadline = Date.now() + 2_000;
    while (commands.length === 0 && Date.now() < offerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(commands.length, 1, "exactly one agent.run offer");
    const run = commands[0]!;
    assert.equal(run.kind, "agent.run");
    if (run.kind !== "agent.run") return;
    assert.match(String(run.payload.prompt), new RegExp(issueKey));
    assert.match(String(run.payload.prompt), /@agent-e2e 来处理/);

    // The execution row is open; a client-reported done event closes it and
    // (with no parked comments) does not re-arm.
    await transport.push([
      {
        executionId: run.executionId,
        eventSeq: 1,
        type: "done",
        occurredAt: new Date().toISOString(),
      },
    ]);
    const doneDeadline = Date.now() + 2_000;
    while (
      site.runtime.issues.store.findExecutionByExecutionId(run.executionId)
        ?.status !== "done" &&
      Date.now() < doneDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      site.runtime.issues.store.findExecutionByExecutionId(run.executionId)!
        .status,
      "done",
    );
    assert.equal(commands.length, 1);
  });

  it("serves the agent REST API with token-forced authorship", async () => {
    const site = await startConsoleServer({
      port: 0,
      store: new MemoryHubStore<string>(),
      issuesDbPath: tempDb("issues.db"),
      tokensDbPath: tempDb("tokens.db"),
    });
    cleanups.push(() => site.close());
    const record = await site.runtime.registry.register("agent-cli");

    const created = await post(site, CONSOLE_ISSUES_PATH, {
      action: "create",
      title: "CLI 回写",
    });
    const issueKey = (created.payload.issue as { issueKey: string }).issueKey;

    const response = await fetch(
      `${site.url}/_agentkit/api/v1/issues/${issueKey}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${record.token}`,
        },
        body: JSON.stringify({
          body: "结论:已修复",
          author: { type: "member", id: "mallory" },
        }),
      },
    );
    assert.equal(response.status, 201);
    const payload = (await response.json()) as {
      comment: { authorActorType: string; authorActorId: string };
    };
    // Spoofed member author is discarded; the token identity wins.
    assert.equal(payload.comment.authorActorType, "agent");
    assert.equal(payload.comment.authorActorId, "agent-cli");

    const humanInbox = site.runtime.issues.store.listInbox({
      type: "member",
      id: "local-member",
    });
    assert.equal(
      humanInbox.some((item) => item.type === "new_comment"),
      true,
      "the issue creator is notified of the agent's conclusion",
    );
  });
});
