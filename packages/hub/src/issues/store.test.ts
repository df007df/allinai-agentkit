import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { IssueStore } from "./store.js";
import {
  LOCAL_MEMBER_ID,
  formatMentionLink,
  type ActorRef,
} from "./index.js";
import { parseAgentMentions } from "./mention.js";

const LOCAL: ActorRef = { type: "member", id: LOCAL_MEMBER_ID };
const ALICE: ActorRef = { type: "member", id: "alice" };
const BROWSER_AGENT: ActorRef = { type: "agent", id: "agent-browser" };

function tempStore(
  options?: ConstructorParameters<typeof IssueStore>[1],
): { store: IssueStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkit-issues-"));
  const store = new IssueStore(path.join(dir, "issues.db"), options);
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mention parsing", () => {
  it("parses canonical mention links", () => {
    const body = `请看 ${formatMentionLink("agent", "agent-browser", "浏览器助手")} 的结果`;
    assert.deepEqual(parseAgentMentions(body, []), [
      { type: "agent", id: "agent-browser" },
    ]);
  });

  it("falls back to @displayName and prefers the longest name", () => {
    const actors = [
      { id: "agent-browser", displayName: "浏览器" },
      { id: "agent-browser-pro", displayName: "浏览器助手" },
    ];
    const refs = parseAgentMentions("麻烦 @浏览器助手 跑一下", actors);
    assert.deepEqual(refs, [{ type: "agent", id: "agent-browser-pro" }]);
  });

  it("does not match a name inside a mention link twice", () => {
    const actors = [{ id: "agent-browser", displayName: "浏览器助手" }];
    const body = `@浏览器助手 ${formatMentionLink("agent", "agent-browser", "浏览器助手")}`;
    assert.deepEqual(parseAgentMentions(body, actors), [
      { type: "agent", id: "agent-browser" },
    ]);
  });

  it("excludes the author", () => {
    const actors = [{ id: "agent-browser", displayName: "浏览器助手" }];
    const refs = parseAgentMentions("自己 @浏览器助手", actors, {
      excludeActorId: "agent-browser",
    });
    assert.deepEqual(refs, []);
  });

  it("requires word boundaries around plain-text mentions", () => {
    const actors = [{ id: "agent-browser", displayName: "浏览器助手" }];
    assert.deepEqual(parseAgentMentions("不是@浏览器助手助手", actors), []);
  });
});

