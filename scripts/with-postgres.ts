/**
 * Runs a command against a disposable, real PostgreSQL server.
 *
 *   npm run test:pg            the unit and integration tests on PostgreSQL
 *   npm run e2e:pg             the end-to-end check on PostgreSQL
 *   tsx scripts/with-postgres.ts <command> [args…]
 *
 * It starts PostgreSQL from the `embedded-postgres` dev dependency (real
 * server binaries, no Docker, no account) on a free local port with a
 * temporary data folder, applies Skyline's migrations to an empty database,
 * runs the command with DATABASE_URL pointing at it, then stops the server and
 * deletes the folder. It never touches a real database: the connection string
 * it sets is always 127.0.0.1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migratePostgres } from "../src/server/db/postgres";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Usage: tsx scripts/with-postgres.ts <command> [args…]");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-pg-"));
  const port = await freePort();
  const password = "skyline-local-test";
  const postgres = new EmbeddedPostgres({
    databaseDir: path.join(dir, "data"),
    user: "skyline",
    password,
    port,
    persistent: false,
    // Byte-wise collation and UTC, so the run does not depend on this machine's locale.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: (message) => {
      if (process.env.SKYLINE_PG_VERBOSE) console.error(String(message));
    },
  });

  let exitCode = 1;
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("skyline_test");
    const url = `postgres://skyline:${password}@127.0.0.1:${port}/skyline_test`;
    const report = await migratePostgres(url);
    console.log(`[with-postgres] PostgreSQL on 127.0.0.1:${port}, schema version ${report.after}`);

    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          DATABASE_URL: url,
          DATABASE_URL_UNPOOLED: url,
          SKYLINE_DB_DRIVER: "postgres",
          SKYLINE_TEST_DB: "postgres",
        },
      });
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  } finally {
    await postgres.stop().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
