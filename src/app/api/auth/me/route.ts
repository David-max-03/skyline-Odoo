import { dbKind } from "@/server/db";
import { publicRoute } from "@/server/http";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, seedIfEmptyInDevelopment } from "@/server/seed";

/** Who is signed in. Also tells the login page whether to show the demo sign-ins. */
export const GET = publicRoute({}, async ({ user }) => {
  await seedIfEmptyInDevelopment();
  // Demo sign-ins are only ever shown for a local SQLite database, which is the only place they can exist.
  const demoMode = (await dbKind()) === "sqlite" && (process.env.NODE_ENV !== "production" || process.env.SKYLINE_DEMO_MODE === "1");
  return {
    user,
    demo: demoMode ? { accounts: DEMO_ACCOUNTS, password: DEMO_PASSWORD } : null,
  };
});
