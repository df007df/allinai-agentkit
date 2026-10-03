import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runCli } from "./commands.js";
import { createCredentialStore } from "../credentials.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type RecordedRequest = {
  url: string;
  method: string;
  authorization: string;
  body?: unknown;
};

/**
 * Boots a fake config + credential home, then drives `issue` subcommands
 * against an in-memory fetch double that answers the hub REST surface.
 */
async function bootIssueCli(responses: Array<(request: RecordedRequest) => unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "allinai-cli-issue-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, "agent-home");

  const init = await runCli(
    ["init", "--hub", "https://hub.example.test", "--client", "cli-issue"],
    { configDir, write: () => undefined },
  );
  assert.equal(init.exitCode, 0);

  const credentials = createCredentialStore({
    paths: { credentialsRoot: path.join(configDir, "credentials") },
  });
  await credentials.save("cli-issue", "tok-123");

  const recorded: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    recorded.push({
      url,
      method: init?.method ?? "GET",
      authorization: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const respond = responses[recorded.length - 1] ?? (() => ({}));
    return new Response(JSON.stringify(respond(recorded[recorded.length - 1]!)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  async function issue(args: string[]): Promise<{ exitCode: 0 | 1; output: string[] }> {
    const output: string[] = [];
    const result = await runCli(["issue", ...args], {
      configDir,
      credentials,
      fetch: fetchImpl,
      write: (line) => output.push(line),
    });
    return { exitCode: result.exitCode, output };
  }

  return { issue, recorded };
}

describe("issue CLI", () => {
  it("show renders readable detail by default and json verbatim with --json", async () => {
    const { issue, recorded } = await bootIssueCli([
      () => ({
        issue: {
          id: "u1",
          issueKey: "ISSUE-7",
          title: "示例",
          status: "todo",
          priority: "P2",
          body: "正文",
        },
        comments: [
          {
            id: "c1",
            issueId: "u1",
            authorActorType: "member",
            authorActorId: "local-member",
            body: "你好",
            createdAt: "2026-09-29T00:00:00.000Z",
            parentId: null,
            updatedAt: "2026-09-29T00:00:00.000Z",
            mentions: [],
          },
        ],
        subscribers: [],
      }),
    ]);

    const readable = await issue(["show", "ISSUE-7"]);
    assert.equal(readable.exitCode, 0);
    assert.ok(readable.output.some((line) => line.includes("ISSUE-7")));
    assert.ok(readable.output.some((line) => line.includes("你好")));

    assert.equal(recorded[0]!.method, "GET");
    assert.equal(
      recorded[0]!.url,
      "https://hub.example.test/_agentkit/api/v1/issues/ISSUE-7",
    );
    assert.equal(recorded[0]!.authorization, "Bearer tok-123");
  });

  it("comment posts the body and update patches status", async () => {
    const { issue, recorded } = await bootIssueCli([
      () => ({ comment: { id: "c2" } }),
      () => ({ issue: { issueKey: "ISSUE-7", status: "done" } }),
    ]);

    const commented = await issue([
      "comment",
      "ISSUE-7",
      "--body",
      "结论:已修复",
    ]);
    assert.equal(commented.exitCode, 0);
    assert.equal(recorded[0]!.method, "POST");
    assert.deepEqual(recorded[0]!.body, { body: "结论:已修复" });

    const updated = await issue(["update", "ISSUE-7", "--status", "done"]);
    assert.equal(updated.exitCode, 0);
    assert.equal(recorded[1]!.method, "PATCH");
    assert.deepEqual(recorded[1]!.body, { status: "done" });
  });

  it("inbox targets the local client's agent identity", async () => {
    const { issue, recorded } = await bootIssueCli([() => ({ items: [] })]);
    const result = await issue(["inbox"]);
    assert.equal(result.exitCode, 0);
    assert.equal(
      recorded[0]!.url,
      "https://hub.example.test/_agentkit/api/v1/inbox/agent/cli-issue",
    );
  });

  it("rejects unknown actions and missing values", async () => {
    const { issue } = await bootIssueCli([]);
    const bad = await issue(["dance"]);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.output.join(""), /Unknown issue action/);

    const noBody = await issue(["comment", "ISSUE-7"]);
    assert.equal(noBody.exitCode, 1);
    assert.match(noBody.output.join(""), /--body/);
  });
});
