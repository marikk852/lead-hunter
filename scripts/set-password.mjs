#!/usr/bin/env node
/**
 * Generates an scrypt hash for OWNER_PASSWORD_HASH (README §34).
 *
 * Usage:
 *   npm run set-password            # prompts, invisibly
 *   npm run set-password -- --write # also writes it into .env
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { stdin, stdout } from "node:process";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

// Colon-separated, base64url: a `$` inside a .env value is treated as a
// variable reference by @next/env and dotenv, which corrupts the hash.
function hash(password) {
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

async function promptHidden(question) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const original = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (chunk) => {
    if (chunk.includes(question)) original?.(chunk);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = await promptHidden("New owner password: ");

if (!password || password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const digest = hash(password);

if (process.argv.includes("--write")) {
  const path = ".env";
  if (!existsSync(path)) {
    console.error("No .env found. Create one from .env.example first.");
    process.exit(1);
  }
  const contents = readFileSync(path, "utf8");
  const line = `OWNER_PASSWORD_HASH=${digest}`;
  const updated = /^OWNER_PASSWORD_HASH=.*$/m.test(contents)
    ? contents.replace(/^OWNER_PASSWORD_HASH=.*$/m, line)
    : `${contents}\n${line}\n`;
  writeFileSync(path, updated);
  console.log("Wrote OWNER_PASSWORD_HASH into .env");
  console.log("Clear OWNER_PASSWORD so the plaintext fallback stops working.");
} else {
  console.log("\nAdd this to .env (quotes and escaping are unnecessary):\n");
  console.log(`OWNER_PASSWORD_HASH=${digest}\n`);
}
