/**
 * Minimal in-memory throttle for login attempts.
 * Single-process, single-owner tool → an in-memory window is sufficient and
 * avoids adding a dependency. Survives nothing; that is acceptable here.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;

const failures = new Map<string, number[]>();

export function isThrottled(key = "owner", now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILURES;
}

export function registerFailure(key = "owner", now = Date.now()): void {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
}

export function clearFailures(key = "owner"): void {
  failures.delete(key);
}
