/**
 * Issue domain store: one SQLite file owned by the client install, following
 * the ClientStateStore pattern (node:sqlite, BEGIN IMMEDIATE transactions,
 * CREATE TABLE IF NOT EXISTS with PRAGMA-based column migration).
 *
 * Renamed from the AllInAI task domain; execution coupling removed. All
 * mutating ops return the affected records and run change notifications
 * (inbox rows + mention side effects) inline so callers get one-shot
 * "write and its consequences" semantics like AllInAI's comment-ops.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  LOCAL_MEMBER_ID,
  isIssuePriority,
  type ActorType,
  isIssueStatus,
  isTerminalIssueStatus,
  issueKeyFromSeq,
  type ActorRef,
  type CommentRecord,
  type CreateCommentInput,
  type CreateIssueInput,
  type InboxItemRecord,
  type InboxItemType,
  type InboxSeverity,
  type IssuePriority,
  type IssueRecord,
  type IssueStatus,
  type IssueSubscriberRecord,
  type IssueSummary,
  type SubscriberReason,
  type UpdateIssueInput,
} from "./types.js";
import { parseAgentMentions, type MentionActor } from "./mention.js";

export type IssueStoreOptions = {
  /**
   * Directory of known agents for @name mention resolution. A function is
   * re-evaluated on every comment write so the directory can track live
   * client registrations.
   */
  actors?: ReadonlyArray<MentionActor> | (() => ReadonlyArray<MentionActor>);
  /**
   * Side effect when a written comment mentions agents. The store never
   * executes anything itself; run dispatch is wired here by the host.
   */
  onAgentMention?: (input: {
    issue: IssueRecord;
    comment: CommentRecord;
    mentioned: ActorRef[];
  }) => void;
};

type IssueRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  project_id: string | null;
  assignee_actor_type: string | null;
  assignee_actor_id: string | null;
  display_seq: number;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: string;
  issue_id: string;
  author_actor_type: ActorType;
  author_actor_id: string;
  body: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string | null;
};

type MentionRow = { actor_type: ActorType; actor_id: string };

type SubscriberRow = {
  issue_id: string;
  actor_type: ActorType;
  actor_id: string;
  reason: SubscriberReason;
  created_at: string;
};

type InboxRow = {
  id: string;
  recipient_type: ActorType;
  recipient_id: string;
  actor_type: ActorType | null;
  actor_id: string | null;
  type: string;
  severity: string;
  issue_id: string | null;
  title: string;
  body: string | null;
  read: number;
  archived: number;
  details: string | null;
  created_at: string;
  issue_status: string | null;
};

export type IssueExecutionStatus = "open" | "done" | "failed" | "cancelled";

export type IssueExecutionRecord = {
  executionId: string;
  issueId: string;
  agentActorId: string;
  triggerCommentId: string | null;
  coalescedCommentIds: string[];
  status: IssueExecutionStatus;
  offeredAt: string;
  finishedAt: string | null;
};

type ExecutionRow = {
  execution_id: string;
  issue_id: string;
  agent_actor_id: string;
  trigger_comment_id: string | null;
  coalesced_comment_ids: string;
  status: string;
  offered_at: string;
  finished_at: string | null;
};

export class IssueStore {
  private readonly db: DatabaseSync;
  private readonly options: IssueStoreOptions;

