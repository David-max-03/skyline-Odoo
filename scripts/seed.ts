/**
 * Resets the database to the demo data set.
 *
 *   npm run seed              wipe everything and load the demo
 *   npm run seed -- --if-empty   only seed when there are no accounts yet
 */
import { countUsers } from "../src/server/auth";
import { dbFile } from "../src/server/db";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, seedDemoData } from "../src/server/seed";

const ifEmpty = process.argv.includes("--if-empty");

if (ifEmpty && countUsers() > 0) {
  console.log(`Database at ${dbFile()} already has accounts; left untouched.`);
} else {
  const summary = seedDemoData();
  console.log(`Seeded ${dbFile()}`);
  console.log(
    `  ${summary.members} members · ${summary.events} events · ${summary.tickets} tickets · ${summary.orders} merchandise orders`,
  );
  console.log("\nDemo sign-ins (password for all: " + DEMO_PASSWORD + ")");
  for (const account of DEMO_ACCOUNTS) {
    console.log(`  ${account.role.padEnd(10)} ${account.email}`);
  }
}
