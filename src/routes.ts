/**
 * Single source of truth for every path agentkit claims on a host site.
 *
 * Everything the framework mounts lives under one reserved umbrella prefix
 * (`/_agentkit`), so an embedding site keeps `/` and its own namespaces free.
 * Second-level segments separate the subsystems; none of them may be reused
 * by business routes mounted through the agent API router.
 */
export const AGENTKIT_ROOT_PREFIX = "/_agentkit";

/** Protocol v2 WebSocket endpoint: `${HUB_PATH_PREFIX}/ws`. */
export const HUB_PATH_PREFIX = `${AGENTKIT_ROOT_PREFIX}/hub/v2`;

/** Browser authorization page and its approve/deny endpoints. */
export const LOGIN_PATH = `${AGENTKIT_ROOT_PREFIX}/login`;
export const LOGIN_APPROVE_PATH = `${LOGIN_PATH}/approve`;
export const LOGIN_DENY_PATH = `${LOGIN_PATH}/deny`;

/** Console control-plane endpoints. */
export const CONSOLE_PATH_PREFIX = `${AGENTKIT_ROOT_PREFIX}/console`;
export const CONSOLE_OBSERVE_PATH = `${CONSOLE_PATH_PREFIX}/observe`;
/** One-shot JSON snapshot of the console state (SSE-free polling fallback). */
export const CONSOLE_SNAPSHOT_PATH = `${CONSOLE_PATH_PREFIX}/snapshot`;
/** In-flight tool-approval decisions from an approver UI. */
export const CONSOLE_TOOL_APPROVAL_PATH = `${CONSOLE_PATH_PREFIX}/tool-approval`;
/** Execution-level (local policy) approval decisions from an approver UI. */
export const CONSOLE_POLICY_APPROVAL_PATH = `${CONSOLE_PATH_PREFIX}/policy-approval`;
/** Trigger an agent run on one client from the console. */
export const CONSOLE_RUNS_PATH = `${CONSOLE_PATH_PREFIX}/runs`;

/** Reserved second-level segments under the umbrella prefix. */
export const RESERVED_AGENTKIT_SEGMENTS = [
  "hub",
  "login",
  "console",
] as const;

/** Static console assets (pages, styles, scripts) served under the prefix. */
export const STATIC_PATH_PREFIX = AGENTKIT_ROOT_PREFIX;

/** Client-side default: hub protocol endpoint used when `pathPrefix` is omitted. */
export const DEFAULT_HUB_WS_PATH = `${HUB_PATH_PREFIX}/ws`;
