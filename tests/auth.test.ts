import { scryptSync } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { hashPassword, safeEqual, verifyPassword } from "@/src/auth/password";
import { createSessionToken, verifySessionToken } from "@/src/auth/token";
import { clearFailures, isThrottled, registerFailure } from "@/src/auth/rate-limit";

const SECRET = "unit-test-secret-value-long-enough";

describe("password hashing", () => {
  it("round-trips a password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("uses an encoding that survives .env loading", () => {
    // `$` is expanded as a variable reference by @next/env and dotenv, even
    // inside quotes, which silently corrupts a stored hash.
    const stored = hashPassword("whatever");
    expect(stored).not.toContain("$");
    expect(stored).not.toContain('"');
    expect(stored).not.toContain("'");
  });

  it("still verifies legacy `$`-separated hashes", () => {
    const legacy = [
      "scrypt",
      "16384",
      "8",
      "1",
      Buffer.from("0123456789abcdef").toString("base64url"),
      Buffer.from(scryptSync("legacy-pass", Buffer.from("0123456789abcdef"), 64, { N: 16384, r: 8, p: 1 })).toString("base64url"),
    ].join("$");
    expect(verifyPassword("legacy-pass", legacy)).toBe(true);
    expect(verifyPassword("nope", legacy)).toBe(false);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("uses a fresh salt each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("never stores the plaintext", () => {
    const stored = hashPassword("supersecretpassword");
    expect(stored).not.toContain("supersecretpassword");
  });

  it("rejects a malformed hash instead of throwing", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$a$b$c$d$e")).toBe(false);
  });

  it("compares plaintext fallbacks safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("session tokens", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");

  it("accepts a freshly issued token", () => {
    const token = createSessionToken(now, SECRET);
    expect(verifySessionToken(token, now, SECRET)).toBe(true);
  });

  it("carries no readable session state beyond an expiry", () => {
    const token = createSessionToken(now, SECRET);
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "v"]);
  });

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken(now, SECRET);
    expect(verifySessionToken(token, now, "a-different-secret-value")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken(now, SECRET);
    const [encoded, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, iat: 0, exp: Math.floor(now / 1000) + 99999 }),
      "utf8",
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`, now, SECRET)).toBe(false);
    expect(verifySessionToken(`${encoded}.${signature}x`, now, SECRET)).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = createSessionToken(now, SECRET);
    const later = now + 31 * 24 * 60 * 60 * 1000;
    expect(verifySessionToken(token, later, SECRET)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(verifySessionToken(undefined, now, SECRET)).toBe(false);
    expect(verifySessionToken("", now, SECRET)).toBe(false);
    expect(verifySessionToken("onlyonetoken", now, SECRET)).toBe(false);
    expect(verifySessionToken("a.b.c", now, SECRET)).toBe(false);
  });
});

describe("login throttle", () => {
  beforeEach(() => clearFailures());

  it("blocks after repeated failures and recovers after the window", () => {
    const start = Date.parse("2026-10-15T12:00:00Z");
    expect(isThrottled("owner", start)).toBe(false);

    for (let i = 0; i < 8; i += 1) registerFailure("owner", start);
    expect(isThrottled("owner", start)).toBe(true);

    // Still blocked inside the window...
    expect(isThrottled("owner", start + 5 * 60_000)).toBe(true);
    // ...and clear once the window has passed.
    expect(isThrottled("owner", start + 11 * 60_000)).toBe(false);
  });

  it("clears failures after a successful sign-in", () => {
    const start = Date.parse("2026-10-15T12:00:00Z");
    for (let i = 0; i < 8; i += 1) registerFailure("owner", start);
    clearFailures("owner");
    expect(isThrottled("owner", start)).toBe(false);
  });
});
