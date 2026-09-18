import {
  ClientStateStore,
  type ExecutionState,
  type StoredExecution,
} from "./state-store.js";
import type { ClientCommand } from "./types.js";
import type { PluginSyncAcknowledgement } from "./types.js";
import type { ClientTransport } from "./transport.js";
import type {
  ActivePluginSnapshot,
  InstalledPlugin,
  PluginConfig,
} from "../plugins/types.js";
import {
  buildCapabilityContext,
  type LocalContextSource,
} from "../capabilities/context.js";
import { validateCapabilityInput } from "../capabilities/input.js";
import {
  decideCapability,
  type CapabilityLocalPolicy,
} from "../capabilities/policy.js";
import type { CapabilityEvent } from "../capabilities/shell-wire.js";
import type { ShellCapability } from "../capabilities/types.js";
import type {
  PlatformEvent,
  PlatformRunInput,
  RunnerManager,
} from "../runtime/types.js";

type AgentRunCommand = Extract<ClientCommand, { kind: "agent.run" }>;
type CapabilityInvokeCommand = Extract<
  ClientCommand,
  { kind: "capability.invoke" }
>;

export const LOCAL_POLICY_DECISIONS = ["auto", "approval", "deny"] as const;

export type LocalPolicyDecision = (typeof LOCAL_POLICY_DECISIONS)[number];

/**
 * The local daemon decides whether an admitted remote run may launch. The
 * default is deny: receiving a Hub command must not implicitly execute an
 * agent until a local policy has been deliberately configured.
 */
export type LocalPolicy = (
  command: AgentRunCommand,
) => LocalPolicyDecision | Promise<LocalPolicyDecision>;

export type ClientSupervisorOptions = {
  store: ClientStateStore;
  transport: ClientTransport;
  runner: RunnerManager;
  /** Maximum simultaneous local executions. Overflow is durably rejected. */
  maxConcurrentRuns?: number;
  policy?: LocalPolicy;
  plugins?: PluginManagerPort;
  capabilityHost?: CapabilityHostPort;
  capabilityPolicy?: CapabilityLocalPolicy;
  capabilityContext?: CapabilityContextResolver;
};

export type PluginManagerPort = {
  sync(desired: PluginConfig[]): Promise<InstalledPlugin[]>;
  snapshotActivePlugins(
    runtime?: AgentRunCommand["runtime"],
  ): ActivePluginSnapshot[];
};

/** A locally validated capability plus the exact immutable plugin root it owns. */
export type ResolvedActiveCapability = {
  plugin: InstalledPlugin;
  capability: ShellCapability;
  pluginRoot: string;
};

/**
 * The Supervisor only knows how to resolve an active, local declaration and
 * consume structured events. It cannot name an executable or provide argv.
 */
