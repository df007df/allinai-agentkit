/** The supported local execution platforms. */
export const PLATFORM_IDS = ["codex", "claude", "pi", "zcode"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

/**
 * Vendor-neutral input for one platform run. Runtime adapters own any further
 * platform-specific validation; this transport never turns these values into
 * executable arguments.
 */
export type PlatformRunInput = {
  platform: PlatformId;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  context?: Record<string, unknown>;
};

/** A normalized event emitted by every platform runner. */
export type PlatformEvent = {
  type: "init" | "text_delta" | "thinking_delta" | "tool" | "done" | "error";
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
   * Resolves when every child owned by this manager has emitted close and its
   * process resources have been released. Older test doubles may omit it.
   */
  waitForIdle?(): Promise<void>;
}
