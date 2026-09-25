"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ClientEvent } from "../protocol/index.js";
import {
  CONSOLE_POLICY_APPROVAL_PATH,
  CONSOLE_PLUGIN_ACTION_PATH,
  CONSOLE_PLUGINS_PATH,
  CONSOLE_RUNS_PATH,
  CONSOLE_TOOL_APPROVAL_PATH,
  LOGIN_APPROVE_PATH,
  LOGIN_DENY_PATH,
} from "../routes.js";
import {
  connectAgentEvents,
  type AgentEventStream,
} from "./events.js";
import { deriveExecutions, eventsForExecution, type ExecutionView } from "./executions.js";
import { CONSOLE_EVENT_BUFFER_LIMIT, type ConsoleSnapshot } from "../console/state.js";

const EMPTY_SNAPSHOT: ConsoleSnapshotFrame = {
  clients: [],
  events: [],
  observations: [],
  serverTime: 0,
  warning: null,
};

/** Console snapshot frame payload: buffer + host warning. */
export type ConsoleSnapshotFrame = {
  clients: Array<{
    clientId: string;
    name?: string;
    lastSeen: number;
    projects?: string[];
    plugins?: Array<{
      id: string;
      status: string;
      resolvedCommit: string;
      localHead?: string;
      diverged?: boolean;
      aheadCount?: number;
      lastError?: string;
      delivery?: Array<{
        platform: string;
        state: "installed" | "removed" | "skipped" | "failed";
        detail?: string;
      }>;
    }>;
  }>;
  events: ClientEvent[];
  observations: unknown[];
  pendingApprovals?: Array<{
    clientId: string;
    executionId: string;
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }>;
  pendingExecutionApprovals?: Array<{
    clientId: string;
    executionId: string;
    runtime: string;
    prompt: string;
  }>;
  serverTime: number;
  warning: string | null;
};

const CONTENT_BADGE_LABELS: Record<string, string> = {
  init: "init",
  text_delta: "text",
  thinking_delta: "thinking",
  tool: "tool",
  vendor: "vendor",
};

/** Badge label for a timeline event: "progress·tool" reads at a glance. */
function eventBadgeLabel(event: ClientEvent): string {
  const base = event.type;
  if (event.type !== "progress" || !event.eventType) return base;
  const content = CONTENT_BADGE_LABELS[event.eventType] ?? event.eventType;
  return `${base}·${content}`;
}

/** A locally policy-gated execution awaiting a human allow/deny decision. */
export type ExecutionApprovalView = {
  clientId: string;
  executionId: string;
  runtime: string;
  prompt: string;
};

/** Live observation frame for execution_approval.requested. */
export type ExecutionApprovalObservationFrame = {
  kind: "execution_approval.requested";
  clientId: string;
  approval: {
    executionId: string;
    runtime: string;
    prompt: string;
  };
  at: number;
};

