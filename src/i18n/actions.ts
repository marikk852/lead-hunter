"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, isLocale } from "@/src/i18n/config";
import { logger } from "@/src/lib/logger";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Persists the owner's language choice. Reachable the same way as any action. */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const requested = String(formData.get("locale") ?? "");

  if (!isLocale(requested)) {
    logger.warn("rejected unknown locale", { requested });
    return;
  }

  const store = await cookies();
  store.set(LOCALE_COOKIE, requested, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
    // Not httpOnly: this is a display preference, never a credential.
  });

  // Every server component re-reads the dictionary, so refresh the whole tree.
  revalidatePath("/", "layout");
  logger.info("ui locale changed", { locale: requested });
}
