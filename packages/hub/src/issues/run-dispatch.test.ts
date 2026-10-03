import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { IssueStore } from "./store.js";
import {
  buildIssueTriggerPrompt,
  createIssueDispatcher,
} from "./run-dispatch.js";
import { formatMentionLink } from "./mention.js";
import type { ClientCommand, ClientEvent } from "../protocol/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkit-dispatch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new IssueStore(path.join(dir, "issues.db"), {
    actors: [{ id: "agent-a", displayName: "阿尔法" }],
  });
}

type OfferLog = Array<{ clientId: string; command: ClientCommand }>;

function harness(store: IssueStore) {
  const offers: OfferLog = [];
  let ids = 0;
  const dispatcher = createIssueDispatcher({
    store,
    offer: async (input) => {
      offers.push({ clientId: input.targetClientId, command: input.command });
      return {};
    },
    newId: () => `id-${(ids += 1)}`,
  });
  return { dispatcher, offers };
}

function eventObservation(events: Array<Partial<ClientEvent>>) {
  return {
    kind: "events.ingested" as const,
    clientId: "agent-a",
    count: events.length,
    at: Date.now(),
    events: events.map((event, index) => ({
      executionId: "id-1",
      eventSeq: index + 1,
      type: "done" as const,
      occurredAt: new Date().toISOString(),
      ...event,
    })),
  };
}

describe("issue trigger prompt", () => {
  it("carries issue meta, history, trigger comment and CLI pointers", () => {
    const store = tempStore();
    const issue = store.createIssue({ title: "登录崩溃", body: "堆栈如下…" });
    store.createComment({
      issueId: issue.id,
      body: "早前评论 1",
      author: { type: "member", id: "alice" },
    });
    const trigger = store.createComment({
      issueId: issue.id,
      body: "请你分析",
      author: { type: "member", id: "bob" },
    });
    const prompt = buildIssueTriggerPrompt({
      issue,
      comments: store.listComments(issue.id),
      triggerCommentIds: [trigger.id],
      agentActorId: "agent-a",
    });
    assert.match(prompt, /ISSUE-1 《登录崩溃》/);
    assert.match(prompt, /早前评论 1/);
    assert.match(prompt, /触发评论:/);
    assert.match(prompt, /issue show ISSUE-1 --json/);
    assert.match(prompt, /issue comment ISSUE-1/);
  });

  it("folds older comments when history exceeds the cap", () => {
    const store = tempStore();
    const issue = store.createIssue({ title: "长历史" });
    for (let i = 1; i <= 40; i += 1) {
      store.createComment({
        issueId: issue.id,
        body: `评论 ${"x".repeat(200)} #${i}`,
        author: { type: "member", id: "alice" },
      });
    }
    const comments = store.listComments(issue.id);
    const prompt = buildIssueTriggerPrompt({
      issue,
      comments,
      triggerCommentIds: [comments[comments.length - 1]!.id],
      agentActorId: "agent-a",
    });
    assert.match(prompt, /另有 \d+ 条较早评论/);
    assert.ok(prompt.length < 8_000, "prompt stays bounded");
  });
});