/** One pending tool call awaiting a human allow/deny decision. */
export type ToolApprovalView = {
  clientId: string;
  executionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

/** Live observation frame for tool_approval.requested. */
export type ToolApprovalObservationFrame = {
  kind: "tool_approval.requested";
  clientId: string;
  approval: {
    executionId: string;
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  at: number;
};

/** Connection state of the observe stream, for the status dot. */
export type StreamStatus = "connecting" | "open" | "reconnecting";

/** SSE subscription hook: keeps the latest snapshot frame and live stream status. */
export function useAgentEvents(): {
  snapshot: ConsoleSnapshotFrame | null;
  status: StreamStatus;
  approvals: ToolApprovalView[];
  executionApprovals: ExecutionApprovalView[];
  respondExecutionApproval(
    approval: ExecutionApprovalView,
    decision: "allow" | "deny",
  ): Promise<void>;
  dismissApproval(requestId: string): void;
  respondApproval(
    approval: ToolApprovalView,
    decision: "allow" | "deny",
  ): Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshotFrame | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [approvals, setApprovals] = useState<ToolApprovalView[]>([]);
  const [executionApprovals, setExecutionApprovals] = useState<
    ExecutionApprovalView[]
  >([]);
  // Approvals answered locally while the snapshot still lists them: the next
  // snapshot reconciliation must not resurrect a card the operator dismissed.
  const dismissedRef = useRef<Set<string>>(new Set());
  const dismissedExecutionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const stream: AgentEventStream = connectAgentEvents({
      onSnapshot: (raw) => {
        const frame = raw as ConsoleSnapshotFrame;
        if (frame && Array.isArray(frame.events)) {
          setSnapshot(frame);
          // Approvals are derived server-side from hub observations, so every
          // snapshot (including the post-reconnect one) rehydrates the cards a
          // backgrounded mobile client dropped. Snapshot items come first,
          // locally observed live additions stay after, deduped by requestId;
          // locally answered cards are never resurrected.
          setApprovals((live) => {
            const byRequestId = new Map<string, ToolApprovalView>();
            for (const approval of frame.pendingApprovals ?? []) {
              if (dismissedRef.current.has(approval.requestId)) continue;
              byRequestId.set(approval.requestId, approval);
            }
            for (const approval of live) {
              if (byRequestId.has(approval.requestId)) continue;
              byRequestId.set(approval.requestId, approval);
            }
            return [...byRequestId.values()];
          });
          setExecutionApprovals((live) => {
            const byExecutionId = new Map<string, ExecutionApprovalView>();
            for (const approval of frame.pendingExecutionApprovals ?? []) {
              if (dismissedExecutionsRef.current.has(approval.executionId))
                continue;
              byExecutionId.set(approval.executionId, approval);
            }
            for (const approval of live) {
              if (byExecutionId.has(approval.executionId)) continue;
              byExecutionId.set(approval.executionId, approval);
            }
            return [...byExecutionId.values()];
          });
        }
      },
      onObservation: (raw) => {
        const observation = raw as ToolApprovalObservationFrame;
        if (
          observation &&
          observation.kind === "tool_approval.requested" &&
          observation.approval
        ) {
          const approval = observation.approval;
          setApprovals((pending) =>
            pending.some((p) => p.requestId === approval.requestId)
              ? pending
              : [
                  ...pending,
                  {
                    clientId: observation.clientId,
                    executionId: approval.executionId,
                    requestId: approval.requestId,
                    toolName: approval.toolName,
                    toolInput: approval.toolInput,
                  },
                ],
          );
        }
        const execObservation = raw as ExecutionApprovalObservationFrame;
        if (
          execObservation &&
          execObservation.kind === "execution_approval.requested" &&
          execObservation.approval
        ) {
          const approval = execObservation.approval;
          setExecutionApprovals((pending) =>
            pending.some((p) => p.executionId === approval.executionId)
              ? pending
              : [
                  ...pending,
                  {
                    clientId: execObservation.clientId,
                    executionId: approval.executionId,
                    runtime: approval.runtime,
                    prompt: approval.prompt,
                  },
                ],
          );
        }
        // events.ingested carries the full ClientEvent[] for the batch: merge
        // it straight into the local timeline (dedup + 500-cap, mirroring
        // ConsoleState) instead of refetching the whole snapshot.
        const anyObservation = raw as {
          kind?: string;
          events?: ClientEvent[];
        };
        if (anyObservation.kind === "events.ingested" && Array.isArray(anyObservation.events)) {
          const incoming = anyObservation.events;
          setSnapshot((prev) => {
            const base = prev ?? EMPTY_SNAPSHOT;
            const byKey = new Map<string, ClientEvent>();
            for (const event of base.events) {
              byKey.set(`${event.executionId}:${event.eventSeq}`, event);
            }
            for (const event of incoming) {
              byKey.set(`${event.executionId}:${event.eventSeq}`, event);
            }
            const events = [...byKey.values()]
              .sort(
                (a, b) =>
                  a.occurredAt.localeCompare(b.occurredAt) ||
                  a.eventSeq - b.eventSeq,
              )
              .slice(-CONSOLE_EVENT_BUFFER_LIMIT);
            return { ...base, events };
          });
        }
      },
      onStatus: setStatus,
    });
    return () => stream.close();
  }, []);

  const dismissApproval = (requestId: string): void => {
    dismissedRef.current.add(requestId);
    setApprovals((pending) =>
      pending.filter((p) => p.requestId !== requestId),
    );
  };

  const respondApproval = async (
    approval: ToolApprovalView,
    decision: "allow" | "deny",
  ): Promise<void> => {
    try {
      await fetch(CONSOLE_TOOL_APPROVAL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: approval.clientId,
          executionId: approval.executionId,
          requestId: approval.requestId,
          decision,
        }),
      });
    } finally {
      dismissApproval(approval.requestId);
    }
  };

  const respondExecutionApproval = async (
    approval: ExecutionApprovalView,
    decision: "allow" | "deny",
  ): Promise<void> => {
    try {
      await fetch(CONSOLE_POLICY_APPROVAL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: approval.clientId,
          executionId: approval.executionId,
          decision,
        }),
      });
    } finally {
      dismissedExecutionsRef.current.add(approval.executionId);
      setExecutionApprovals((pending) =>
        pending.filter((p) => p.executionId !== approval.executionId),
      );
    }
  };

  return {
    snapshot,
    status,
    approvals,
    executionApprovals,
    respondExecutionApproval,
    dismissApproval,
    respondApproval,
  };
}

