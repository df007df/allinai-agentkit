/** @deprecated Import protocol types from `@allin-ai/agent-client/protocol`. */
export * from "../protocol/types.js";

/** Thrown before transport startup when a client-owned endpoint setting is unsafe. */
export class AgentClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentClientConfigurationError";
  }
}
