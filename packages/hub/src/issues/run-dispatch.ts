/**
 * Issue run dispatch (M3): the only place where the issue domain meets the
 * hub execution channel.
 *
 * Trigger: a comment mention (IssueStore.onAgentMention) resolves the agent
 * to a client and offers an agent.run whose payload.prompt carries the full
 * trigger context — issue meta, recent comments, and CLI pointers. There is
 * no env injection and no platform hook: ordinary executions are untouched,
 * and an agent learns everything it needs from the prompt plus the static
 * `issues` skill shipped in the default plugin.
 *
 * Coalescing: mentions arriving while an execution is open are parked on its
 * row; when it finishes successfully the next round is offered automatically
 * with the parked comments as the trigger. Failures close the row and write
 * a runtime-failure comment (the agent cannot report its own crash); parked
 * comments stay visible on the row but are not re-armed.
 */

import { randomUUID } from "node:crypto";
import type { HubObservation } from "../console/observable-store.js";
import type { ClientCommand, RuntimeId } from "../protocol/index.js";
import type { IssueStore } from "./store.js";
import type { ActorRef, CommentRecord, IssueRecord } from "./types.js";

/** Soft cap on the assembled context block; overflow folds older comments. */
const PROMPT_CONTEXT_CHAR_LIMIT = 4_000;
/** Hard cap for a runtime-failure comment body. */
const FAILURE_BODY_CHAR_LIMIT = 600;

export type IssueDispatcherOptions = {
  store: IssueStore;
  /** hub.offer shim; the caller supplies the principal. */
  offer: (input: {
    targetClientId: string;
    command: ClientCommand;
  }) => Promise<unknown>;
  /**
   * Runtime to dispatch on, per client. Falls back to "claude" when a client
   * has not reported inventory yet — a missing platform fails the execution
   * fast and surfaces as a failure comment.
   */
  resolveRuntime?: (clientId: string) => RuntimeId | null;
  /** Injectable id factory for tests. */
  newId?: () => string;
};

export type IssueDispatcher = {
  onAgentMention(input: {
    issue: IssueRecord;
    comment: CommentRecord;
    mentioned: ActorRef[];
  }): void;
  /** Feed hub observations; only terminal events and inventory matter. */
  onObservation(observation: HubObservation): void;
};

