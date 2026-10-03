import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import type { HubAuthorizer } from "../hub/index.js";

export type RegisteredToken = {
  readonly token: string;
  readonly clientId: string;
  readonly issuedAt: number;
};

/**
 * Pluggable persistence for console-issued tokens. Async by design so a
 * network backend (MySQL, …) can replace the default SQLite one without
 * touching the registry or its call sites.
 */
export interface TokenStore {
  save(record: RegisteredToken): Promise<void>;
  findByToken(token: string): Promise<RegisteredToken | null>;
  deleteByToken(token: string): Promise<boolean>;
  list(): Promise<RegisteredToken[]>;
  close?(): Promise<void> | void;
}

/** Ephemeral store; the previous default behavior, kept for tests. */
export class MemoryTokenStore implements TokenStore {
  private readonly byToken = new Map<string, RegisteredToken>();

  async save(record: RegisteredToken): Promise<void> {
    this.byToken.set(record.token, record);
  }

  async findByToken(token: string): Promise<RegisteredToken | null> {
    return this.byToken.get(token) ?? null;
  }

  async deleteByToken(token: string): Promise<boolean> {
    return this.byToken.delete(token);
  }

  async list(): Promise<RegisteredToken[]> {
    return [...this.byToken.values()];
  }
}

type TokenRow = { token: string; client_id: string; issued_at: number };

/** Default durable store: one SQLite file, conventionally `tokens.db`. */
export class SqliteTokenStore implements TokenStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS console_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      );
    `);
  }

  async save(record: RegisteredToken): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO console_tokens (token, client_id, issued_at)
         VALUES (?, ?, ?)`,
      )
      .run(record.token, record.clientId, record.issuedAt);
  }

  async findByToken(token: string): Promise<RegisteredToken | null> {
    const row = this.db
      .prepare(`SELECT token, client_id, issued_at FROM console_tokens WHERE token = ?`)
      .get(token) as TokenRow | undefined;
    return row
      ? { token: row.token, clientId: row.client_id, issuedAt: Number(row.issued_at) }
      : null;
  }

  async deleteByToken(token: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM console_tokens WHERE token = ?`).run(token).changes > 0;
  }

  async list(): Promise<RegisteredToken[]> {
    const rows = this.db
      .prepare(`SELECT token, client_id, issued_at FROM console_tokens ORDER BY issued_at ASC`)
      .all() as TokenRow[];
    return rows.map((row) => ({
      token: row.token,
      clientId: row.client_id,
      issuedAt: Number(row.issued_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Registry of browser-issued authorizations: token -> clientId. Backed by the
 * injected store — SQLite by default in real hosts (survives restarts), the
 * memory store in tests.
 */
export class TokenRegistry {
  private readonly store: TokenStore;

  constructor(store: TokenStore = new MemoryTokenStore()) {
    this.store = store;
  }

  async register(clientId: string): Promise<RegisteredToken> {
    if (clientId.trim().length === 0) {
      throw new TypeError("clientId must be a nonempty string");
    }
    const record: RegisteredToken = {
      token: `console-${randomUUID()}`,
      clientId,
      issuedAt: Date.now(),
    };
    await this.store.save(record);
    return record;
  }

  async verify(token: string): Promise<RegisteredToken | null> {
    return this.store.findByToken(token);
  }

  async revoke(token: string): Promise<boolean> {
    return this.store.deleteByToken(token);
  }

  async list(): Promise<RegisteredToken[]> {
    return this.store.list();
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}

/**
 * Principal every registry-issued token authorizes as. Kept stable so hub
 * offer delivery keeps matching; it is console-scoped and intentionally not
 * part of this module's public API.
 */
export const CONSOLE_PRINCIPAL = "demo-user";

export function createRegistryAuthorizer(
  registry: TokenRegistry,
): HubAuthorizer<string> {
  return async (token: string, _request: IncomingMessage) =>
    (await registry.verify(token)) ? CONSOLE_PRINCIPAL : null;
}
