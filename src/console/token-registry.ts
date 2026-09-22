import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HubAuthorizer } from "../hub/index.js";

export type RegisteredToken = {
  readonly token: string;
  readonly clientId: string;
  readonly issuedAt: number;
};

/** In-memory cache of browser-issued authorizations: token -> clientId.
 * Lost on restart by design; every access requires a fresh login. */
export class TokenRegistry {
  private readonly byToken = new Map<string, RegisteredToken>();

  register(clientId: string): RegisteredToken {
    if (clientId.trim().length === 0) {
      throw new TypeError("clientId must be a nonempty string");
    }
    const record: RegisteredToken = {
      token: `console-${randomUUID()}`,
      clientId,
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

/**
 * Principal every registry-issued token authorizes as. Kept stable so hub
 * offer delivery keeps matching; it is console-scoped and intentionally not
 * part of this module's public API.
 */
const CONSOLE_PRINCIPAL = "demo-user";

export function createRegistryAuthorizer(
  registry: TokenRegistry,
): HubAuthorizer<string> {
  return async (token: string, _request: IncomingMessage) =>
    registry.verify(token) ? CONSOLE_PRINCIPAL : null;
}
