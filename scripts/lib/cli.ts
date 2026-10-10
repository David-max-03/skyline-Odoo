/**
 * Shared pieces for the database commands. None of them print a connection
 * string, a password or any other secret.
 */
import fs from "node:fs";
import readline from "node:readline";

/** `--name value` and `--flag` from the command line. */
export function parseArgs(argv = process.argv.slice(2)): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      i++;
    } else {
      flags.add(arg.slice(2));
    }
  }
  return { flags, values };
}

/**
 * Loads variables from `--env-file <path>` when given. Keep production
 * connection strings in a Git-ignored file such as `.env.neon`,
 * not in the shell history and never in a tracked file.
 */
export function loadEnvFile(values: Map<string, string>): void {
  const file = values.get("env-file");
  if (!file) return;
  if (!fs.existsSync(file)) throw new Error(`Env file not found: ${file}`);
  process.loadEnvFile(file);
}

/** The connection string for schema changes: the direct one when set, else the pooled one. */
export function migrationUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to the PostgreSQL connection string. Nothing was done.");
  }
  return url;
}

/** Where a connection string points, without the user, password or query. Safe to print. */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/** Reads a line without showing it. Falls back to piped input when there is no terminal. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Swallow the echo of what is typed.
    const write = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(rl);
    let shown = false;
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!shown) {
        write(text);
        shown = true;
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

export function fail(error: unknown): never {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
