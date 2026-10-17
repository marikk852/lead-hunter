/**
 * Writing values back into `.env` from the Settings screen.
 *
 * `.env` stays the single source of truth for secrets (README §6 Rule 6), so
 * the UI edits exactly the file `@next/env`, the CLI scripts and a fresh clone
 * read — no second store, no schema migration, and `npm run ai:check` sees
 * whatever was typed into the form.
 *
 * Two house rules from AGENTS.md are enforced here:
 *  - a value never contains `$`: `@next/env` and dotenv expand `$VAR` inside
 *    values (quotes do not protect against it), which would silently truncate
 *    the key;
 *  - the write is atomic (sibling temp file + rename), so an interrupted save
 *    cannot leave a half-written configuration behind.
 */
import { readFile, rename, writeFile } from "node:fs/promises";

/** Every vendor key seen so far is far below this; the cap only bounds junk. */
const MAX_KEY_LENGTH = 512;

export type KeyRejection = "empty" | "tooLong" | "dollar" | "control";

export type SanitizedKey = { ok: true; value: string } | { ok: false; reason: KeyRejection };

/** Trim + reject everything `.env` cannot represent faithfully. */
export function sanitizeApiKey(raw: unknown): SanitizedKey {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_KEY_LENGTH) return { ok: false, reason: "tooLong" };
  // `AI_API_KEY="…$…"` would expand `…$VAR` on the next load and truncate the key.
  if (value.includes("$")) return { ok: false, reason: "dollar" };
  // Newlines and other control characters cannot live on one `NAME=` line.
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: "control" };
  return { ok: true, value };
}

/**
 * Sets `NAME="value"` in `filePath` (or `NAME=` when `value` is null), leaving
 * every other line — comments, hand-written secrets — intact byte for byte.
 * Writes through a sibling temp file and renames, so no reader ever observes
 * a partial file.
 */
export async function setEnvValue(
  filePath: string,
  name: string,
  value: string | null,
): Promise<void> {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = ""; // first save: Settings creates the file it was told to edit
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const hadFinalNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadFinalNewline) lines.pop();

  // JSON.stringify adds the double quotes and escapes anything inside them;
  // dotenv reads the result back as the original value.
  const rendered = `${name}=${value === null ? "" : JSON.stringify(value)}`;
  const prefix = `${name}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    replaced = true;
    return rendered;
  });
  if (!replaced) next.push(rendered);

  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${next.join("\n")}${next.length > 0 ? "\n" : ""}`, "utf8");
  await rename(tmpPath, filePath);
}