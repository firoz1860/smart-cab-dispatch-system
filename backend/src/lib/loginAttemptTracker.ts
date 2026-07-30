/**
 * Per-account brute-force lockout, isolated behind an interface (Dependency
 * Inversion) so AuthService (see authService.ts) never talks to a concrete
 * Map directly. `InMemoryLoginAttemptTracker` is correct for a single
 * backend process; a horizontally-scaled deployment (multiple backend
 * instances behind a load balancer) would need a shared-storage
 * implementation instead (e.g. Redis, using INCR + EXPIRE) so an attacker
 * can't bypass the lockout just by getting routed to a different instance -
 * that's a new class implementing this same interface, not a rewrite of
 * AuthService or the login route.
 */
export interface LoginAttemptTracker {
  isLockedOut(key: string): boolean;
  recordFailure(key: string): void;
  clear(key: string): void;
}

interface AttemptRecord {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

export class InMemoryLoginAttemptTracker implements LoginAttemptTracker {
  private attempts = new Map<string, AttemptRecord>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly lockoutMs: number
  ) {}

  isLockedOut(key: string): boolean {
    const record = this.attempts.get(key);
    if (!record?.lockedUntil) return false;
    if (Date.now() > record.lockedUntil) {
      this.attempts.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const record = this.attempts.get(key);
    if (!record || now - record.firstAttemptAt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstAttemptAt: now });
      return;
    }
    record.count += 1;
    if (record.count >= this.limit) {
      record.lockedUntil = now + this.lockoutMs;
    }
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

const FAILED_ATTEMPT_LIMIT = 5;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

export const loginAttemptTracker: LoginAttemptTracker = new InMemoryLoginAttemptTracker(
  FAILED_ATTEMPT_LIMIT,
  FAILED_ATTEMPT_WINDOW_MS,
  LOCKOUT_MS
);
