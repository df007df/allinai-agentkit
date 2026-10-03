/** The supported local execution platforms. */
export const PLATFORM_IDS = ["codex", "claude", "pi", "zcode"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/**
 * Vendor-neutral input for one platform run. Runtime adapters own any further
 * platform-specific validation; this transport never turns these values into
 * executable arguments. `sessionDir` is a host hint naming where the session
 * recorder mirrors this run's records; adapters ignore it.
 */
export type PlatformRunInput = {
  platform: PlatformId;
  prompt: string;
  cwd?: string;
  sessionDir?: string;
  sessionId?: string;
  model?: string;
  context?: Record<string, unknown>;
  /**
   * Active plugin repositories to deliver to the platform for this run
   * (claude: --plugin-dir per path; codex/pi: marketplaces are preinstalled
   * by the dispatcher, so they ignore this field).
   */
  pluginDirs?: string[];
};

/**
 * A normalized event emitted by every platform runner. `vendor` is the lossless
 * catch-all for SDK messages that have no precise normalized counterpart: it is
 * preserved end to end but intentionally not logged or reported by default.
 */
export type PlatformEvent = {
  type:
    | "init"
    | "text_delta"
    | "thinking_delta"
    | "tool"
    | "vendor"
    | "done"
    | "error";
  payload?: Record<string, unknown>;
};

export type PlatformProbe = {
  installed: boolean;
  version: string | null;
  reason?: string;
};

/** Platform SDK implementations are isolated from the Supervisor. */
export interface PlatformAdapter {
  readonly id: PlatformId;
  probe(): Promise<PlatformProbe>;
  start(
    input: PlatformRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
}

/** Public execution boundary consumed by the Client Supervisor. */
export interface RunnerManager {
  start(
    executionId: string,
    input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent>;
  cancel(executionId: string): Promise<void>;
  /**
   * Delivers a human tool-approval decision to the in-flight run. Unknown or
   * already-settled request ids are ignored; runs without in-process approval
   * support may omit it.
   */
  respondToolApproval?(
    executionId: string,
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
  ): void;
  /**
   * Finds the execution that owns a pending tool approval request id, for
   * out-of-process callers (hooks HTTP bridge) that only know the id.
   * Implementations without in-process approval support may omit it.
   */
  ownerOfToolApproval?(requestId: string): string | null;
  /**
   * Resolves when every child owned by this manager has emitted close and its
   * process resources have been released. Older test doubles may omit it.
   */
  waitForIdle?(): Promise<void>;
}
