/**
 * Session token signing, kept free of Next.js imports so it can be unit tested
 * and reused by workers/CLI scripts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/src/lib/env";

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

type SessionPayload = { v: 1; iat: number; exp: number };

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(now = Date.now(), secret = env().SESSION_SECRET): string {
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    v: 1,
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(
  token: string | undefined | null,
  now = Date.now(),
  secret = env().SESSION_SECRET,
): boolean {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return false;

  const givenBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(sign(encoded, secret));
  if (givenBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(givenBuf, expectedBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (payload.v !== 1) return false;
    return payload.exp * 1000 > now;
  } catch {
    return false;
  }
}
