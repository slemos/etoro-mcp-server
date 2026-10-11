import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TokenSet } from "./oauth.js";

export interface StoredTokens extends TokenSet {
  clientId: string;
  savedAt: number;
}

interface Row {
  client_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number | null;
  scopes: string;
  saved_at: number;
}

/**
 * The OAuth tokens, in a file only the current user can read. Several server processes (Claude Desktop and Claude Code
 * at once) share it, and eToro rotates the refresh token on every renewal, so renewals take a short lease first:
 * whoever holds it renews, the others wait and then read the new tokens.
 */
export class TokenStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    const fresh = path === ":memory:" ? false : !existsSync(path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        client_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER,
        scopes TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        until INTEGER NOT NULL
      );
    `);
    if (fresh || path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows has no POSIX modes: the user profile directory already restricts access.
      }
    }
  }

  load(clientId?: string): StoredTokens | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE id = 1").get() as unknown as Row | undefined;
    if (!row || (clientId !== undefined && row.client_id !== clientId)) return undefined;
    return {
      clientId: row.client_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at ?? undefined,
      scopes: JSON.parse(row.scopes) as string[],
      savedAt: row.saved_at,
    };
  }

  save(clientId: string, t: TokenSet): void {
    this.db
      .prepare(
        `INSERT INTO tokens (id, client_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scopes, saved_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes, saved_at = excluded.saved_at`,
      )
      .run(clientId, t.accessToken, t.refreshToken, t.accessExpiresAt, t.refreshExpiresAt ?? null, JSON.stringify(t.scopes), this.now());
  }

  clear(): void {
    this.db.exec("DELETE FROM tokens");
  }

  /** Takes the renewal lease if nobody holds a live one. The lease expires on its own, so a crashed process cannot block the others. */
  tryAcquire(owner: string, leaseMs = 30_000): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT owner, until FROM lease WHERE id = 1").get() as unknown as { owner: string; until: number } | undefined;
      const t = this.now();
      if (row && row.until > t && row.owner !== owner) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare("INSERT INTO lease (id, owner, until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, until = excluded.until").run(owner, t + leaseMs);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  release(owner: string): void {
    this.db.prepare("DELETE FROM lease WHERE id = 1 AND owner = ?").run(owner);
  }

  close(): void {
    this.db.close();
  }
}
