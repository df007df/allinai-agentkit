"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ClientEvent } from "../protocol/index.js";
import {
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

/** Console snapshot frame payload: buffer + host warning. */
export type ConsoleSnapshotFrame = {
  clients: Array<{
    clientId: string;
    lastSeen: number;
    projects?: string[];
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
  serverTime: number;
  warning: string | null;
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
  dismissApproval(requestId: string): void;
  respondApproval(
    approval: ToolApprovalView,
    decision: "allow" | "deny",
  ): Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshotFrame | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [approvals, setApprovals] = useState<ToolApprovalView[]>([]);
  // Approvals answered locally while the snapshot still lists them: the next
  // snapshot reconciliation must not resurrect a card the operator dismissed.
  const dismissedRef = useRef<Set<string>>(new Set());

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

  return { snapshot, status, approvals, dismissApproval, respondApproval };
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
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
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

export function ExecutionList(props: {
  executions: ExecutionView[];
  onSelect(id: string): void;
}): ReactElement {
  return (
    <ul className="console-exec-list">
      {props.executions.length === 0 ? (
        <li className="console-empty">暂无执行记录。</li>
      ) : (
        props.executions.map((view) => (
          <li key={view.executionId}>
            <button
              type="button"
              className="console-exec-row"
              onClick={() => props.onSelect(view.executionId)}
            >
              <span className="console-exec-id">{view.executionId}</span>
              <span className={stateBadgeClass(view.state)}>{view.state}</span>
              <span className="console-exec-time">
                {formatTime(view.lastOccurredAt)}
              </span>
              <span className="console-exec-count">{view.eventCount} 事件</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

export function ExecutionDetail(props: {
  events: ClientEvent[];
}): ReactElement {
  return (
    <ol className="console-timeline">
      {props.events.map((event) => (
        <li key={`${event.executionId}:${event.eventSeq}`}>
          <span className="console-timeline-time">
            {formatTime(event.occurredAt)}
          </span>
          <span className={stateBadgeClass(event.type)}>{event.type}</span>
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
  const { snapshot, status, approvals, respondApproval } = useAgentEvents();
  const [selectedExecutionId, setSelectedExecutionId] = useState<
    string | null
  >(null);

  const events = snapshot?.events ?? [];
  const executions = deriveExecutions(events);
  const selected =
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
      <RunForm clients={snapshot?.clients ?? []} />
      {selected === null ? (
        <ExecutionList
          executions={executions}
          onSelect={setSelectedExecutionId}
        />
      ) : (
        <div className="console-detail">
          <button
            type="button"
            className="console-btn console-btn-ghost"
            onClick={() => setSelectedExecutionId(null)}
          >
            ← 返回列表
          </button>
          <h3 className="console-detail-title">{selectedExecutionId}</h3>
          <ExecutionDetail events={selected} />
        </div>
      )}
      <p className="console-clients">
        已接入 client：{snapshot?.clients.length ?? 0}
      </p>
    </section>
  );
}

type AuthorizeParams = {
  clientId: string;
  state: string;
  redirectUri: string;
};

function readAuthorizeParams(): AuthorizeParams {
  const params = new URLSearchParams(window.location.search);
  return {
    clientId: params.get("client_id") ?? "",
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
          ? `应用 ${params.clientId} 请求接入本机 Agent。`
          : "缺少授权参数（client_id / state / redirect_uri）。"}
      </p>
      <div className="console-login-client">
        <code>{params.clientId || "—"}</code>
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
