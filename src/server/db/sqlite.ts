import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { SQLITE_MIGRATIONS } from "./sqlite-schema";
import type { Driver, Executor, QueryResult, SqlValue } from "./types";

/**
 * SQLite driver, for local development and tests only. `node:sqlite` is loaded
 * by `openSqlite`, which production never calls, so a production bundle never
 * needs the module.
 *
 * One connection per process. Statements are synchronous underneath; the
 * asynchronous interface exists so the same services run on PostgreSQL.
 *
 * A transaction holds the connection across `await`s, so everything else waits
 * its turn behind a lock: another request's query can never run inside
 * someone else's transaction, and two transactions never overlap. That is the
 * same single-writer rule SQLite's `BEGIN IMMEDIATE` gave the synchronous code.
 */

class Lock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function migrate(db: DatabaseSync): void {
  const version = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version() >= SQLITE_MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read again inside the lock: another process may have migrated meanwhile.
    for (let applied = version(); applied < SQLITE_MIGRATIONS.length; applied++) {
      db.exec(SQLITE_MIGRATIONS[applied]);
      db.exec(`PRAGMA user_version = ${applied + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function openSqlite(file: string): Promise<Driver> {
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
  );
  migrate(db);

  const statements = new Map<string, StatementSync>();
  const lock = new Lock();

  const execute = (sql: string, params: SqlValue[], wantRows: boolean): QueryResult => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    const values = params as SQLInputValue[];
    if (wantRows) {
      const rows = statement.all(...values) as Record<string, unknown>[];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(statement.run(...values).changes) };
  };

  // Inside a transaction the lock is already held, so statements run directly.
  const inTransaction: Executor = {
    query: async (sql, params, wantRows) => execute(sql, params, wantRows),
  };

  return {
    kind: "sqlite",
    query: (sql, params, wantRows) => lock.run(() => execute(sql, params, wantRows)),
    transaction: (fn) =>
      lock.run(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(inTransaction);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // the failed statement already rolled back
          }
          throw error;
        }
      }),
    close: async () => {
      statements.clear();
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}
