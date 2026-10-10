/**
 * What a database driver must provide. `src/server/db.ts` is the only caller;
 * services never talk to a driver directly.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Rows returned for a query, rows changed for a write. */
  rowCount: number;
}

export interface Executor {
  /**
   * Runs one statement. SQL uses `?` placeholders and the subset of SQL that
   * SQLite and PostgreSQL share. `wantRows` is true when the caller reads the
   * result set (including `INSERT … RETURNING`).
   */
  query(sql: string, params: SqlValue[], wantRows: boolean): Promise<QueryResult>;
}

export type DriverKind = "sqlite" | "postgres";

export interface Driver extends Executor {
  readonly kind: DriverKind;
  /**
   * Runs `fn` in one write transaction on one connection. Every statement `fn`
   * issues must go through the executor it is given. Commits when `fn`
   * resolves and rolls back when it rejects. Write transactions are serialised
   * against each other: no two run at the same time (see each driver).
   */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The database cannot be used: not configured, unreachable, or its schema is
 * behind the code. `reason` is safe to log; it never contains a connection
 * string or credentials. The HTTP layer turns this into a 503.
 */
export class DatabaseUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Database unavailable: ${reason}`);
    this.name = "DatabaseUnavailableError";
  }
}

/** True for a `DatabaseUnavailableError`, including one created by another copy of this module. */
export function isDatabaseUnavailable(error: unknown): error is DatabaseUnavailableError {
  return error instanceof Error && error.name === "DatabaseUnavailableError";
}
