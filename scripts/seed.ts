/**
 * Resets the database to the demo data set.
 *
 *   npm run seed              wipe everything and load the demo
 *   npm run seed -- --if-empty   only seed when there are no accounts yet
 */
import { countUsers } from "../src/server/auth";
import { closeDb, dbFile, dbKind } from "../src/server/db";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, seedDemoData } from "../src/server/seed";

const ifEmpty = process.argv.includes("--if-empty");

async function main(): Promise<void> {
  // The demo data wipes everything first and its accounts share a published
  // password, so it is for a local SQLite file only, never a PostgreSQL database.
  if ((await dbKind()) !== "sqlite") {
    throw new Error("The demo seed only runs against a local SQLite database. It is refused on PostgreSQL.");
  }
  if (ifEmpty && (await countUsers()) > 0) {
    console.log(`Database at ${dbFile()} already has accounts; left untouched.`);
    return;
  }
  const summary = await seedDemoData();
  console.log(`Seeded ${dbFile()}`);
  console.log(
    `  ${summary.members} members · ${summary.events} events · ${summary.tickets} tickets · ${summary.orders} merchandise orders`,
  );
  console.log("\nDemo sign-ins (password for all: " + DEMO_PASSWORD + ")");
  for (const account of DEMO_ACCOUNTS) {
    console.log(`  ${account.role.padEnd(10)} ${account.email}`);
  }
}

main()
  .then(() => closeDb())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
