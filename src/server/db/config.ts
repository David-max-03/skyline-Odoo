import path from "node:path";
import { DatabaseUnavailableError } from "./types";

/**
 * Which database this process uses.
 *
 * - PostgreSQL whenever `DATABASE_URL` is set, and always in production.
 * - SQLite only for local development and tests: when `NODE_ENV` is not
 *   `production`, or when `SKYLINE_DB_DRIVER=sqlite` asks for it explicitly
 *   (the end-to-end script does, to run a production build on a temp file).
 * - Never SQLite on a serverless host, whatever is set: its filesystem is
 *   read-only and not shared, so a local file there would lose data.
 *
 * There is no fallback. A production process without `DATABASE_URL` fails
 * with a clear error instead of quietly opening a local file.
 */

export type DbConfig = { kind: "sqlite"; file: string } | { kind: "postgres"; url: string };

const env = (name: string) => process.env[name]?.trim() || null;

/** True on Netlify Functions / AWS Lambda, where there is no durable local disk. */
export function isServerless(): boolean {
  return Boolean(env("AWS_LAMBDA_FUNCTION_NAME") || env("LAMBDA_TASK_ROOT") || env("NETLIFY"));
}

export function sqliteFile(): string {
  return env("SKYLINE_DB_PATH") ?? path.join(process.cwd(), "data", "skyline.db");
}

export function resolveDbConfig(): DbConfig {
  const explicit = env("SKYLINE_DB_DRIVER");
  if (explicit && explicit !== "postgres" && explicit !== "sqlite") {
    throw new DatabaseUnavailableError("SKYLINE_DB_DRIVER must be `postgres` or `sqlite`");
  }
  const url = env("DATABASE_URL");

  if (explicit === "postgres" || (!explicit && url)) {
    if (!url) throw new DatabaseUnavailableError("DATABASE_URL is not set");
    return { kind: "postgres", url };
  }
  if (explicit === "sqlite" || process.env.NODE_ENV !== "production") {
    if (isServerless()) {
      throw new DatabaseUnavailableError("SQLite cannot be used on a serverless host; set DATABASE_URL");
    }
    return { kind: "sqlite", file: sqliteFile() };
  }
  throw new DatabaseUnavailableError("DATABASE_URL is not set");
}

/** Identifies a configuration without exposing it, so a changed setting reopens the connection. */
export const configKey = (config: DbConfig) =>
  config.kind === "sqlite" ? `sqlite:${config.file}` : `postgres:${config.url.length}:${config.url.slice(-24)}`;