  constructor(dbPath: string, options: IssueStoreOptions = {}) {
    this.db = new DatabaseSync(dbPath);
    this.options = options;
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- issues

  createIssue(input: CreateIssueInput): IssueRecord {
    const title = requireText(input.title, "title");
    const status = input.status ?? "todo";
    const priority = input.priority ?? "P2";
    if (!isIssueStatus(status)) throw new Error(`Invalid issue status: ${status}`);
    if (!isIssuePriority(priority)) {
      throw new Error(`Invalid issue priority: ${priority}`);
    }
    const author = input.author ?? { type: "member", id: LOCAL_MEMBER_ID };
    const now = new Date().toISOString();
    const id = randomUUID();
    return this.transaction(() => {
      const seq = this.nextDisplaySeq();
      this.db
        .prepare(
          `INSERT INTO issues
             (id, title, body, status, priority, project_id,
              assignee_actor_type, assignee_actor_id, display_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          title,
          input.body ?? "",
          status,
          priority,
          input.projectId ?? null,
          input.assignee?.type ?? null,
          input.assignee?.id ?? null,
          seq,
          now,
          now,
        );
      this.autoSubscribe(id, author, "creator");
      const assignee = input.assignee ?? null;
      if (assignee) {
        this.autoSubscribe(id, assignee, "assignee");
        if (assignee.type === "member" && assignee.id !== author.id) {
          this.createInboxItem({
            recipient: assignee,
            actor: author,
            type: "issue_assigned",
            severity: "action_required",
            issueId: id,
            title,
          });
        }
      }
      return this.requireIssue(id);
    });
  }

  getIssue(ref: string): IssueRecord | null {
    const row = this.getIssueRow(this.canonicalIssueId(ref));
    return row ? this.rowToIssue(row) : null;
  }

  listIssues(filter?: {
    status?: IssueStatus;
    projectId?: string | null;
    limit?: number;
  }): IssueSummary[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.status) {
      clauses.push("i.status = ?");
      params.push(filter.status);
    }
    if (filter && "projectId" in filter) {
      clauses.push(filter.projectId === null ? "i.project_id IS NULL" : "i.project_id = ?");
      if (filter.projectId != null) params.push(filter.projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, filter?.limit ?? 200));
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM comments c
                  WHERE c.issue_id = i.id AND c.parent_id IS NULL) AS open_comments
           FROM issues i ${where}
          ORDER BY i.display_seq DESC
          LIMIT ?`,
      )
      .all(...params) as unknown as Array<IssueRow & { open_comments: number }>;
    return rows.map((row) => {
      const record = this.rowToIssue(row);
      return {
        id: record.id,
        issueKey: record.issueKey,
        displaySeq: record.displaySeq,
        title: record.title,
        status: record.status,
        priority: record.priority,
        projectId: record.projectId,
        assigneeActorType: record.assigneeActorType,
        assigneeActorId: record.assigneeActorId,
        openCommentCount: Number(row.open_comments ?? 0),
      };
    });
  }

  updateIssue(ref: string, input: UpdateIssueInput): IssueRecord {
    const actor = input.actor ?? { type: "member", id: LOCAL_MEMBER_ID };
    return this.transaction(() => {
      const current = this.requireIssue(this.canonicalIssueId(ref));
      const next: Partial<IssueRecord> = {};
      if (input.title !== undefined) next.title = requireText(input.title, "title");
      if (input.body !== undefined) next.body = input.body;
      if (input.status !== undefined) {
        if (!isIssueStatus(input.status)) {
          throw new Error(`Invalid issue status: ${input.status}`);
        }
        next.status = input.status;
      }
      if (input.priority !== undefined) {
        if (!isIssuePriority(input.priority)) {
          throw new Error(`Invalid issue priority: ${input.priority}`);
        }
        next.priority = input.priority;
      }

      const previousAssignee: ActorRef | null =
        current.assigneeActorType && current.assigneeActorId
          ? { type: current.assigneeActorType, id: current.assigneeActorId }
          : null;
      let nextAssignee = previousAssignee;
      if (input.assignee !== undefined) nextAssignee = input.assignee;

      this.db
        .prepare(
          `UPDATE issues
              SET title = ?, body = ?, status = ?, priority = ?,
                  assignee_actor_type = ?, assignee_actor_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          next.title ?? current.title,
          next.body ?? current.body,
          next.status ?? current.status,
          next.priority ?? current.priority,
          nextAssignee?.type ?? null,
          nextAssignee?.id ?? null,
          new Date().toISOString(),
          current.id,
        );

      // Subscription / notification side effects, mirroring AllInAI task-ops.
      if (input.assignee !== undefined) {
        if (previousAssignee) this.autoSubscribe(current.id, previousAssignee, "assignee");
        if (nextAssignee) this.autoSubscribe(current.id, nextAssignee, "assignee");
        if (nextAssignee?.type === "member") {
          const changed =
            previousAssignee?.id !== nextAssignee.id ||
            previousAssignee?.type !== nextAssignee.type;
          if (changed && nextAssignee.id !== actor.id) {
            this.createInboxItem({
              recipient: nextAssignee,
              actor,
              type: previousAssignee ? "assignee_changed" : "issue_assigned",
              severity: "action_required",
              issueId: current.id,
              title: current.title,
            });
          }
        }
        if (previousAssignee && !nextAssignee) {
          this.notifySubscribers(current, actor, "unassigned", "attention", {
            previousAssignee: `${previousAssignee.type}:${previousAssignee.id}`,
          });
        }
      }
      if (next.status && next.status !== current.status) {
        this.notifySubscribers(current, actor, "status_changed", "attention", {
          from: current.status,
          to: next.status,
        });
      }
      if (next.priority && next.priority !== current.priority) {
        this.notifySubscribers(current, actor, "priority_changed", "info", {
          from: current.priority,
          to: next.priority,
        });
      }
      return this.requireIssue(current.id);
    });
  }

  // -------------------------------------------------------------- comments

  createComment(input: CreateCommentInput): CommentRecord {
    const body = requireText(input.body, "body");
    const author = input.author ?? { type: "member", id: LOCAL_MEMBER_ID };
    return this.transaction(() => {
      const issue = this.requireIssue(this.canonicalIssueId(input.issueId));
      const parentId = input.parentId ?? null;
      if (parentId) {
        const parent = this.getComment(parentId);
        if (!parent || parent.issueId !== issue.id || parent.parentId) {
          throw new Error(
            "parentId must reference a top-level comment on the same issue",
          );
        }
      }

      const actors =
        typeof this.options.actors === "function"
          ? this.options.actors()
          : (this.options.actors ?? []);
      const mentions = parseAgentMentions(body, actors, {
        excludeActorId: author.type === "agent" ? author.id : undefined,
      });

      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO comments (id, issue_id, author_actor_type, author_actor_id, body, parent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, issue.id, author.type, author.id, body, parentId, now);
      for (const mention of mentions) {
        this.db
          .prepare(
            `INSERT INTO comment_mentions (comment_id, actor_type, actor_id) VALUES (?, ?, ?)`,
          )
          .run(id, mention.type, mention.id);
      }

      this.autoSubscribe(issue.id, author, "commenter");
      for (const mention of mentions) {
        if (mention.type === "member") {
          this.autoSubscribe(issue.id, mention, "mentioned");
        }
      }

      if (!input.skipNotify) {
        this.notifySubscribers(issue, author, "new_comment", "info", undefined, {
          body,
          exclude: new Set([author.id, ...mentions.map((m) => m.id)]),
        });
        for (const mention of mentions) {
          if (mention.type !== "member") continue;
          this.createInboxItem({
            recipient: mention,
            actor: author,
            type: "mentioned",
            severity: "action_required",
            issueId: issue.id,
            title: issue.title,
            body,
          });
        }
      }

      const comment = this.requireComment(id);
      const agentMentions = mentions.filter((m) => m.type === "agent");
      if (!input.skipNotify && agentMentions.length > 0) {
        this.options.onAgentMention?.({
          issue,
          comment,
          mentioned: agentMentions,
        });
      }
      return comment;
    });
  }

  getComment(commentId: string): CommentRecord | null {
    const row = this.getCommentRow(commentId);
    return row ? this.rowToComment(row) : null;
  }

  listComments(issueRef: string): CommentRecord[] {
    const issueId = this.canonicalIssueId(issueRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE issue_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(issueId) as unknown as CommentRow[];
    return rows.map((row) => this.rowToComment(row));
  }

  // ----------------------------------------------------------- subscribers

  listSubscribers(issueRef: string): IssueSubscriberRecord[] {
    const issueId = this.canonicalIssueId(issueRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM issue_subscribers WHERE issue_id = ?
          ORDER BY created_at ASC, actor_type ASC, actor_id ASC`,
      )
      .all(issueId) as unknown as SubscriberRow[];
    return rows.map((row) => ({
      issueId: row.issue_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  // ------------------------------------------------------------- executions

  /** The still-open dispatch of one issue to one agent, if any. */
  findOpenExecution(
    issueId: string,
    agentActorId: string,
  ): IssueExecutionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM issue_executions
          WHERE issue_id = ? AND agent_actor_id = ? AND status = 'open'
          ORDER BY offered_at DESC LIMIT 1`,
      )
      .get(issueId, agentActorId) as ExecutionRow | undefined;
    return row ? this.rowToExecution(row) : null;
  }

  findExecutionByExecutionId(executionId: string): IssueExecutionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM issue_executions WHERE execution_id = ?`)
      .get(executionId) as ExecutionRow | undefined;
    return row ? this.rowToExecution(row) : null;
  }

  openExecution(input: {
    executionId: string;
    issueId: string;
    agentActorId: string;
    triggerCommentId: string | null;
  }): IssueExecutionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO issue_executions
           (execution_id, issue_id, agent_actor_id, trigger_comment_id,
            coalesced_comment_ids, status, offered_at)
         VALUES (?, ?, ?, ?, '[]', 'open', ?)`,
      )
      .run(
        input.executionId,
        input.issueId,
        input.agentActorId,
        input.triggerCommentId,
        now,
      );
    return this.findExecutionByExecutionId(input.executionId)!;
  }

  /** Park a comment that arrived while an execution was open (coalesce). */
  appendPendingComment(executionId: string, commentId: string): void {
    const row = this.findExecutionByExecutionId(executionId);
    if (!row) return;
    const pending = [...row.coalescedCommentIds];
    if (!pending.includes(commentId)) pending.push(commentId);
    this.db
      .prepare(`UPDATE issue_executions SET coalesced_comment_ids = ? WHERE execution_id = ?`)
      .run(JSON.stringify(pending), executionId);
  }

  /** Close an execution; returns the final row (pending comments included). */
  finishExecution(
    executionId: string,
    status: "done" | "failed" | "cancelled",
  ): IssueExecutionRecord | null {
    const row = this.findExecutionByExecutionId(executionId);
    if (!row) return null;
    this.db
      .prepare(
        `UPDATE issue_executions SET status = ?, finished_at = ? WHERE execution_id = ?`,
      )
      .run(status, new Date().toISOString(), executionId);
    return this.findExecutionByExecutionId(executionId);
  }

  listExecutions(issueRef: string): IssueExecutionRecord[] {
    const issueId = this.canonicalIssueId(issueRef);
    const rows = this.db
      .prepare(
        `SELECT * FROM issue_executions WHERE issue_id = ? ORDER BY offered_at DESC`,
      )
      .all(issueId) as unknown as ExecutionRow[];
    return rows.map((row) => this.rowToExecution(row));
  }

  // ----------------------------------------------------------------- inbox

  listInbox(recipient: ActorRef, options?: { limit?: number }): InboxItemRecord[] {
    const limit = Math.max(1, Math.min(500, options?.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT n.*, i.status AS issue_status
           FROM inbox_items n
           LEFT JOIN issues i ON i.id = n.issue_id
          WHERE n.recipient_type = ? AND n.recipient_id = ?
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ?`,
      )
      .all(recipient.type, recipient.id, limit) as unknown as InboxRow[];
    return rows.map((row) => this.rowToInbox(row));
  }

  markInboxRead(itemId: string): void {
    this.db
      .prepare(`UPDATE inbox_items SET read = 1 WHERE id = ?`)
      .run(itemId);
  }

  archiveInbox(itemId: string): void {
    this.db
      .prepare(`UPDATE inbox_items SET archived = 1 WHERE id = ?`)
      .run(itemId);
  }

  // --------------------------------------------------------------- internls

  private initialize(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS issues (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo',
          priority TEXT NOT NULL DEFAULT 'P2',
          project_id TEXT,
          assignee_actor_type TEXT,
          assignee_actor_id TEXT,
          display_seq INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_issues_project ON issues (project_id);

        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          author_actor_type TEXT NOT NULL,
          author_actor_id TEXT NOT NULL,
          body TEXT NOT NULL,
          parent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments (issue_id);

        CREATE TABLE IF NOT EXISTS comment_mentions (
          comment_id TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          PRIMARY KEY (comment_id, actor_type, actor_id)
        );

        CREATE TABLE IF NOT EXISTS issue_subscribers (
          issue_id TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (issue_id, actor_type, actor_id)
        );

        CREATE TABLE IF NOT EXISTS inbox_items (
          id TEXT PRIMARY KEY,
          recipient_type TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          actor_type TEXT,
          actor_id TEXT,
          type TEXT NOT NULL,
          severity TEXT NOT NULL,
          issue_id TEXT,
          title TEXT NOT NULL,
          body TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          details TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_inbox_recipient
          ON inbox_items (recipient_type, recipient_id, created_at);

        CREATE TABLE IF NOT EXISTS issue_executions (
          execution_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          agent_actor_id TEXT NOT NULL,
          trigger_comment_id TEXT,
          coalesced_comment_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'open',
          offered_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_issue_exec_open
          ON issue_executions (issue_id, agent_actor_id, status);
      `);
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private nextDisplaySeq(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(display_seq), 0) + 1 AS seq FROM issues`)
      .get() as { seq: number };
    return Number(row.seq);
  }

  /** Resolve `ISSUE-5` style keys to the UUID primary key. */
  private canonicalIssueId(ref: string): string {
    if (!ref) throw new Error("Issue reference is required");
    if (ref.startsWith("ISSUE-")) {
      const seq = Number(ref.slice("ISSUE-".length));
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new Error(`Invalid issue key: ${ref}`);
      }
      const row = this.db
        .prepare(`SELECT id FROM issues WHERE display_seq = ?`)
        .get(seq) as { id: string } | undefined;
      if (!row) throw new Error(`Issue not found: ${ref}`);
      return row.id;
    }
    return ref;
  }

  private getIssueRow(id: string): IssueRow | undefined {
    return this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id) as
      | IssueRow
      | undefined;
  }

  private requireIssue(ref: string): IssueRecord {
    const row = this.getIssueRow(this.canonicalIssueId(ref));
    if (!row) throw new Error(`Issue not found: ${ref}`);
    return this.rowToIssue(row);
  }

  private rowToIssue(row: IssueRow): IssueRecord {
    if (!isIssueStatus(row.status)) throw new Error(`Corrupt issue status: ${row.status}`);
    if (!isIssuePriority(row.priority)) {
      throw new Error(`Corrupt issue priority: ${row.priority}`);
    }
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      priority: row.priority,
      projectId: row.project_id ?? null,
      assigneeActorType: (row.assignee_actor_type as ActorRef["type"]) ?? null,
      assigneeActorId: row.assignee_actor_id ?? null,
      displaySeq: Number(row.display_seq),
      issueKey: issueKeyFromSeq(Number(row.display_seq)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getCommentRow(id: string): CommentRow | undefined {
    return this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as
      | CommentRow
      | undefined;
  }

  private requireComment(id: string): CommentRecord {
    const row = this.getCommentRow(id);
    if (!row) throw new Error(`Comment not found: ${id}`);
    return this.rowToComment(row);
  }

  private rowToComment(row: CommentRow): CommentRecord {
    const mentionRows = this.db
      .prepare(
        `SELECT actor_type, actor_id FROM comment_mentions WHERE comment_id = ?
          ORDER BY actor_type, actor_id`,
      )
      .all(row.id) as unknown as MentionRow[];
    return {
      id: row.id,
      issueId: row.issue_id,
      authorActorType: row.author_actor_type,
      authorActorId: row.author_actor_id,
      body: row.body,
      createdAt: row.created_at,
      parentId: row.parent_id ?? null,
      updatedAt: row.updated_at ?? row.created_at,
      mentions: mentionRows.map((m) => ({ type: m.actor_type, id: m.actor_id })),
    };
  }

  private autoSubscribe(
    issueId: string,
    actor: ActorRef,
    reason: SubscriberReason,
  ): void {
    if (actor.type === "member" && actor.id === "system") return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO issue_subscribers (issue_id, actor_type, actor_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(issueId, actor.type, actor.id, reason, new Date().toISOString());
  }

  private notifySubscribers(
    issue: IssueRecord,
    actor: ActorRef,
    type: InboxItemType,
    severity: InboxSeverity,
    details?: Record<string, string>,
    options?: { body?: string; exclude?: Set<string> },
  ): void {
    const exclude = new Set(options?.exclude ?? []);
    exclude.add(actor.id);
    const subscribers = this.listSubscribers(issue.id);
    for (const subscriber of subscribers) {
      if (subscriber.actorType !== "member") continue;
      if (exclude.has(subscriber.actorId)) continue;
      this.createInboxItem({
        recipient: { type: subscriber.actorType, id: subscriber.actorId },
        actor,
        type,
        severity,
        issueId: issue.id,
        title: issue.title,
        body: options?.body ?? null,
        details,
      });
    }
  }

  private createInboxItem(input: {
    recipient: ActorRef;
    actor: ActorRef;
    type: InboxItemType;
    severity: InboxSeverity;
    issueId: string;
    title: string;
    body?: string | null;
    details?: Record<string, string>;
  }): void {
    // Never notify an actor about their own action.
    if (input.recipient.id === input.actor.id && input.recipient.type === input.actor.type) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO inbox_items
           (id, recipient_type, recipient_id, actor_type, actor_id, type, severity,
            issue_id, title, body, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.recipient.type,
        input.recipient.id,
        input.actor.type,
        input.actor.id,
        input.type,
        input.severity,
        input.issueId,
        input.title,
        input.body ?? null,
        input.details ? JSON.stringify(input.details) : null,
        new Date().toISOString(),
      );
  }

  private rowToExecution(row: ExecutionRow): IssueExecutionRecord {
    let coalesced: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.coalesced_comment_ids);
      if (Array.isArray(parsed)) {
        coalesced = parsed.filter((id): id is string => typeof id === "string");
      }
    } catch {
      coalesced = [];
    }
    return {
      executionId: row.execution_id,
      issueId: row.issue_id,
      agentActorId: row.agent_actor_id,
      triggerCommentId: row.trigger_comment_id ?? null,
      coalescedCommentIds: coalesced,
      status: row.status as IssueExecutionStatus,
      offeredAt: row.offered_at,
      finishedAt: row.finished_at ?? null,
    };
  }

  private rowToInbox(row: InboxRow): InboxItemRecord {
    return {
      id: row.id,
      recipientType: row.recipient_type,
      recipientId: row.recipient_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      type: row.type as InboxItemType,
      severity: row.severity as InboxSeverity,
      issueId: row.issue_id ?? null,
      title: row.title,
      body: row.body ?? null,
      read: Number(row.read) === 1,
      archived: Number(row.archived) === 1,
      details: row.details ? (JSON.parse(row.details) as Record<string, string>) : null,
      createdAt: row.created_at,
      issueStatus: (row.issue_status as IssueStatus | null) ?? null,
    };
  }
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Issue ${field} must be a non-empty string`);
  return trimmed;
}

/** Statuses where new mentions may still trigger agents (non-terminal). */
export function issueAcceptsMentions(status: IssueStatus): boolean {
  return !isTerminalIssueStatus(status);
}