function statusLabel(status: StreamStatus): string {
  switch (status) {
    case "open":
      return "观测流已连接";
    case "reconnecting":
      return "观测流已断开，自动重连中";
    default:
      return "观测流连接中…";
  }
}

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(
    parsed.getSeconds(),
  )}`;
}

const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "rejected"]);

function stateBadgeClass(state: ClientEvent["type"]): string {
  const base = "console-badge";
  if (state === "done") return `${base} console-badge-ok`;
  if (state === "failed" || state === "rejected" || state === "recovery_required")
    return `${base} console-badge-bad`;
  if (TERMINAL_STATES.has(state)) return base;
  return `${base} console-badge-active`;
}

/** Accordion row: one execution, expanding inline into its event timeline. */
export function ExecutionList(props: {
  executions: ExecutionView[];
  eventsFor(executionId: string): ClientEvent[];
  selectedId: string | null;
  onSelect(id: string | null): void;
}): ReactElement {
  if (props.executions.length === 0) {
    return (
      <ul className="console-exec-list">
        <li className="console-empty">暂无执行记录。</li>
      </ul>
    );
  }
  return (
    <ul className="console-exec-list">
      {props.executions.map((view) => {
        const open = props.selectedId === view.executionId;
        const promptText = promptOf(props.eventsFor(view.executionId));
        return (
          <li
            key={view.executionId}
            className="console-exec-item"
            data-open={open ? "true" : "false"}
          >
            <button
              type="button"
              className="console-exec-row"
              aria-expanded={open}
              onClick={() => props.onSelect(open ? null : view.executionId)}
            >
              <span className="console-exec-caret" aria-hidden="true">
                {open ? "▾" : "▸"}
              </span>
              <span className="console-exec-main">
                <span className="console-exec-id">{view.executionId}</span>
                {promptText ? (
                  <span className="console-exec-prompt">{promptText}</span>
                ) : null}
              </span>
              <span className={stateBadgeClass(view.state)}>{view.state}</span>
              <span className="console-exec-time">
                {formatTime(view.lastOccurredAt)}
              </span>
              <span className="console-exec-count">{view.eventCount} 事件</span>
            </button>
            {open ? (
              <div className="console-exec-body">
                <ExecutionDetail events={props.eventsFor(view.executionId)} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The user prompt carried on the received event, trimmed for row display. */
function promptOf(events: ClientEvent[]): string | null {
  for (const event of events) {
    const value = event.payload?.prompt;
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
  return null;
}

/** The runtime-reported session id (e.g. codex thread id) from the init event,
 * when the run has one. Lets an operator resume the vendor thread in the
 * vendor's own TUI. */
function runtimeSessionIdOf(events: ClientEvent[]): string | null {
  for (const event of events) {
    const value = event.payload?.runtimeSessionId;
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function SessionIdRow(props: { sessionId: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="console-session-row">
      <span className="console-session-label">runtime session</span>
      <code className="console-session-id">{props.sessionId}</code>
      <button
        type="button"
        className="console-btn console-btn-ghost console-btn-copy"
        onClick={() => {
          void navigator.clipboard
            .writeText(props.sessionId)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

export function ExecutionDetail(props: {
  events: ClientEvent[];
}): ReactElement {
  const sessionId = runtimeSessionIdOf(props.events);
  return (
    <div className="console-exec-detail">
      {sessionId ? <SessionIdRow sessionId={sessionId} /> : null}
      <ol className="console-timeline">
        {props.events.map((event) => (
          <li key={`${event.executionId}:${event.eventSeq}`}>
            <span className="console-timeline-time">
              {formatTime(event.occurredAt)}
            </span>
            <span className={stateBadgeClass(event.type)}>
              {eventBadgeLabel(event)}
            </span>
            <span className="console-timeline-seq">#{event.eventSeq}</span>
            {event.payload !== undefined ? (
              <details className="console-payload">
                <summary>payload</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Pending policy-gated execution cards: allow resumes the run in place. */
export function ExecutionApprovalList(props: {
  approvals: ExecutionApprovalView[];
  onRespond(
    approval: ExecutionApprovalView,
    decision: "allow" | "deny",
  ): Promise<void>;
}): ReactElement {
  if (props.approvals.length === 0) return <></>;
  return (
    <ul className="console-approvals">
      {props.approvals.map((approval) => (
        <li
          key={approval.executionId}
          className="console-approval-card"
          data-kind="execution"
        >
          <div className="console-approval-head">
            <strong>{`执行审批 · ${approval.runtime}`}</strong>
            <span className="t">
              {` · ${approval.clientId.slice(0, 8)} · ${approval.executionId.slice(0, 8)}`}
            </span>
          </div>
          <pre className="console-approval-input">
            {approval.prompt || "（无提示词）"}
          </pre>
          <div className="console-approval-actions">
            <button
              type="button"
              className="console-btn"
              onClick={() => void props.onRespond(approval, "allow")}
            >
              允许执行
            </button>
            <button
              type="button"
              className="console-btn console-btn-ghost"
              onClick={() => void props.onRespond(approval, "deny")}
            >
              拒绝
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Pending tool-approval cards: allow/deny posts straight to the daemon. */
export function ApprovalList(props: {
  approvals: ToolApprovalView[];
  onRespond(
    approval: ToolApprovalView,
    decision: "allow" | "deny",
  ): Promise<void>;
}): ReactElement {
  if (props.approvals.length === 0) return <></>;
  return (
    <ul className="console-approvals">
      {props.approvals.map((approval) => (
        <li key={approval.requestId} className="console-approval-card">
          <div className="console-approval-head">
            <strong>{approval.toolName}</strong>
            <span className="t">
              {` · ${approval.clientId} · ${approval.executionId.slice(0, 8)}`}
            </span>
          </div>
          <pre className="console-approval-input">
            {JSON.stringify(approval.toolInput, null, 2)}
          </pre>
          <div className="console-approval-actions">
            <button
              type="button"
              className="console-btn"
              onClick={() => void props.onRespond(approval, "allow")}
            >
              允许
            </button>
            <button
              type="button"
              className="console-btn console-btn-ghost"
              onClick={() => void props.onRespond(approval, "deny")}
            >
              拒绝
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const RUNTIME_OPTIONS = ["codex", "claude", "pi"] as const;

const DELIVERY_STATE_LABEL: Record<string, string> = {
  installed: "已分发",
  removed: "已卸载",
  skipped: "跳过",
  failed: "失败",
};

/**
 * Plugin & skill panel: per-client install state from the latest inventory
 * (status, per-platform delivery badges, divergence banner with force/keep)
 * plus a desired-catalog editor — add/update/remove entries and push them to
 * the client via /_agentkit/console/plugins. A skill is just a plugin whose
 * repo carries skills/: both use the same entry shape (id + gitUrl + ref).
 */
export function PluginPanel(props: {
  clients: ConsoleSnapshotFrame["clients"];
}): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [formClient, setFormClient] = useState<string | null>(null);
  const [formId, setFormId] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formRef, setFormRef] = useState("");
  const diverged = props.clients.flatMap((client) =>
    (client.plugins ?? [])
      .filter((plugin) => plugin.diverged)
      .map((plugin) => ({ client, plugin })),
  );

  async function act(
    action: "force" | "keep",
    clientId: string,
    pluginId: string,
  ): Promise<void> {
    setBusy(`${clientId}:${pluginId}`);
    setMessage(null);
    try {
      const response = await fetch(CONSOLE_PLUGIN_ACTION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, action, pluginId }),
      });
      const body = (await response.json()) as { error?: string; delivered?: boolean };
      if (!response.ok) {
        setMessage(`操作失败：${body.error ?? response.status}`);
      } else if (action === "force") {
        setMessage(
          body.delivered
            ? `已下发强制覆盖指令（${pluginId}），等待 client 应用`
            : `client 不在线，指令未送达（${pluginId}）`,
        );
      } else {
        setMessage(`已请求刷新插件状态（${pluginId}），保留本地修改`);
      }
    } catch (error) {
      setMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  /** Desired-catalog mutation; resets the editor form on success. */
  async function manage(
    action: "add" | "remove" | "push",
    clientId: string,
    plugin?: { id: string; gitUrl: string; ref?: string },
    pluginId?: string,
  ): Promise<void> {
    setBusy(`${clientId}:${pluginId ?? action}`);
    setMessage(null);
    try {
      const response = await fetch(CONSOLE_PLUGINS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "add"
            ? { clientId, action, plugin }
            : { clientId, action, pluginId },
        ),
      });
      const body = (await response.json()) as { error?: string; delivered?: boolean };
      if (!response.ok) {
        setMessage(`操作失败：${body.error ?? response.status}`);
        return;
      }
      const verb =
        action === "add"
          ? `已下发插件/skill「${plugin?.id}」`
          : action === "remove"
            ? `已下发移除「${pluginId}」`
            : "已重新下发期望清单";
      setMessage(
        body.delivered ? `${verb}，等待 client 应用` : `${verb}（client 不在线，重连时需重推）`,
      );
      if (action === "add") {
        setFormId("");
        setFormUrl("");
        setFormRef("");
        setFormClient(null);
      }
    } catch (error) {
      setMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  const noClients = props.clients.length === 0;
  if (noClients && diverged.length === 0) {
    return <></>;
  }
  return (
    <section className="console-panel">
      <h3 className="console-panel-title">插件 & Skills</h3>
      {message ? <p className="console-warning">{message}</p> : null}
      {props.clients.map((client) => (
        <div key={client.clientId} className="console-plugin-client">
          <strong>
            {client.name || client.clientId.slice(0, 8)}
            <button
              type="button"
              className="console-plugin-add-toggle"
              disabled={busy !== null}
              onClick={() =>
                setFormClient(formClient === client.clientId ? null : client.clientId)
              }
            >
              {formClient === client.clientId ? "收起" : "添加插件/Skill"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => manage("push", client.clientId)}
            >
              重新下发
            </button>
          </strong>
          {formClient === client.clientId ? (
            <form
              className="console-plugin-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!formId.trim() || !formUrl.trim()) return;
                void manage("add", client.clientId, {
                  id: formId.trim(),
                  gitUrl: formUrl.trim(),
                  ...(formRef.trim() ? { ref: formRef.trim() } : {}),
                });
              }}
            >
              <input
                placeholder="id（小写 slug，如 my-skills）"
                value={formId}
                onChange={(event) => setFormId(event.target.value)}
                required
              />
              <input
                placeholder="Git 仓库地址（https/ssh）"
                value={formUrl}
                onChange={(event) => setFormUrl(event.target.value)}
                required
              />
              <input
                placeholder="分支/引用（可选）"
                value={formRef}
                onChange={(event) => setFormRef(event.target.value)}
              />
              <button type="submit" disabled={busy !== null}>
                下发到该 client
              </button>
            </form>
          ) : null}
          {(client.plugins ?? []).length === 0 ? (
            <p className="console-plugin-empty">尚未安装任何插件/skill</p>
          ) : null}
          {(client.plugins ?? []).map((plugin) => (
            <div
              key={plugin.id}
              className="console-plugin-row"
              data-diverged={plugin.diverged ? "true" : "false"}
            >
              <span>
                {plugin.id} @ {plugin.resolvedCommit.slice(0, 8)}
                <em data-status={plugin.status}>
                  {" "}
                  {plugin.status === "active"
                    ? "运行中"
                    : plugin.status === "failed"
                      ? `失败${plugin.lastError ? `：${plugin.lastError}` : ""}`
                      : "已停用"}
                </em>
                {plugin.diverged ? (
                  <em>
                    {" "}
                    本地已分叉（领先 {plugin.aheadCount ?? 0} 个提交，
                    local {plugin.localHead?.slice(0, 8) ?? "?"}）
                  </em>
                ) : null}
                {(plugin.delivery ?? []).length > 0 ? (
                  <span className="console-plugin-delivery">
                    {(plugin.delivery ?? []).map((entry) => (
                      <em
                        key={entry.platform}
                        data-state={entry.state}
                        title={entry.detail ?? entry.state}
                      >
                        {" "}
                        {entry.platform}:{DELIVERY_STATE_LABEL[entry.state] ?? entry.state}
                      </em>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="console-plugin-actions">
                {plugin.diverged ? (
                  <>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act("force", client.clientId, plugin.id)}
                    >
                      强制覆盖
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act("keep", client.clientId, plugin.id)}
                    >
                      保留本地
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => manage("remove", client.clientId, undefined, plugin.id)}
                >
                  移除
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
      {diverged.length > 0 ? (
        <p className="console-warning">
          {diverged.length} 个插件处于分叉状态：更新已暂停，需人工裁决。
        </p>
      ) : null}
    </section>
  );
}

/**
 * Trigger an agent run on one connected client. Projects come from the
 * client's latest inventory report; "默认" sends no project field so the run
 * uses the client's managed default workspace.
 */
export function RunForm(props: {
  clients: Array<{ clientId: string; projects?: string[] }>;
}): ReactElement {
  const online = props.clients.filter(
    (client) => client.clientId.length > 0,
  );
  const [clientId, setClientId] = useState("");
  const [runtime, setRuntime] = useState<string>("codex");
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selected = online.find((client) => client.clientId === clientId);
  const projects = selected?.projects ?? [];

  async function submit(): Promise<void> {
    if (!clientId || !prompt.trim()) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const response = await fetch(CONSOLE_RUNS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          prompt,
          runtime,
          ...(project ? { project } : {}),
        }),
      });
      const body = (await response.json()) as {
        delivered?: boolean;
        error?: string;
        message?: string;
        executionId?: string;
      };
      if (!response.ok) {
        setStatus(`失败：${body.error ?? response.status}${body.message ? ` ${body.message}` : ""}`);
      } else if (body.delivered) {
        setStatus(
          body.executionId
            ? `已下发（execution ${body.executionId.slice(0, 8)}），等待 client 本地策略确认`
            : "已入队，等待 client 上线接收",
        );
        setPrompt("");
      } else {
        setStatus("已入队，等待 client 上线接收");
      }
    } catch (cause) {
      setStatus(`失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (online.length === 0) {
    return <p className="console-empty">暂无已接入 client，无法发起执行。</p>;
  }
  return (
    <form
      className="console-run-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="console-run-row">
        <label>
          Client
          <select
            value={clientId}
            onChange={(event) => {
              setClientId(event.target.value);
              setProject("");
            }}
          >
            <option value="">选择 client…</option>
            {online.map((client) => (
              <option key={client.clientId} value={client.clientId}>
                {client.clientId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runtime
          <select
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
          >
            {RUNTIME_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            disabled={!clientId}
          >
            <option value="">默认（client 托管目录）</option>
            {projects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="console-run-prompt">
        提示词
        <textarea
          value={prompt}
          rows={3}
          placeholder="要执行的任务描述…"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className="console-run-actions">
        <button
          type="submit"
          className="console-btn console-btn-primary"
          disabled={submitting || !clientId || !prompt.trim()}
        >
          {submitting ? "下发中…" : "发起执行"}
        </button>
        {status ? <span className="console-run-status">{status}</span> : null}
      </div>
    </form>
  );
}

export function ConsoleApp(): ReactElement {
  const {
    snapshot,
    status,
    approvals,
    executionApprovals,
    respondExecutionApproval,
    respondApproval,
  } = useAgentEvents();
  const [selectedExecutionId, setSelectedExecutionId] = useState<
    string | null
  >(null);

  const events = snapshot?.events ?? [];
  const executions = deriveExecutions(events);
  const selectedEvents =
    selectedExecutionId !== null
      ? eventsForExecution(events, selectedExecutionId)
      : null;

  return (
    <section className="console-app">
      <div className="console-head">
        <h2>Agent 控制台</h2>
        <span className="console-status" data-state={status === "open" ? "online" : "offline"}>
          {statusLabel(status)}
        </span>
      </div>
      {snapshot?.warning ? (
        <p className="console-warning">{snapshot.warning}</p>
      ) : null}
      <ApprovalList approvals={approvals} onRespond={respondApproval} />
      <ExecutionApprovalList
        approvals={executionApprovals}
        onRespond={respondExecutionApproval}
      />
      <PluginPanel clients={snapshot?.clients ?? []} />
      <div className="console-grid">
        <section className="console-panel">
          <h3 className="console-panel-title">发起执行</h3>
          <RunForm clients={snapshot?.clients ?? []} />
        </section>
        <section className="console-panel console-panel-history">
          <h3 className="console-panel-title">历史会话</h3>
          <ExecutionList
            executions={executions}
            eventsFor={(id) => eventsForExecution(events, id)}
            selectedId={selectedEvents !== null ? selectedExecutionId : null}
            onSelect={setSelectedExecutionId}
          />
        </section>
      </div>
      <p className="console-clients">
        已接入 client：{snapshot?.clients.length ?? 0}
        {snapshot?.clients.length
          ? `（${snapshot.clients
              .map((c) => c.name || c.clientId.slice(0, 8))
              .join("、")}）`
          : ""}
      </p>
    </section>
  );
}

type AuthorizeParams = {
  clientId: string;
  /** Human-readable client name from the login flow; shown in place of the id. */
  name: string;
  state: string;
  redirectUri: string;
};

function readAuthorizeParams(): AuthorizeParams {
  const params = new URLSearchParams(window.location.search);
  return {
    clientId: params.get("client_id") ?? "",
    name: params.get("name") ?? "",
    state: params.get("state") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
  };
}

async function postAuthorizeDecision(
  path: string,
  params: AuthorizeParams,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: params.clientId,
      state: params.state,
      redirectUri: params.redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`authorize failed: ${response.status}`);
  const json = (await response.json()) as { redirectUrl?: string };
  if (typeof json.redirectUrl === "string" && json.redirectUrl) {
    window.location.replace(json.redirectUrl);
  }
}

export function AuthorizeCard(): ReactElement {
  const [params] = useState(readAuthorizeParams);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  async function decide(kind: "approve" | "deny"): Promise<void> {
    setPending(kind);
    setError(null);
    try {
      await postAuthorizeDecision(
        kind === "approve" ? LOGIN_APPROVE_PATH : LOGIN_DENY_PATH,
        params,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(null);
    }
  }

  return (
    <div className="console-card">
      <div className="console-brand">agentkit</div>
      <h1>登录授权</h1>
      <p className="console-subtext">
        {params.clientId
          ? `应用 ${params.name || params.clientId} 请求接入本机 Agent。`
          : "缺少授权参数（client_id / state / redirect_uri）。"}
      </p>
      <div className="console-login-client">
        <code>{params.name || params.clientId || "—"}</code>
      </div>
      {error ? <p className="console-error">{error}</p> : null}
      <div className="console-cta-row">
        <button
          type="button"
          className="console-btn console-btn-primary"
          disabled={pending !== null}
          onClick={() => void decide("approve")}
        >
          {pending === "approve" ? "授权中…" : "允许"}
        </button>
        <button
          type="button"
          className="console-btn console-btn-ghost"
          disabled={pending !== null}
          onClick={() => void decide("deny")}
        >
          {pending === "deny" ? "处理中…" : "拒绝"}
        </button>
      </div>
    </div>
  );
}