function actorLabel(comment: CommentRecord): string {
  return `${comment.authorActorType}:${comment.authorActorId}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Assemble the trigger prompt: everything the agent needs inline (so a
 * platform without any injection hooks still works), with CLI pointers for
 * anything the context cap folded away.
 */
export function buildIssueTriggerPrompt(input: {
  issue: IssueRecord;
  comments: CommentRecord[];
  triggerCommentIds: string[];
  agentActorId: string;
}): string {
  const { issue, comments, triggerCommentIds, agentActorId } = input;
  const trigger = new Set(triggerCommentIds);
  const triggerComments = comments.filter((c) => trigger.has(c.id));
  const historyComments = comments.filter(
    (c) => !trigger.has(c.id) && c.authorActorId !== agentActorId,
  );

  const lines: string[] = [
    "[agentkit] 你在 issue 协作流中被 @ 触发，请处理并回报结论。",
    "",
    `Issue: ${issue.issueKey} 《${issue.title}》(${issue.status} / ${issue.priority})`,
  ];
  if (issue.body) lines.push(`正文:\n${clip(issue.body, PROMPT_CONTEXT_CHAR_LIMIT / 2)}`);

  // Newest comments that fit: fold the oldest into a count line.
  const kept: string[] = [];
  let budget = PROMPT_CONTEXT_CHAR_LIMIT;
  for (let index = historyComments.length - 1; index >= 0; index -= 1) {
    const comment = historyComments[index]!;
    const line = `- ${actorLabel(comment)}: ${comment.body}`;
    if (line.length > budget && kept.length > 0) break;
    kept.unshift(line);
    budget -= line.length;
    if (budget <= 0) break;
  }
  const folded = historyComments.length - kept.length;
  if (kept.length > 0) {
    lines.push("最近评论:");
    if (folded > 0) {
      lines.push(`  [另有 ${folded} 条较早评论，可自行查阅]`);
    }
    lines.push(...kept.map((line) => `  ${line}`));
  }

  if (triggerComments.length > 0) {
    lines.push("触发评论:");
    for (const comment of triggerComments) {
      lines.push(`  ${actorLabel(comment)}: ${comment.body}`);
    }
  }

  lines.push(
    "",
    "处理指引:",
    `- 完整上下文与历史: allinai-agentkit issue show ${issue.issueKey} --json`,
    `- 回报结论(必做): allinai-agentkit issue comment ${issue.issueKey} --body "…"`,
    `- 需要时更新状态: allinai-agentkit issue update ${issue.issueKey} --status in_review`,
    "- 更详细的用法见你的 issues 技能。",
  );
  return lines.join("\n");
}

function failureBody(payload: Record<string, unknown> | undefined): string {
  const reason =
    typeof payload?.reason === "string" && payload.reason
      ? payload.reason
      : payload
        ? JSON.stringify(payload)
        : "unknown error";
  return `[execution failed] ${clip(reason, FAILURE_BODY_CHAR_LIMIT)}`;
}

export function createIssueDispatcher(
  options: IssueDispatcherOptions,
): IssueDispatcher {
  const { store, offer } = options;
  const newId = options.newId ?? randomUUID;
  const runtimes = new Map<string, RuntimeId>();

  function resolveRuntime(clientId: string): RuntimeId {
    return options.resolveRuntime?.(clientId) ?? runtimes.get(clientId) ?? "claude";
  }

  function dispatchRound(
    issue: IssueRecord,
    agentActorId: string,
    triggerCommentIds: string[],
  ): void {
    const executionId = newId();
    const comments = store.listComments(issue.id);
    store.openExecution({
      executionId,
      issueId: issue.id,
      agentActorId,
      triggerCommentId: triggerCommentIds[0] ?? null,
    });
    const prompt = buildIssueTriggerPrompt({
      issue,
      comments,
      triggerCommentIds,
      agentActorId,
    });
    const command: ClientCommand = {
      kind: "agent.run",
      commandId: newId(),
      executionId,
      taskId: `issue-${issue.id}`,
      attempt: 1,
      runtime: resolveRuntime(agentActorId),
      payload: { prompt },
    };
    void offer({ targetClientId: agentActorId, command }).catch(() => {
      // Delivery failure is still a terminal outcome for this round.
      if (store.findExecutionByExecutionId(executionId)?.status === "open") {
        store.finishExecution(executionId, "failed");
      }
    });
  }

  return {
    onAgentMention({ issue, comment, mentioned }) {
      for (const agent of mentioned) {
        if (issue.status === "done" || issue.status === "cancelled") continue;
        const open = store.findOpenExecution(issue.id, agent.id);
        if (open) {
          // A round is already running for this agent: park, don't re-offer.
          if (open.executionId !== comment.id) {
            store.appendPendingComment(open.executionId, comment.id);
          }
          continue;
        }
        dispatchRound(issue, agent.id, [comment.id]);
      }
    },

    onObservation(observation) {
      if (observation.kind === "inventory.recorded") {
        const installed = observation.report.platforms
          .filter((entry) => entry.installed)
          .map((entry) => entry.platform);
        if (installed.length > 0) {
          runtimes.set(observation.clientId, installed[0]!);
        }
        return;
      }
      if (observation.kind !== "events.ingested") return;
      for (const event of observation.events) {
        if (
          event.type !== "done" &&
          event.type !== "failed" &&
          event.type !== "cancelled"
        ) {
          continue;
        }
        const row = store.findExecutionByExecutionId(event.executionId);
        if (!row || row.status !== "open") continue;
        const final =
          store.finishExecution(event.executionId, event.type) ?? row;

        if (event.type === "failed") {
          // The agent cannot report its own crash; the hub writes the fact.
          store.createComment({
            issueId: row.issueId,
            body: failureBody(event.payload),
            author: { type: "agent", id: row.agentActorId },
            skipNotify: true,
          });
          continue;
        }
        if (event.type === "done" && final.coalescedCommentIds.length > 0) {
          // Mentions that arrived mid-run start the next round with fresh
          // context; re-read the issue in case the agent changed its state.
          const issue = store.getIssue(row.issueId);
          if (issue && issue.status !== "done" && issue.status !== "cancelled") {
            dispatchRound(issue, row.agentActorId, final.coalescedCommentIds);
          }
        }
      }
    },
  };
}

// Keep `now` referenced for callers that inject it (documented option).
export type { IssueDispatcherOptions as DispatcherOptions };