describe("issue store", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function tracked(
    options?: ConstructorParameters<typeof IssueStore>[1],
  ): ReturnType<typeof tempStore> {
    const handle = tempStore(options);
    cleanups.push(handle.cleanup);
    return handle;
  }

  it("creates issues with display keys and auto-subscribes the creator", () => {
    const { store } = tracked();
    const issue = store.createIssue({ title: "第一条", author: ALICE });
    assert.equal(issue.issueKey, "ISSUE-1");
    assert.equal(issue.status, "todo");
    assert.equal(issue.priority, "P2");
    assert.deepEqual(
      store.listSubscribers(issue.id).map((s) => [s.actorId, s.reason]),
      [["alice", "creator"]],
    );
  });

  it("resolves ISSUE-n keys as query references", () => {
    const { store } = tracked();
    const issue = store.createIssue({ title: "键测试" });
    assert.equal(store.getIssue("ISSUE-1")?.id, issue.id);
    assert.throws(() => store.getIssue("ISSUE-999"), /not found/i);
  });

  it("notifies the assignee and change subscribers on assignment", () => {
    const { store } = tracked();
    const issue = store.createIssue({ title: "分派", author: ALICE });
    store.updateIssue(issue.id, { assignee: BROWSER_AGENT, actor: ALICE });
    store.updateIssue(issue.id, {
      assignee: { type: "member", id: "bob" },
      actor: ALICE,
    });

    const bobInbox = store.listInbox({ type: "member", id: "bob" });
    assert.equal(bobInbox.length, 1);
    // bob replaced the agent assignee: this is a change, not a fresh assignment.
    assert.equal(bobInbox[0]!.type, "assignee_changed");
    assert.equal(bobInbox[0]!.issueId, issue.id);

    // Status change notifies member subscribers except the actor.
    store.updateIssue(issue.id, { status: "in_progress", actor: ALICE });
    const aliceInbox = store.listInbox(ALICE);
    assert.equal(
      aliceInbox.some((item) => item.type === "status_changed"),
      false,
      "actor never notified of own change",
    );
    const bobAgain = store.listInbox({ type: "member", id: "bob" });
    // Both writes can share a millisecond; their random IDs break timestamp
    // ties. This test verifies notification delivery rather than tie order.
    assert.equal(bobAgain.length, 2);
    const statusChange = bobAgain.find((item) => item.type === "status_changed");
    assert.ok(statusChange);
    assert.deepEqual(statusChange.details, {
      from: "todo",
      to: "in_progress",
    });
  });

  it("runs the comment side-effect chain: subscribe, notify, inbox mention", () => {
    const { store } = tracked();
    const issue = store.createIssue({ title: "评论链", author: ALICE });
    const comment = store.createComment({
      issueId: issue.id,
      body: `你好 ${formatMentionLink("member", "bob", "Bob")}，@浏览器助手 看看`,
      author: ALICE,
    });
    // The member link is captured without an actor directory; the plain-text
    // @name fallback needs one, so it resolves only in stores given actors.
    assert.deepEqual(comment.mentions, [{ type: "member", id: "bob" }]);

    // Author + mentioned member subscribed; agent not subscribed (agents are
    // driven by the onAgentMention hook, not the subscriber table). The
    // author's first reason (creator) wins — INSERT OR IGNORE keeps it.
    const subscribers = store.listSubscribers(issue.id);
    assert.ok(subscribers.some((s) => s.actorId === "alice" && s.reason === "creator"));
    assert.ok(subscribers.some((s) => s.actorId === "bob" && s.reason === "mentioned"));

    // Mentioned member gets an action_required inbox row.
    const bobInbox = store.listInbox({ type: "member", id: "bob" });
    assert.equal(bobInbox[0]!.type, "mentioned");
    assert.equal(bobInbox[0]!.severity, "action_required");
  });

  it("invokes onAgentMention once per agent mention and honors skipNotify", () => {
    const seen: string[] = [];
    const { store } = tracked({
      actors: [{ id: "agent-browser", displayName: "浏览器助手" }],
      onAgentMention: ({ mentioned }) => {
        for (const ref of mentioned) seen.push(ref.id);
      },
    });
    const issue = store.createIssue({ title: "触发" });
    store.createComment({
      issueId: issue.id,
      body: "@浏览器助手 开始",
      author: ALICE,
    });
    assert.deepEqual(seen, ["agent-browser"]);

    seen.length = 0;
    store.createComment({
      issueId: issue.id,
      body: "@浏览器助手 重复但跳过",
      author: ALICE,
      skipNotify: true,
    });
    assert.deepEqual(seen, [], "skipNotify suppresses the hook");
  });

  it("enforces one-level replies within the same issue", () => {
    const { store } = tracked();
    const issue = store.createIssue({ title: "回复约束" });
    const top = store.createComment({ issueId: issue.id, body: "顶层", author: ALICE });
    const reply = store.createComment({
      issueId: issue.id,
      body: "一级回复",
      author: LOCAL,
      parentId: top.id,
    });
    assert.throws(
      () =>
        store.createComment({
          issueId: issue.id,
          body: "二级回复",
          author: LOCAL,
          parentId: reply.id,
        }),
      /top-level/,
    );
    const other = store.createIssue({ title: "另一个" });
    assert.throws(
      () =>
        store.createComment({
          issueId: other.id,
          body: "跨 issue 回复",
          author: LOCAL,
          parentId: top.id,
        }),
      /top-level/,
    );
  });

  it("persists across reopen (same file)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentkit-issues-reopen-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "issues.db");
    const first = new IssueStore(file);
    const issue = first.createIssue({ title: "持久化" });
    first.close();
    const second = new IssueStore(file);
    assert.equal(second.getIssue(issue.id)?.title, "持久化");
    assert.equal(second.listIssues().length, 1);
    second.close();
  });

  it("rejects invalid status and priority values", () => {
    const { store } = tracked();
    assert.throws(
      () => store.createIssue({ title: "x", status: "archived" as never }),
      /Invalid issue status/,
    );
    const issue = store.createIssue({ title: "x" });
    assert.throws(
      () => store.updateIssue(issue.id, { priority: "P9" as never }),
      /Invalid issue priority/,
    );
  });
});
