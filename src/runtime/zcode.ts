import type {
  PlatformAdapter,
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";

export const ZCODE_UNAVAILABLE_REASON = "zcode adapter is not configured";

export type ZCodeAdapter = PlatformAdapter & {
  readonly id: "zcode";
  start(
    input: PlatformRunInput & { platform: "zcode" },
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

/**
 * ZCode has no verified official SDK contract yet. Do not turn Hub payloads
 * into a guessed CLI invocation: this adapter intentionally fails closed.
 */
export function createZCodeAdapter(): ZCodeAdapter {
  return {
    id: "zcode",
    async probe(): Promise<PlatformProbe> {
      return {
        installed: false,
        version: null,
        reason: ZCODE_UNAVAILABLE_REASON,
      };
    },
    async *start(): AsyncIterable<PlatformEvent> {
      throw new Error(ZCODE_UNAVAILABLE_REASON);
    },
  };
}
