"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  CONSOLE_ISSUE_INBOX_PATH,
  CONSOLE_ISSUES_PATH,
} from "../routes.js";
import { formatMentionLink } from "./mention.js";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueStatus,
} from "./types.js";

/** Override points for hosts that want localized or custom copy. */
export type IssuePanelStrings = {
  title?: string;
  newIssueTitle?: string;
  newIssueBody?: string;
  commentPlaceholder?: string;
  empty?: string;
  inboxEmpty?: string;
};

/** Console client registry entry — the agent directory for mentions. */
export type IssuePanelClient = {
  clientId: string;
  name?: string;
};

type IssueSummaryView = {
  id: string;
  issueKey: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  openCommentCount: number;
  assigneeActorType: string | null;
  assigneeActorId: string | null;
};

type ActorView = { type: "member" | "agent"; id: string; label: string };

type CommentView = {
  id: string;
  authorActorType: string;
  authorActorId: string;
  body: string;
  createdAt: string;
  parentId: string | null;
};

type ExecutionView = {
  executionId: string;
  agentActorId: string;
  status: string;
  coalescedCommentIds: string[];
};

type IssueDetailView = {
  issue: IssueSummaryView & { body: string; updatedAt: string };
  comments: CommentView[];
  executions?: ExecutionView[];
  subscribers?: Array<{ actorType: string; actorId: string; reason: string }>;
};

type InboxItemView = {
  id: string;
  type: string;
  severity: string;
  actorType: string | null;
  actorId: string | null;
  title: string;
  body: string | null;
  read: boolean;
  archived: boolean;
  createdAt: string;
  issueId: string | null;
};

const DEFAULT_STRINGS: Required<IssuePanelStrings> = {
  title: "Issues",
  newIssueTitle: "新建 issue",
  newIssueBody: "补充描述（可选）",
  commentPlaceholder: "写下评论，@agent 名字可触发执行…",
  empty: "还没有 issue",
  inboxEmpty: "收件箱为空",
};

/** Status filter chips: the states that matter at a glance. */
const STATUS_FILTERS: Array<IssueStatus | "all"> = [
  "all",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

const PRIORITY_WEIGHT: Record<IssuePriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The mention directory: every connected client is an agent (keyed by
 * clientId, shown by name), plus the local member. There is no user system —
 * "@用户" resolves to the local member until one exists.
 */
function mentionDirectory(clients: ReadonlyArray<IssuePanelClient>): ActorView[] {
  return [
    ...clients.map((client) => ({
      type: "agent" as const,
      id: client.clientId,
      label: client.name || client.clientId,
    })),
    { type: "member" as const, id: "local-member", label: "me（本机）" },
  ];
}

function actorLabel(actor: ActorView): string {
  return `${actor.type}:${actor.id}`;
}

/** Render a comment body with mention links as highlight chips. */
function renderBody(body: string, dir: ReadonlyArray<ActorView>): ReactElement[] {
  const parts: ReactElement[] = [];
  const re = /\[([^\]]+)\]\(mention:\/\/(agent|member)\/([^)\s]+)\)/g;
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > cursor) {
      parts.push(<span key={key++}>{body.slice(cursor, match.index)}</span>);
    }
    const label = match[1]!;
    const type = match[2] as "agent" | "member";
    const id = match[3]!;
    const known = dir.find((actor) => actor.type === type && actor.id === id);
    parts.push(
      <span key={key++} className="console-mention" data-actor-type={type}>
        @{known ? known.label : label}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    parts.push(<span key={key++}>{body.slice(cursor)}</span>);
  }
  return parts;
}

type MentionBoxProps = {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  rows?: number;
  dir: ReadonlyArray<ActorView>;
  onSubmit?(): void;
  ariaLabel?: string;
};

/**
 * Textarea with @-autocomplete: typing `@` + a prefix opens a candidate list
 * (agents first, then the local member); picking one inserts the canonical
 * mention link. Enter confirms the highlighted candidate, otherwise submits.
 */