export type CapabilityHostPort = {
  resolveActiveCapability(
    capabilityId: string,
  ): Promise<ResolvedActiveCapability | null>;
  invoke(
    resolved: ResolvedActiveCapability,
    input: unknown,
    context: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityEvent>;
};

/** Supplies only local metadata. Hub command fields are never spread into it. */
export type CapabilityContextResolver = (
  command: CapabilityInvokeCommand,
  resolved: ResolvedActiveCapability,
) => LocalContextSource;

const ACTIVE_STATES: readonly ExecutionState[] = [
  "received",
  "awaiting_approval",
  "running",
];

function isActive(state: ExecutionState): boolean {
  return ACTIVE_STATES.includes(state);
}

function runnerStartFailurePayload(error: unknown): Record<string, unknown> {
  return {
    reason: "runner_start_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function runnerStreamFailurePayload(error: unknown): Record<string, unknown> {
  return {
    reason: "runner_stream_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function platformRunInput(command: AgentRunCommand): PlatformRunInput {
  const prompt = command.payload.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("agent.run payload.prompt must be a nonempty string");
  }

  const optionalString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  return {
    platform: command.runtime,
    prompt,
    cwd: optionalString(command.payload.cwd),
    sessionId: optionalString(command.payload.sessionId),
    model: optionalString(command.payload.model),
    context: command.payload,
  };
}

function progressPayload(event: PlatformEvent): Record<string, unknown> {
  return {
    ...(event.payload ?? {}),
    eventType: event.type,
  };
}

function capabilityProgressPayload(
  event: CapabilityEvent,
): Record<string, unknown> {
  return { ...event.payload, eventType: event.type };
}

function workspaceFromLocalContext(source: LocalContextSource): string {
  if (typeof source.workspace === "string") return source.workspace;
  if (
    source.workspace &&
    typeof source.workspace === "object" &&
    !Array.isArray(source.workspace) &&
    typeof source.workspace.path === "string"
  ) {
    return source.workspace.path;
  }
  return "";
}

function executionContext(
  command: CapabilityInvokeCommand,
): Record<string, unknown> {
  return {
    executionId: command.executionId,
    taskId: command.taskId,
    commandId: command.commandId,
    attempt: command.attempt,
  };
}

/**
 * Coordinates durable task admission, local execution policy, and outbox
 * delivery. Vendor runtimes and shell hosts remain outside this class.
 */
export class ClientSupervisor {
  private readonly policy: LocalPolicy;
  private readonly capabilityContext: CapabilityContextResolver;
  private readonly maxConcurrentRuns: number;
  private readonly pluginSyncInFlight = new Map<string, Promise<void>>();
  private readonly capabilityAbortControllers = new Map<
    string,
    AbortController
  >();
  private readonly runnerConsumptionTasks = new Map<string, Promise<void>>();
  private readonly capabilityConsumptionTasks = new Map<
    string,
    Promise<void>
  >();
  private started = false;
  private shuttingDown = false;

  constructor(private readonly options: ClientSupervisorOptions) {
    this.policy = options.policy ?? (() => "deny");
    this.capabilityContext = options.capabilityContext ?? (() => ({}));
    this.maxConcurrentRuns =
      options.maxConcurrentRuns ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(this.maxConcurrentRuns) ||
      this.maxConcurrentRuns < 1
    ) {
      throw new RangeError("maxConcurrentRuns must be a positive safe integer");
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.transport.connect({
      command: async (command) => this.handleCommand(command),
      pluginSync: async (input) => this.handlePluginSync(input),
      connected: async () => this.flush(),
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.transport.close();
  }

  /**
   * Service shutdown has a stricter lifecycle than an ordinary transport
   * disconnect: persist cancellation and signal every locally owned child
   * before the socket and state store are released.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const execution of this.options.store.listExecutions()) {
      if (isActive(execution.state)) {
        await this.cancelActiveExecution(execution.executionId);
      }
    }
    await this.waitForConsumptionTasks();
    await this.options.runner.waitForIdle?.();
    await this.stop();
  }

  /**
   * Approval only resumes the exact persisted structured command. It never
   * accepts a replacement command, entrypoint, or argument vector.
   */
  async approve(executionId: string): Promise<void> {
    const execution = this.requireExecution(executionId);
    if (execution.state !== "awaiting_approval") {
      throw new Error(`Execution ${executionId} is not awaiting approval`);
    }
    if (execution.command.kind === "agent.run") {
      await this.startPersistedAgentRun(execution);
      return;
    }
    if (execution.command.kind === "capability.invoke") {
      await this.startApprovedCapability(execution);
      return;
    }
    throw new Error(`Execution ${executionId} cannot be approved`);
  }

  /**
   * Pushes durable outbox rows and removes only the watermark each execution
   * actually received. A failed push does not touch local state, so reconnect
   * replay remains possible.
   */
  async flush(): Promise<void> {
    const events = this.options.store.listUnackedEvents();
    if (events.length === 0) return;

    const receivedWatermarks = await this.options.transport.push(events);
    const sentWatermarks = new Map<string, number>();
    for (const event of events) {
      const current = sentWatermarks.get(event.executionId) ?? 0;
      sentWatermarks.set(event.executionId, Math.max(current, event.eventSeq));
    }

    const acknowledgements: Array<[string, number]> = [];
    for (const [executionId, watermark] of Object.entries(receivedWatermarks)) {
      const sentWatermark = sentWatermarks.get(executionId);
      if (sentWatermark === undefined) continue;
      if (!Number.isSafeInteger(watermark) || watermark < 0) {
        throw new RangeError(
          `Invalid acknowledgement watermark for ${executionId}`,
        );
      }
      acknowledgements.push([executionId, Math.min(watermark, sentWatermark)]);
    }

    for (const [executionId, watermark] of acknowledgements) {
      this.options.store.acknowledge(executionId, watermark);
    }
  }

  private async handleCommand(command: ClientCommand): Promise<void> {
    if (command.kind === "cancel") {
      await this.cancelActiveExecution(command.executionId);
      return;
    }

    const pluginSnapshot =
      command.kind === "agent.run"
        ? (this.options.plugins?.snapshotActivePlugins(command.runtime) ?? [])
        : [];
    const admission = this.options.store.admit(command, { pluginSnapshot });
    if (admission.disposition === "duplicate") return;

    if (command.kind === "capability.invoke") {
      await this.handleCapabilityCommand(command);
      return;
    }

    const decision = await this.decide(command);
    const execution = this.options.store.getExecution(command.executionId);
    if (!execution || execution.state !== "received") return;

    if (decision === "deny") {
      this.options.store.transition(command.executionId, "rejected", {
        reason: "local_policy_denied",
      });
      return;
    }
    if (decision === "approval") {
      this.options.store.transition(command.executionId, "awaiting_approval", {
        reason: "local_policy_requires_approval",
      });
      return;
    }

    await this.startPersistedAgentRun(execution);
  }

  private async decide(command: AgentRunCommand): Promise<LocalPolicyDecision> {
    try {
      const decision = await this.policy(command);
      return LOCAL_POLICY_DECISIONS.includes(decision) ? decision : "deny";
    } catch {
      return "deny";
    }
  }

  private async handleCapabilityCommand(
    command: CapabilityInvokeCommand,
  ): Promise<void> {
    const resolved = await this.resolveActiveCapability(
      command.executionId,
      command,
    );
    if (!resolved) return;
    if (
      !this.validateCapabilityInput(
        command.executionId,
        resolved,
        command.input,
      )
    ) {
      return;
    }

    let source: LocalContextSource;
    let context: Record<string, unknown>;
    try {
      source = this.capabilityContext(command, resolved);
      context = buildCapabilityContext(resolved.capability.contextKeys, {
        ...source,
        execution: executionContext(command),
      });
    } catch {
      this.options.store.transition(command.executionId, "rejected", {
        reason: "capability_context_invalid",
      });
      return;
    }

    const decision = this.options.capabilityPolicy
      ? decideCapability(
          this.options.capabilityPolicy,
          resolved.plugin,
          resolved.capability,
          workspaceFromLocalContext(source),
        )
      : { mode: "deny" as const, reason: "capability_policy_unavailable" };

    if (decision.mode === "deny") {
      this.options.store.transition(command.executionId, "rejected", {
        reason: decision.reason,
      });
      return;
    }
    if (decision.mode === "approval") {
      this.options.store.transition(command.executionId, "awaiting_approval", {
        reason: decision.reason,
      });
      return;
    }
    this.startPersistedCapability(command.executionId, resolved, context);
  }

  private async startApprovedCapability(
    execution: StoredExecution,
  ): Promise<void> {
    if (execution.command.kind !== "capability.invoke") return;
    const command = execution.command;
    const resolved = await this.resolveActiveCapability(
      execution.executionId,
      command,
    );
    if (!resolved) return;
    if (
      !this.validateCapabilityInput(
        execution.executionId,
        resolved,
        command.input,
      )
    ) {
      return;
    }

    let source: LocalContextSource;
    let context: Record<string, unknown>;
    try {
      source = this.capabilityContext(command, resolved);
      context = buildCapabilityContext(resolved.capability.contextKeys, {
        ...source,
        execution: executionContext(command),
      });
    } catch {
      this.options.store.transition(execution.executionId, "rejected", {
        reason: "capability_context_invalid",
      });
      return;
    }
    const decision = this.options.capabilityPolicy
      ? decideCapability(
          this.options.capabilityPolicy,
          resolved.plugin,
          resolved.capability,
          workspaceFromLocalContext(source),
        )
      : { mode: "deny" as const, reason: "capability_policy_unavailable" };
    if (decision.mode === "deny") {
      this.options.store.transition(execution.executionId, "rejected", {
        reason: decision.reason,
      });
      return;
    }
    this.startPersistedCapability(execution.executionId, resolved, context);
  }

  private async resolveActiveCapability(
    executionId: string,
    command: CapabilityInvokeCommand,
  ): Promise<ResolvedActiveCapability | null> {
    const host = this.options.capabilityHost;
    if (!host) {
      this.options.store.transition(executionId, "rejected", {
        reason: "capability_host_unavailable",
      });
      return null;
    }
    try {
      const resolved = await host.resolveActiveCapability(command.capabilityId);
      if (resolved) return resolved;
    } catch {
      this.options.store.transition(executionId, "rejected", {
        reason: "capability_resolution_failed",
      });
      return null;
    }
    this.options.store.transition(executionId, "rejected", {
      reason: "capability_not_found",
    });
    return null;
  }

  private validateCapabilityInput(
    executionId: string,
    resolved: ResolvedActiveCapability,
    input: unknown,
  ): boolean {
    if (validateCapabilityInput(resolved.capability.inputSchema, input)) {
      return true;
    }
    this.options.store.transition(executionId, "rejected", {
      reason: "capability_input_invalid",
    });
    return false;
  }

  private startPersistedCapability(
    executionId: string,
    resolved: ResolvedActiveCapability,
    context: Record<string, unknown>,
  ): void {
    const execution = this.options.store.getExecution(executionId);
    if (
      !execution ||
      execution.command.kind !== "capability.invoke" ||
      (execution.state !== "received" &&
        execution.state !== "awaiting_approval")
    ) {
      return;
    }
    const host = this.options.capabilityHost;
    if (!host) {
      this.options.store.transition(executionId, "rejected", {
        reason: "capability_host_unavailable",
      });
      return;
    }

    if (this.shuttingDown) {
      this.options.store.transition(executionId, "cancelled", {
        reason: "daemon_stopping",
      });
      return;
    }
    if (!this.hasCapacity()) {
      this.options.store.transition(executionId, "rejected", {
        reason: "local_capacity_exhausted",
      });
      return;
    }

    const controller = new AbortController();
    this.options.store.transition(executionId, "running", {
      capabilityId: resolved.capability.id,
      pluginSnapshot: [
        {
          id: resolved.plugin.id,
          resolvedCommit: resolved.plugin.resolvedCommit,
        },
      ],
    });
    this.capabilityAbortControllers.set(executionId, controller);
    try {
      const events = host.invoke(
        resolved,
        execution.command.input,
        context,
        controller.signal,
      );
      this.trackConsumptionTask(
        this.capabilityConsumptionTasks,
        executionId,
        this.consumeCapabilityEvents(executionId, events, controller),
      );
    } catch {
      this.capabilityAbortControllers.delete(executionId);
      this.transitionRunningExecution(executionId, "failed", {
        reason: "capability_start_failed",
      });
    }
  }

  private async consumeCapabilityEvents(
    executionId: string,
    events: AsyncIterable<CapabilityEvent>,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (event.type === "progress" || event.type === "log") {
          if (
            this.options.store.getExecution(executionId)?.state === "running"
          ) {
            this.options.store.appendEvent({
              executionId,
              type: "progress",
              occurredAt: new Date().toISOString(),
              payload: capabilityProgressPayload(event),
            });
          }
          continue;
        }
        if (event.type === "result") {
          this.transitionRunningExecution(executionId, "done", event.payload);
          return;
        }
        this.transitionRunningExecution(executionId, "failed", event.payload);
        return;
      }
      this.transitionRunningExecution(executionId, "failed", {
        reason: "capability_stream_ended",
      });
    } catch {
      this.transitionRunningExecution(executionId, "failed", {
        reason: "capability_stream_failed",
      });
    } finally {
      if (this.capabilityAbortControllers.get(executionId) === controller) {
        this.capabilityAbortControllers.delete(executionId);
      }
    }
  }

  /**
   * Plugin desired state is independent of task admission. A failure records no
   * successful revision, reports a typed rejection if the transport supports
   * it, and deliberately leaves all in-flight runners untouched.
   */
  private async handlePluginSync(input: {
    revision: string;
    plugins: PluginConfig[];
  }): Promise<void> {
    const existing = this.pluginSyncInFlight.get(input.revision);
    if (existing) return existing;

    const work = this.syncPluginRevision(input);
    this.pluginSyncInFlight.set(input.revision, work);
    try {
      await work;
    } finally {
      if (this.pluginSyncInFlight.get(input.revision) === work) {
        this.pluginSyncInFlight.delete(input.revision);
      }
    }
  }

  private async syncPluginRevision(input: {
    revision: string;
    plugins: PluginConfig[];
  }): Promise<void> {
    const plugins = this.options.plugins;
    if (!plugins) {
      await this.reportPluginSync({
        type: "plugin.sync.ack",
        revision: input.revision,
        status: "failed",
        plugins: [],
        error: {
          code: "plugin_sync_failed",
          message: "plugin_manager_unavailable",
        },
      });
      return;
    }

    if (this.options.store.getLastPluginSyncRevision() === input.revision) {
      await this.reportPluginSync({
        type: "plugin.sync.ack",
        revision: input.revision,
        status: "already_applied",
        plugins: plugins.snapshotActivePlugins(),
      });
      return;
    }

    try {
      const result = await plugins.sync(input.plugins);
      const failed = result.find((plugin) => plugin.status === "failed");
      if (failed) {
        await this.reportPluginSync({
          type: "plugin.sync.ack",
          revision: input.revision,
          status: "failed",
          plugins: plugins.snapshotActivePlugins(),
          error: {
            code: "plugin_sync_failed",
            message: failed.lastError ?? `Plugin ${failed.id} could not sync`,
          },
        });
        return;
      }

      this.options.store.recordPluginSyncSuccess(input.revision);
      await this.reportPluginSync({
        type: "plugin.sync.ack",
        revision: input.revision,
        status: "applied",
        plugins: plugins.snapshotActivePlugins(),
      });
    } catch (error) {
      await this.reportPluginSync({
        type: "plugin.sync.ack",
        revision: input.revision,
        status: "failed",
        plugins: plugins.snapshotActivePlugins(),
        error: {
          code: "plugin_sync_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async reportPluginSync(
    acknowledgement: PluginSyncAcknowledgement,
  ): Promise<void> {
    try {
      await this.options.transport.reportPluginSync?.(acknowledgement);
    } catch {
      // The revision outcome is durable locally; a later plugin.sync delivery
      // receives an already_applied or retryable failed acknowledgement.
    }
  }

  private async startPersistedAgentRun(
    execution: StoredExecution,
  ): Promise<void> {
    if (execution.command.kind !== "agent.run") {
      throw new Error(`Execution ${execution.executionId} is not an agent run`);
    }
    if (
      execution.state !== "received" &&
      execution.state !== "awaiting_approval"
    ) {
      return;
    }

    if (this.shuttingDown) {
      this.options.store.transition(execution.executionId, "cancelled", {
        reason: "daemon_stopping",
      });
      return;
    }
    if (!this.hasCapacity()) {
      this.options.store.transition(execution.executionId, "rejected", {
        reason: "local_capacity_exhausted",
      });
      return;
    }

    this.options.store.transition(execution.executionId, "running", {
      runtime: execution.command.runtime,
      pluginSnapshot: execution.pluginSnapshot,
    });
    try {
      const events = this.options.runner.start(
        execution.executionId,
        platformRunInput(execution.command),
      );
      this.trackConsumptionTask(
        this.runnerConsumptionTasks,
        execution.executionId,
        this.consumeRunnerEvents(execution.executionId, events),
      );
    } catch (error) {
      this.transitionRunningExecution(
        execution.executionId,
        "failed",
        runnerStartFailurePayload(error),
      );
    }
  }

  private async cancelActiveExecution(executionId: string): Promise<void> {
    const execution = this.options.store.getExecution(executionId);
    if (!execution || !isActive(execution.state)) return;

    this.options.store.transition(executionId, "cancelled", {
      reason: "cancel_requested",
    });
    const capabilityAbort = this.capabilityAbortControllers.get(executionId);
    if (capabilityAbort) {
      capabilityAbort.abort();
      return;
    }
    if (execution.command.kind === "capability.invoke") {
      return;
    }
    try {
      await this.options.runner.cancel(executionId);
    } catch {
      // Cancellation intent is already durable. Runner cleanup must not cause
      // a retrying Hub transport to reverse or replace that terminal state.
    }
  }

  private async consumeRunnerEvents(
    executionId: string,
    events: AsyncIterable<PlatformEvent>,
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (
          event.type === "init" ||
          event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "tool"
        ) {
          this.appendProgressIfRunning(executionId, event);
          continue;
        }
        if (event.type === "done") {
          this.transitionRunningExecution(executionId, "done", event.payload);
          return;
        }
        this.transitionRunningExecution(
          executionId,
          "failed",
          event.payload ?? { reason: "runner_error" },
        );
        return;
      }
      this.transitionRunningExecution(executionId, "failed", {
        reason: "runner_stream_ended",
      });
    } catch (error) {
      this.transitionRunningExecution(
        executionId,
        "failed",
        runnerStreamFailurePayload(error),
      );
    }
  }

  private hasCapacity(): boolean {
    return (
      this.options.store.listExecutions().filter((execution) => {
        return execution.state === "running";
      }).length < this.maxConcurrentRuns
    );
  }

  private trackConsumptionTask(
    tasks: Map<string, Promise<void>>,
    executionId: string,
    task: Promise<void>,
  ): void {
    tasks.set(executionId, task);
    void task.then(
      () => {
        if (tasks.get(executionId) === task) tasks.delete(executionId);
      },
      () => {
        if (tasks.get(executionId) === task) tasks.delete(executionId);
      },
    );
  }

  private async waitForConsumptionTasks(): Promise<void> {
    while (
      this.runnerConsumptionTasks.size > 0 ||
      this.capabilityConsumptionTasks.size > 0
    ) {
      await Promise.all([
        ...this.runnerConsumptionTasks.values(),
        ...this.capabilityConsumptionTasks.values(),
      ]);
    }
  }

  private appendProgressIfRunning(
    executionId: string,
    event: PlatformEvent,
  ): void {
    if (this.options.store.getExecution(executionId)?.state !== "running") {
      return;
    }
    this.options.store.appendEvent({
      executionId,
      type: "progress",
      occurredAt: new Date().toISOString(),
      payload: progressPayload(event),
    });
  }

  private transitionRunningExecution(
    executionId: string,
    nextState: Extract<ExecutionState, "done" | "failed">,
    payload?: Record<string, unknown>,
  ): void {
    if (this.options.store.getExecution(executionId)?.state !== "running") {
      return;
    }
    this.options.store.transition(executionId, nextState, payload);
  }

  private requireExecution(executionId: string): StoredExecution {
    const execution = this.options.store.getExecution(executionId);
    if (!execution) throw new Error(`Unknown execution ${executionId}`);
    return execution;
  }
}
