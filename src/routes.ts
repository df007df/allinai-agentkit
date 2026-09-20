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

/** Demo control-plane endpoints (offers, plugin sync, inventory, SSE). */
export const DEMO_PATH_PREFIX = `${AGENTKIT_ROOT_PREFIX}/demo`;
export const DEMO_OBSERVE_PATH = `${DEMO_PATH_PREFIX}/observe`;
export const DEMO_OFFERS_PATH = `${DEMO_PATH_PREFIX}/offers`;
export const DEMO_PLUGIN_SYNC_PATH = `${DEMO_PATH_PREFIX}/plugins/sync`;
export const DEMO_INVENTORY_PATH = `${DEMO_PATH_PREFIX}/inventory`;
export const DEMO_INVENTORY_QUERY_PATH = `${DEMO_INVENTORY_PATH}/query`;

/** Reserved second-level segments under the umbrella prefix. */
export const RESERVED_AGENTKIT_SEGMENTS = [
  "hub",
  "login",
  "demo",
] as const;

/** Static demo assets (pages, styles, scripts) served under the prefix. */
export const STATIC_PATH_PREFIX = AGENTKIT_ROOT_PREFIX;

/** Client-side default: hub protocol endpoint used when `pathPrefix` is omitted. */
export const DEFAULT_HUB_WS_PATH = `${HUB_PATH_PREFIX}/ws`;
