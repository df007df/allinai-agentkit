"use client";

import { useEffect, useState, type ReactElement } from "react";
import type { ClientEvent } from "../protocol/index.js";
import { LOGIN_APPROVE_PATH, LOGIN_DENY_PATH } from "../routes.js";
import {
  connectAgentEvents,
  type AgentEventStream,
} from "./events.js";
import { deriveExecutions, eventsForExecution, type ExecutionView } from "./executions.js";

/** Console snapshot frame payload: buffer + host warning. */
export type ConsoleSnapshotFrame = {
  clients: Array<{ clientId: string; lastSeen: number }>;
  events: ClientEvent[];
  observations: unknown[];
  serverTime: number;
  warning: string | null;
};

/** Connection state of the observe stream, for the status dot. */
export type StreamStatus = "connecting" | "open" | "reconnecting";

/** SSE subscription hook: keeps the latest snapshot frame and live stream status. */
export function useAgentEvents(): {
  snapshot: ConsoleSnapshotFrame | null;
  status: StreamStatus;
} {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshotFrame | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    const stream: AgentEventStream = connectAgentEvents({
      onSnapshot: (raw) => {
        const frame = raw as ConsoleSnapshotFrame;
        if (frame && Array.isArray(frame.events)) setSnapshot(frame);
      },
      onObservation: () => {
        // Live observations only matter for the status dot; the next
        // events.ingested round-trips through the server snapshot on reconnect.
      },
      onStatus: setStatus,
    });
    return () => stream.close();
  }, []);

  return { snapshot, status };
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

export function ConsoleApp(): ReactElement {
  const { snapshot, status } = useAgentEvents();
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
