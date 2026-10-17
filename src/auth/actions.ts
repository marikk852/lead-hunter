"use server";

import { redirect } from "next/navigation";
import { clearFailures, isThrottled, registerFailure } from "@/src/auth/rate-limit";
import { endSession, startSession } from "@/src/auth/session";
import { safeEqual, verifyPassword } from "@/src/auth/password";
import { env } from "@/src/lib/env";
import { logger } from "@/src/lib/logger";

function configuredCredential(): { hash: string | null; plain: string | null } {
  const { OWNER_PASSWORD_HASH, OWNER_PASSWORD } = env();
  return {
    hash: OWNER_PASSWORD_HASH?.trim() || null,
    plain: OWNER_PASSWORD?.trim() || null,
  };
}

/**
 * Verifies the owner password and opens a session.
 * Server Actions are public POST endpoints, so the credential check happens
 * here — never in the client bundle (README §34).
 */
export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");

  if (isThrottled()) {
    logger.warn("login throttled");
    redirect("/login?error=throttled");
  }

  const { hash, plain } = configuredCredential();
  if (!hash && !plain) {
    logger.error("login attempted but no OWNER_PASSWORD(_HASH) is configured");
    redirect("/login?error=unconfigured");
  }

  const ok = hash
    ? verifyPassword(password, hash)
    : safeEqual(password, plain as string);

  if (!ok) {
    registerFailure();
    logger.warn("failed login attempt");
    redirect("/login?error=invalid");
  }

  clearFailures();
  await startSession();
  logger.info("owner signed in");
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  logger.info("owner signed out");
  redirect("/login");
}
