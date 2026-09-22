import { StringDecoder } from "node:string_decoder";
import { isPlatformEvent } from "./events.js";
import type { PlatformEvent, PlatformId, PlatformRunInput } from "./types.js";

export type RunnerStartMessage = {
  type: "run.start";
  executionId: string;
  input: PlatformRunInput;
};

export type RunnerChildMessage = {
  type: "event";
  event: PlatformEvent;
};

/** Child → parent: a tool call needs a human decision before it may run. */
export type RunnerApprovalRequestMessage = {
  type: "tool_approval.request";
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

/** Parent → child: the human decision for a pending tool approval. */
export type RunnerApprovalResponseMessage = {
  type: "tool_approval.response";
  requestId: string;
  decision: "allow" | "deny";
  reason?: string;
};

export type RunnerParentMessage =
  | RunnerStartMessage
  | RunnerApprovalResponseMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPlatformId(value: unknown): value is PlatformId {
  return (
    value === "codex" ||
    value === "claude" ||
    value === "pi" ||
    value === "zcode"
  );
}

function isRunInput(value: unknown): value is PlatformRunInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "platform",
      "prompt",
      "cwd",
      "sessionId",
      "model",
      "context",
    ]) ||
    !isPlatformId(value.platform) ||
    typeof value.prompt !== "string"
  ) {
    return false;
  }
  return (
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.context === undefined || isRecord(value.context))
  );
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function encodeRunnerStart(
  executionId: string,
  input: PlatformRunInput,
): string {
  return encodeJsonLine({
    type: "run.start",
    executionId,
    input,
  } satisfies RunnerStartMessage);
}

export function encodeRunnerEvent(event: PlatformEvent): string {
  return encodeJsonLine({ type: "event", event } satisfies RunnerChildMessage);
}

export function parseRunnerStart(value: unknown): RunnerStartMessage | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "executionId", "input"]) ||
    value.type !== "run.start" ||
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    !isRunInput(value.input)
  ) {
    return null;
  }
  return {
    type: "run.start",
    executionId: value.executionId,
    input: value.input,
  };
}

export function encodeApprovalRequest(
  request: RunnerApprovalRequestMessage,
): string {
  return encodeJsonLine(request);
}

export function parseApprovalRequest(
  value: unknown,
): RunnerApprovalRequestMessage | null {
  if (
    !isRecord(value) ||
    value.type !== "tool_approval.request" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.toolName !== "string" ||
    !isRecord(value.toolInput)
  ) {
    return null;
  }
  return {
    type: "tool_approval.request",
    requestId: value.requestId,
    toolName: value.toolName,
    toolInput: value.toolInput,
  };
}

export function encodeApprovalResponse(
  response: RunnerApprovalResponseMessage,
): string {
  return encodeJsonLine(response);
}

export function parseApprovalResponse(
  value: unknown,
): RunnerApprovalResponseMessage | null {
  if (
    !isRecord(value) ||
    value.type !== "tool_approval.response" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    (value.decision !== "allow" && value.decision !== "deny") ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    return null;
  }
  return {
    type: "tool_approval.response",
    requestId: value.requestId,
    decision: value.decision,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
  };
}

export function parseRunnerChildMessage(
  value: unknown,
): RunnerChildMessage | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "event"]) ||
    value.type !== "event" ||
    !isPlatformEvent(value.event)
  ) {
    return null;
  }
  return { type: "event", event: value.event };
}

/** Incremental UTF-8 JSONL decoder used for both runner stdin and stdout. */
export class JsonlDecoder {
  private remaining = "";
  private readonly utf8 = new StringDecoder("utf8");

  push(chunk: string | Uint8Array): string[] {
    this.remaining +=
      typeof chunk === "string" ? chunk : this.utf8.write(Buffer.from(chunk));
    const lines = this.remaining.split("\n");
    this.remaining = lines.pop() ?? "";
    return lines.map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line,
    );
  }

  finish(): string[] {
    this.remaining += this.utf8.end();
    if (this.remaining.length === 0) return [];
    const line = this.remaining.endsWith("\r")
      ? this.remaining.slice(0, -1)
      : this.remaining;
    this.remaining = "";
    return [line];
  }
}
