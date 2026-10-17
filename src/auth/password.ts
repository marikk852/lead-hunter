/**
 * Owner credential hashing. Uses Node's built-in scrypt so the project needs no
 * native crypto dependency (README §34 "secure password hashing").
 *
 * Stored format: `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`
 *
 * The separator is `:` rather than the conventional `$` on purpose. Both
 * @next/env and dotenv perform `$VAR` expansion inside .env values — even
 * inside single quotes — so `scrypt$16384$8$1$…` is silently rewritten to
 * `scrypt6384` before the app ever sees it, which makes sign-in impossible.
 * A dollar-free encoding removes that whole class of bug. `$`-separated hashes
 * are still accepted on verify so previously generated ones keep working.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return [
    "scrypt",
    String(N),
    String(R),
    String(P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join(":");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.trim().split(/[:$]/);
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n <= 0 || r <= 0 || p <= 0) return false;

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = scryptSync(password, salt, expected.length, { N: n, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Constant-time string comparison for the plaintext dev fallback. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