describe("issue dispatcher", () => {
  it("offers agent.run with the assembled prompt on mention", () => {
    const store = tempStore();
    const { dispatcher, offers } = harness(store);
    const issue = store.createIssue({ title: "触发" });
    const comment = store.createComment({
      issueId: issue.id,
      body: "阿尔法 来干活",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue, comment, mentioned: [{ type: "agent", id: "agent-a" }] });

    assert.equal(offers.length, 1);
    const offer = offers[0]!;
    assert.equal(offer.clientId, "agent-a");
    assert.equal(offer.command.kind, "agent.run");
    if (offer.command.kind !== "agent.run") return;
    assert.equal(offer.command.executionId, "id-1");
    assert.equal(offer.command.taskId, `issue-${issue.id}`);
    assert.match(String(offer.command.payload.prompt), /ISSUE-1/);
    assert.equal(store.listExecutions(issue.id)[0]!.status, "open");
  });

  it("coalesces mentions while an execution is open, re-arms on done", () => {
    const store = tempStore();
    const { dispatcher, offers } = harness(store);
    const issue = store.createIssue({ title: "合并" });
    const first = store.createComment({
      issueId: issue.id,
      body: "第一轮",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue, comment: first, mentioned: [{ type: "agent", id: "agent-a" }] });
    assert.equal(offers.length, 1);

    const second = store.createComment({
      issueId: issue.id,
      body: "补充需求",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue, comment: second, mentioned: [{ type: "agent", id: "agent-a" }] });
    assert.equal(offers.length, 1, "open round absorbs the second mention");
    assert.deepEqual(
      store.findExecutionByExecutionId("id-1")!.coalescedCommentIds,
      [second.id],
    );

    dispatcher.onObservation(
      eventObservation([{ type: "done", executionId: "id-1" }]),
    );
    assert.equal(store.findExecutionByExecutionId("id-1")!.status, "done");
    assert.equal(offers.length, 2, "done re-arms with parked comments");
    const secondRound = offers[1]!;
    if (secondRound.command.kind !== "agent.run") throw new Error("not a run");
    assert.match(String(secondRound.command.payload.prompt), /补充需求/);
  });

  it("writes a failure comment on failed execution and does not re-arm", () => {
    const store = tempStore();
    const { dispatcher, offers } = harness(store);
    const issue = store.createIssue({ title: "失败" });
    const first = store.createComment({
      issueId: issue.id,
      body: "干活",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue, comment: first, mentioned: [{ type: "agent", id: "agent-a" }] });
    const parked = store.createComment({
      issueId: issue.id,
      body: "运行中追加",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue, comment: parked, mentioned: [{ type: "agent", id: "agent-a" }] });

    dispatcher.onObservation(
      eventObservation([
        {
          type: "failed",
          executionId: "id-1",
          payload: { reason: "platform missing", stderrTail: "boom" },
        },
      ]),
    );
    assert.equal(offers.length, 1, "failure does not re-arm");
    const comments = store.listComments(issue.id);
    const failure = comments.find((c) => c.body.includes("[execution failed]"));
    assert.ok(failure, "failure comment written");
    assert.match(failure!.body, /platform missing/);
    assert.equal(failure!.authorActorType, "agent");
    assert.equal(failure!.authorActorId, "agent-a");
    assert.equal(store.findExecutionByExecutionId("id-1")!.status, "failed");
  });

  it("never dispatches on terminal issues and tracks inventory runtimes", () => {
    const store = tempStore();
    const { dispatcher, offers } = harness(store);
    const done = store.createIssue({ title: "已完结", status: "done" });
    const comment = store.createComment({
      issueId: done.id,
      body: "迟到的 @阿尔法",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue: done, comment, mentioned: [{ type: "agent", id: "agent-a" }] });
    assert.equal(offers.length, 0);

    dispatcher.onObservation({
      kind: "inventory.recorded",
      clientId: "agent-b",
      report: {
        platforms: [
          { platform: "claude", installed: false, version: null },
          { platform: "pi", installed: true, version: "1.0" },
        ],
        plugins: [],
        projects: [],
      } as never,
      at: Date.now(),
    });
    const live = store.createIssue({ title: "第二台" });
    const mention = store.createComment({
      issueId: live.id,
      body: "去吧",
      author: { type: "member", id: "alice" },
    });
    dispatcher.onAgentMention({ issue: live, comment: mention, mentioned: [{ type: "agent", id: "agent-b" }] });
    const offer = offers[0]!;
    if (offer.command.kind !== "agent.run") throw new Error("not a run");
    assert.equal(offer.command.runtime, "pi", "inventory picks the installed platform");
  });

  it("offer delivery failure closes the round as failed", async () => {
    const store = tempStore();
    let ids = 0;
    const dispatcher = createIssueDispatcher({
      store,
      offer: async () => {
        throw new Error("hub store failure");
      },
      newId: () => `id-${(ids += 1)}`,
    });
    const issue = store.createIssue({ title: "投递失败" });
    const comment = store.createComment({
      issueId: issue.id,
      body: `${formatMentionLink("agent", "agent-a", "阿尔法")} 走你`,
      author: { type: "member", id: "alice" },
    });
    const mentioned = comment.mentions.filter((m) => m.type === "agent");
    dispatcher.onAgentMention({ issue, comment, mentioned });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.findExecutionByExecutionId("id-1")!.status, "failed");
  });
});
