/**
 * Signed session cookie for the single owner (README §34).
 *
 * The token itself lives in ./token; this module is only the Next.js glue.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_MAX_AGE_SECONDS, createSessionToken, verifySessionToken } from "@/src/auth/token";
import { logger } from "@/src/lib/logger";

export const SESSION_COOKIE = "lh_session";

/** Reads the cookie and reports whether the request is an authenticated owner. */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function startSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * Guard for protected server components and server actions.
 * Server Actions are reachable by direct POST, so every action calls this too.
 */
export async function requireOwner(): Promise<void> {
  if (!(await isAuthenticated())) {
    logger.debug("unauthenticated access redirected to login");
    redirect("/login");
  }
}
