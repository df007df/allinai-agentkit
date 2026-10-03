/**
 * Issue domain types, renamed and slimmed from the AllInAI task domain
 * (packages/domain/src/services/task/types.ts). Execution coupling (task-run
 * rows, sessions, remote transport) is intentionally absent: an issue only
 * ever references an agentkit `executionId` as a weak link.
 */

export type ActorType = "member" | "agent";

export type ActorRef = { type: ActorType; id: string };

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

export type IssuePriority = "P0" | "P1" | "P2" | "P3";

export const ISSUE_PRIORITIES: readonly IssuePriority[] = [
  "P0",
  "P1",
  "P2",
  "P3",
];

export type IssueRecord = {
  id: string;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** Null = unscoped (no project cwd association). */
  projectId: string | null;
  assigneeActorType: ActorType | null;
  assigneeActorId: string | null;
  /** Global auto-increment display number; UI shows `ISSUE-{displaySeq}`. */
  displaySeq: number;
  /** Human/MCP query key `ISSUE-{displaySeq}`; the UUID remains the PK. */
  issueKey: string;
  createdAt: string;
  updatedAt: string;
};

/** Board-oriented list row (no body). */
export type IssueSummary = Pick<
  IssueRecord,
  | "id"
  | "issueKey"
  | "displaySeq"
  | "title"
  | "status"
  | "priority"
  | "projectId"
  | "assigneeActorType"
  | "assigneeActorId"
> & { openCommentCount: number };

export type CreateIssueInput = {
  title: string;
  body?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  projectId?: string | null;
  assignee?: ActorRef | null;
  /** Creator stamp; defaults to the local member. */
  author?: ActorRef;
};

export type UpdateIssueInput = {
  title?: string;
  body?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: ActorRef | null;
  /** Actor performing the change; drives change notifications. */
  actor?: ActorRef;
};

export type CommentRecord = {
  id: string;
  issueId: string;
  authorActorType: ActorType;
  authorActorId: string;
  body: string;
  createdAt: string;
  /** Null = top-level; non-null must reference a top-level comment on the same issue. */
  parentId: string | null;
  updatedAt: string;
  mentions: ActorRef[];
};

export type CreateCommentInput = {
  issueId: string;
  body: string;
  author?: ActorRef;
  /** One-level reply: must reference a top-level comment on the same issue. */
  parentId?: string | null;
  /** Skip mention-triggered side effects (e.g. an agent echoing its conclusion). */
  skipNotify?: boolean;
};

export type SubscriberReason =
  | "creator"
  | "assignee"
  | "commenter"
  | "mentioned"
  | "manual";

export type IssueSubscriberRecord = {
  issueId: string;
  actorType: ActorType;
  actorId: string;
  reason: SubscriberReason;
  createdAt: string;
};

export type InboxItemType =
  | "issue_assigned"
  | "unassigned"
  | "assignee_changed"
  | "status_changed"
  | "priority_changed"
  | "new_comment"
  | "mentioned";

export const INBOX_ITEM_TYPES: readonly InboxItemType[] = [
  "issue_assigned",
  "unassigned",
  "assignee_changed",
  "status_changed",
  "priority_changed",
  "new_comment",
  "mentioned",
];

export type InboxSeverity = "action_required" | "attention" | "info";

export type InboxItemRecord = {
  id: string;
  recipientType: ActorType;
  recipientId: string;
  actorType: ActorType | null;
  actorId: string | null;
  type: InboxItemType;
  severity: InboxSeverity;
  issueId: string | null;
  title: string;
  body: string | null;
  read: boolean;
  archived: boolean;
  details: Record<string, string> | null;
  createdAt: string;
  /** Joined from issues when listing. */
  issueStatus?: IssueStatus | null;
};

/**
 * Local identity the store assumes when a caller omits an author/recipient.
 * One member per client install; no user management in M1.
 */
export const LOCAL_MEMBER_ID = "local-member";

export function issueKeyFromSeq(displaySeq: number): string {
  return `ISSUE-${displaySeq}`;
}

export function isIssueStatus(value: string): value is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(value);
}

export function isIssuePriority(value: string): value is IssuePriority {
  return (ISSUE_PRIORITIES as readonly string[]).includes(value);
}

/** Terminal issues never enqueue mentions (mirrors AllInAI task-status). */
export function isTerminalIssueStatus(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}
