import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HubAuthorizer } from "../hub/index.js";

/** Every demo token authorizes as one constant principal so the demo
 * router can enqueue offers without ownership conflicts. */
export const DEMO_PRINCIPAL = "demo-user";

export type TokenLabel = "login" | "bootstrap";

export type RegisteredToken = {
  readonly token: string;
  readonly clientId: string;
  readonly label: TokenLabel;
  readonly issuedAt: number;
};

export class TokenRegistry {
  private readonly byToken = new Map<string, RegisteredToken>();

  register(clientId: string, label: TokenLabel = "login"): RegisteredToken {
    if (clientId.trim().length === 0) {
      throw new TypeError("clientId must be a nonempty string");
    }
    const record: RegisteredToken = {
      token: `demo-${randomUUID()}`,
      clientId,
      label,
      issuedAt: Date.now(),
    };
    this.byToken.set(record.token, record);
    return record;
  }

  verify(token: string): RegisteredToken | null {
    return this.byToken.get(token) ?? null;
  }

  revoke(token: string): boolean {
    return this.byToken.delete(token);
  }

  list(): RegisteredToken[] {
    return [...this.byToken.values()];
  }
}

export function createRegistryAuthorizer(
  registry: TokenRegistry,
): HubAuthorizer<string> {
  return async (token: string, _request: IncomingMessage) =>
    registry.verify(token) ? DEMO_PRINCIPAL : null;
}
