/** Public API for the standalone Agent Client and embedded Hub adapter. */
export {
  AGENT_CLIENT_PROTOCOL_VERSION,
  encodeClientEventBatch,
  encodeClientHello,
  encodePluginSyncAcknowledgement,
  parseClientCommand,
  parseClientEvent,
  parseClientEventBatch,
  parseClientHello,
  parseHubDownlink,
  parseHubEventAcknowledgement,
  parsePluginSyncAcknowledgement,
  type AgentInput,
  type ClientCommand,
  type ClientEvent,
  type ClientEventBatch,
  type ClientEventType,
  type ClientHello,
  type HubDownlink,
  type HubEventAcknowledgement,
  type HubRuntimeEvent,
  type HubRuntimeHeartbeat,
  type HubRuntimeRegistration,
  type PluginConfig,
  type PluginSyncAcknowledgement,
  type PluginSyncStatus,
  type RuntimeId,
  CLIENT_EVENT_TYPES,
  CLIENT_RUNTIME_IDS,
} from "./protocol/index.js";
export {
  AGENTKIT_ROOT_PREFIX,
  HUB_PATH_PREFIX,
  LOGIN_PATH,
  LOGIN_APPROVE_PATH,
  LOGIN_DENY_PATH,
  CONSOLE_PATH_PREFIX,
  CONSOLE_OBSERVE_PATH,
  RESERVED_AGENTKIT_SEGMENTS,
} from "./routes.js";
// Production Hub port only. Volatile memory helpers remain on /hub/testkit.
export * from "./hub/index.js";
export {
  setBridgeLogger,
  resetBridgeLogger,
  createConsoleLogger,
  createRotatingJsonlLogger,
  serializeLog,
  type BridgeLogger,
  type BridgeLogLevel,
  type AgentLogEntry,
  type LoggerFileSystem,
  type RotatingJsonlLogger,
  type RotatingJsonlLoggerOptions,
} from "./logger.js";
export {
  resolveAgentHome,
  resolveAgentPaths,
  resolveAgentPathsAt,
  resolveAgentControlEndpoint,
  type AgentPaths,
} from "./paths.js";
export {
  defaultAgentConfig,
  loadAgentConfig,
  parseAgentConfig,
  saveAgentConfig,
  type AgentConfig,
  type AgentLocalPolicy,
  type ConfigFileSystem,
  type ConfigWriter,
} from "./config.js";
export {
  createCredentialStore,
  type CredentialStore,
  type CredentialStoreOptions,
  type CredentialFileSystem,
} from "./credentials.js";
export {
  createAgentControlClient,
  startAgentControlServer,
  type AgentControl,
  type AgentControlClient,
  type AgentControlClientOptions,
  type AgentControlServer,
  type AgentControlServerOptions,
  type AgentHealth,
  type AgentStatus,
  type ControlFileSystem,
} from "./control.js";
export {
  ClientStateStore,
  EXECUTION_STATES,
  type AdmissionResult,
  type AdmissionOptions,
  type EventToAppend,
  type ExecutionState,
  type StoredExecution,
} from "./client/state-store.js";
export {
  ClientSupervisor,
  LOCAL_POLICY_DECISIONS,
  type ClientSupervisorOptions,
  type LocalPolicy,
  type LocalPolicyDecision,
  type PluginManagerPort,
} from "./client/supervisor.js";
export type {
  ClientTransport,
  ClientTransportHandlers,
  RunStarter,
} from "./client/transport.js";
export {
  WsClientTransport,
  type ClientWebSocketLike,
  type WsClientTransportOptions,
} from "./client/ws-transport.js";
export { AgentClientConfigurationError } from "./client/types.js";
export { PluginManager, type PluginManagerOptions } from "./plugins/manager.js";
export {
  createGitClient,
  isAllowedGitOrigin,
  isProductionGitUrl,
  type GitClient,
  type GitClientOptions,
} from "./plugins/git.js";
export { isValidPluginId, parsePluginManifest } from "./plugins/manifest.js";
export type {
  ActivePluginSnapshot,
  InstalledPlugin,
  PluginCapabilityDeclaration,
  PluginConfig as GitPluginConfig,
  PluginManifest,
  PluginStateStore,
  StoredPluginState,
} from "./plugins/types.js";
export {
  PLATFORM_IDS,
  PLATFORM_EVENT_TYPES,
  DEFAULT_RUNNER_CHILD_ENTRYPOINT,
  ZCODE_UNAVAILABLE_REASON,
  createRunnerManager,
  createPlatformAdapterRegistry,
  createPiAdapter,
  createZCodeAdapter,
  IsolatedRunnerManager,
  isPlatformEvent,
  isTerminalPlatformEvent,
  platformErrorEvent,
  type PlatformAdapter,
  type PlatformAdapterFor,
  type PlatformAdapterRegistry,
  type PlatformEvent,
  type PlatformId,
  type PlatformProbe,
  type PlatformRunInput,
  type RunnerChildMessage,
  type RunnerChildProcess,
  type RunnerManager,
  type RunnerManagerOptions,
  type RunnerSpawn,
  type RunnerSpawnOptions,
  type RunnerStartMessage,
  type CreatePiAdapterDeps,
  type PiAdapter,
  type PiAdapterRunInput,
  type RegisteredPlatformAdapter,
  type ZCodeAdapter,
} from "./runtime/index.js";
