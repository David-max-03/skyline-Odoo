"use client";

import { createContext, useContext, type ReactNode } from "react";
import { can, type CAN, type SessionUser } from "@/lib/contracts";

/**
 * The signed-in staff member, for pages under /org.
 *
 * This only decides what the UI shows. Whether an action is allowed is decided
 * by the server on every request, from the session, never from this value.
 */
const SessionContext = createContext<SessionUser | null>(null);

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionUser {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useSession must be used inside the /org layout");
  return user;
}

/** True when the signed-in role may perform `action`. For hiding controls only. */
export function useCan(action: keyof typeof CAN): boolean {
  return can(useContext(SessionContext), action);
}
