/** Public client core entrypoint; runtime SDK adapters stay on /runtime. */
export {
  ClientStateStore,
  EXECUTION_STATES,
  type AdmissionResult,
  type AdmissionOptions,
  type EventToAppend,
  type ExecutionState,
  type StoredExecution,
} from "./state-store.js";
export {
  ClientSupervisor,
  LOCAL_POLICY_DECISIONS,
  type ClientSupervisorOptions,
  type LocalPolicy,
  type LocalPolicyDecision,
  type PluginManagerPort,
} from "./supervisor.js";
export type {
  ClientTransport,
  ClientTransportHandlers,
  RunStarter,
} from "./transport.js";
export {
  WsClientTransport,
  type ClientWebSocketLike,
  type WsClientTransportOptions,
} from "./ws-transport.js";
export { AgentClientConfigurationError } from "./types.js";