function MentionBox(props: MentionBoxProps): ReactElement {
  const { value, onChange, placeholder, rows, dir, onSubmit, ariaLabel } = props;
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const candidates =
    query === null
      ? []
      : dir.filter((actor) =>
          actor.label.toLowerCase().includes(query.toLowerCase()),
        );

  function detect(next: string): void {
    const match = /(?:^|[\s\n])@([^@\s]{0,24})$/.exec(next);
    setQuery(match ? match[1]! : null);
    setHighlight(0);
  }

  function insert(actor: ActorView): void {
    if (!ref.current) return;
    const caret = ref.current.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const at = before.lastIndexOf("@");
    if (at === -1) return;
    const link = formatMentionLink(actor.type, actor.id, actor.label);
    const next = `${before.slice(0, at)}${link} ${after}`;
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = at + link.length + 1;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="console-mention-box">
      <textarea
        ref={ref}
        className="console-input console-mention-input"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        rows={rows ?? 2}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          detect(event.target.value);
        }}
        onBlur={() => {
          // Delay so clicking a candidate is not swallowed by the blur.
          window.setTimeout(() => setQuery(null), 150);
        }}
        onKeyDown={(event) => {
          if (query !== null && candidates.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((highlight + 1) % candidates.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight(
                (highlight - 1 + candidates.length) % candidates.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              insert(candidates[highlight]!);
              return;
            }
            if (event.key === "Escape") {
              setQuery(null);
            }
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {query !== null && candidates.length > 0 ? (
        <ul className="console-mention-menu" role="listbox">
          {candidates.map((actor, index) => (
            <li key={actorLabel(actor)} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                data-highlight={index === highlight}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(actor)}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="console-mention-kind" data-actor-type={actor.type}>
                  {actor.type === "agent" ? "agent" : "me"}
                </span>
                <span>{actor.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Issues + local inbox panel for the console page. Loopback-only by design. */
export function IssuesPanel(props: {
  clients?: ReadonlyArray<IssuePanelClient>;
  strings?: IssuePanelStrings;
}): ReactElement {
  const copy = { ...DEFAULT_STRINGS, ...props.strings };
  const dir = mentionDirectory(props.clients ?? []);
  const [issues, setIssues] = useState<IssueSummaryView[]>([]);
  const [inbox, setInbox] = useState<InboxItemView[]>([]);
  const [selected, setSelected] = useState<IssueDetailView | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newPriority, setNewPriority] = useState<IssuePriority>("P2");
  const [comment, setComment] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "all">("all");
  const [sortByPriority, setSortByPriority] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [issueList, inboxList] = await Promise.all([
        fetchJson<{ issues: IssueSummaryView[] }>(CONSOLE_ISSUES_PATH),
        fetchJson<{ items: InboxItemView[] }>(CONSOLE_ISSUE_INBOX_PATH),
      ]);
      setIssues(issueList.issues);
      setInbox(inboxList.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openIssue(ref: string): Promise<void> {
    try {
      const detail = await fetchJson<IssueDetailView>(
        `${CONSOLE_ISSUES_PATH}?ref=${encodeURIComponent(ref)}`,
      );
      setSelected(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function post(action: Record<string, unknown>): Promise<void> {
    try {
      await fetchJson(CONSOLE_ISSUES_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      await refresh();
      if (selected) await openIssue(selected.issue.issueKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const visibleIssues = issues
    .filter((issue) => statusFilter === "all" || issue.status === statusFilter)
    .sort((a, b) =>
      sortByPriority
        ? PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
          b.issueKey.localeCompare(a.issueKey)
        : 0,
    );

  const unread = inbox.filter((item) => !item.read && !item.archived);

  return (
    <section className="console-panel console-issues">
      <h3 className="console-panel-title">{copy.title}</h3>
      {error ? <p className="console-error">{error}</p> : null}
      <form
        className="console-issues-new"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newTitle.trim()) return;
          void post({
            action: "create",
            title: newTitle.trim(),
            priority: newPriority,
            ...(newBody.trim() ? { body: newBody.trim() } : {}),
          }).then(() => {
            setNewTitle("");
            setNewBody("");
            setNewPriority("P2");
          });
        }}
      >
        <div className="console-issues-new-row">
          <input
            className="console-input"
            placeholder={copy.newIssueTitle}
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <select
            className="console-input console-issues-new-priority"
            value={newPriority}
            onChange={(event) => setNewPriority(event.target.value as IssuePriority)}
            aria-label="优先级"
          >
            {ISSUE_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
          <button type="submit" className="console-btn console-btn-primary">
            创建
          </button>
        </div>
        <textarea
          className="console-input console-issues-new-body"
          placeholder={copy.newIssueBody}
          rows={2}
          value={newBody}
          onChange={(event) => setNewBody(event.target.value)}
        />
      </form>

      <div className="console-issues-toolbar">
        <div className="console-chip-row" role="tablist" aria-label="状态过滤">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              type="button"
              className="console-chip"
              data-active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {status === "all" ? "全部" : status}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="console-chip"
          data-active={sortByPriority}
          onClick={() => setSortByPriority((value) => !value)}
        >
          按优先级
        </button>
      </div>

      <div className="console-issues-grid">
        <div className="console-issues-list">
          {visibleIssues.length === 0 ? (
            <p className="console-subtext">{copy.empty}</p>
          ) : null}
          {visibleIssues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className="console-issue-row"
              data-status={issue.status}
              onClick={() => void openIssue(issue.issueKey)}
            >
              <code className="console-issue-key">{issue.issueKey}</code>
              <span className="console-issue-title">{issue.title}</span>
              <span className="console-issue-meta">
                {issue.priority} ·{" "}
                <span className="console-issue-status" data-status={issue.status}>
                  {issue.status}
                </span>{" "}
                · 评论 {issue.openCommentCount}
              </span>
            </button>
          ))}
        </div>
        <div className="console-issue-detail">
          {selected ? (
            <>
              <div className="console-issue-head">
                <strong>{selected.issue.title}</strong>
                <div className="console-issue-head-controls">
                  <select
                    value={selected.issue.priority}
                    aria-label="优先级"
                    onChange={(event) =>
                      void post({
                        action: "update",
                        ref: selected.issue.issueKey,
                        priority: event.target.value,
                      })
                    }
                  >
                    {ISSUE_PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                  <select
                    value={selected.issue.status}
                    aria-label="状态"
                    onChange={(event) =>
                      void post({
                        action: "update",
                        ref: selected.issue.issueKey,
                        status: event.target.value,
                      })
                    }
                  >
                    {ISSUE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <select
                    value={
                      selected.issue.assigneeActorId
                        ? `${selected.issue.assigneeActorType}:${selected.issue.assigneeActorId}`
                        : ""
                    }
                    aria-label="指派"
                    onChange={(event) => {
                      const value = event.target.value;
                      const actor = dir.find(
                        (candidate) => actorLabel(candidate) === value,
                      );
                      void post({
                        action: "update",
                        ref: selected.issue.issueKey,
                        assignee: actor ?? null,
                      });
                    }}
                  >
                    <option value="">未指派</option>
                    {dir.map((actor) => (
                      <option key={actorLabel(actor)} value={actorLabel(actor)}>
                        @{actor.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {selected.issue.body ? (
                <p className="console-issue-body">{selected.issue.body}</p>
              ) : null}
              {(selected.executions ?? []).length > 0 ? (
                <ul className="console-issue-executions">
                  {(selected.executions ?? []).map((execution) => (
                    <li key={execution.executionId}>
                      <code>{execution.executionId.slice(0, 8)}</code>
                      <span>
                        {execution.agentActorId} · {execution.status}
                        {execution.coalescedCommentIds.length > 0
                          ? ` · 待续 ${execution.coalescedCommentIds.length} 条`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="console-issue-comments">
                {selected.comments
                  .filter((item) => !item.parentId)
                  .map((top) => {
                    const replies = selected.comments.filter(
                      (item) => item.parentId === top.id,
                    );
                    return (
                      <li key={top.id} className="console-issue-comment">
                        <div className="console-issue-comment-main">
                          <span className="console-issue-comment-author">
                            {top.authorActorType}:{top.authorActorId}
                          </span>
                          <span>{renderBody(top.body, dir)}</span>
                        </div>
                        {replies.length > 0 ? (
                          <ul className="console-issue-replies">
                            {replies.map((reply) => (
                              <li key={reply.id}>
                                <span className="console-issue-comment-author">
                                  {reply.authorActorType}:{reply.authorActorId}
                                </span>
                                <span>{renderBody(reply.body, dir)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {replyTo === top.id ? (
                          <form
                            className="console-issue-reply-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (!replyText.trim()) return;
                              void post({
                                action: "comment",
                                ref: selected.issue.issueKey,
                                body: replyText.trim(),
                                parentId: top.id,
                              }).then(() => {
                                setReplyTo(null);
                                setReplyText("");
                              });
                            }}
                          >
                            <MentionBox
                              value={replyText}
                              onChange={setReplyText}
                              placeholder={`回复 ${top.authorActorId}…`}
                              rows={1}
                              dir={dir}
                              ariaLabel="回复内容"
                            />
                            <button
                              type="submit"
                              className="console-btn console-btn-ghost"
                            >
                              回复
                            </button>
                            <button
                              type="button"
                              className="console-btn console-btn-ghost"
                              onClick={() => {
                                setReplyTo(null);
                                setReplyText("");
                              }}
                            >
                              取消
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="console-issue-reply-toggle"
                            onClick={() => {
                              setReplyTo(top.id);
                              setReplyText("");
                            }}
                          >
                            回复
                          </button>
                        )}
                      </li>
                    );
                  })}
              </ul>
              <form
                className="console-issues-new"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!comment.trim()) return;
                  void post({
                    action: "comment",
                    ref: selected.issue.issueKey,
                    body: comment.trim(),
                  }).then(() => setComment(""));
                }}
              >
                <MentionBox
                  value={comment}
                  onChange={setComment}
                  placeholder={copy.commentPlaceholder}
                  dir={dir}
                  onSubmit={() => {
                    if (!comment.trim()) return;
                    void post({
                      action: "comment",
                      ref: selected.issue.issueKey,
                      body: comment.trim(),
                    }).then(() => setComment(""));
                  }}
                />
                <button type="submit" className="console-btn console-btn-ghost">
                  评论
                </button>
              </form>
              {(selected.subscribers ?? []).length > 0 ? (
                <p className="console-issue-subscribers">
                  订阅：
                  {(selected.subscribers ?? [])
                    .map((subscriber) => {
                      const actor = dir.find(
                        (candidate) =>
                          candidate.type === subscriber.actorType &&
                          candidate.id === subscriber.actorId,
                      );
                      return `@${actor ? actor.label : subscriber.actorId}(${subscriber.reason})`;
                    })
                    .join("、")}
                </p>
              ) : null}
            </>
          ) : (
            <p className="console-subtext">选择一个 issue 查看详情</p>
          )}
        </div>
      </div>
      <div className="console-inbox">
        <div className="console-inbox-head">
          <h4 className="console-panel-title">收件箱</h4>
          {unread.length > 0 ? (
            <button
              type="button"
              className="console-chip"
              onClick={() => {
                void Promise.all(
                  unread.map((item) =>
                    post({ action: "inbox.read", itemId: item.id }),
                  ),
                );
              }}
            >
              全部已读（{unread.length}）
            </button>
          ) : null}
        </div>
        {inbox.filter((item) => !item.archived).length === 0 ? (
          <p className="console-subtext">{copy.inboxEmpty}</p>
        ) : null}
        <ul className="console-inbox-list">
          {inbox
            .filter((item) => !item.archived)
            .map((item) => (
              <li key={item.id} data-read={item.read} data-severity={item.severity}>
                <span className="console-inbox-type">{item.type}</span>
                {item.actorId ? (
                  <span className="console-inbox-actor">
                    {item.actorType}:{item.actorId}
                  </span>
                ) : null}
                <span>{item.title}</span>
                {item.body ? (
                  <span className="console-inbox-body">{item.body}</span>
                ) : null}
                {!item.read ? (
                  <button
                    type="button"
                    className="console-btn console-btn-ghost"
                    onClick={() => void post({ action: "inbox.read", itemId: item.id })}
                  >
                    已读
                  </button>
                ) : null}
                <button
                  type="button"
                  className="console-btn console-btn-ghost console-inbox-archive"
                  onClick={() => void post({ action: "inbox.archive", itemId: item.id })}
                >
                  归档
                </button>
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}
