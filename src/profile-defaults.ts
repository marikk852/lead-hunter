/**
 * Seed values for the owner profile (README §16).
 * Kept in its own module so the seed script can import it without pulling in
 * the database client.
 */
/** One portfolio item, as stored in the `portfolio` JSON column. */
export type PortfolioEntry = { title?: string; url?: string; description?: string };

export const DEFAULT_PROFILE = {
  name: "Developer",
  services: ["WordPress", "WooCommerce", "PHP", "Next.js", "React", "Telegram bots"],
  experience: null as string | null,
  location: "Moldova",
  languages: ["English", "Romanian", "Russian"],
  minimumBudget: 300,
  portfolio: [] as PortfolioEntry[],
  tone: null as string | null,
};
