import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import type { Role } from "./constants";
import type { LoginAttemptTracker } from "./loginAttemptTracker";
import { loginAttemptTracker } from "./loginAttemptTracker";

export interface Credentials {
  phone: string;
  pin: string;
}

export interface AuthenticatedIdentity {
  userId: string;
  role: Role;
  name: string;
  driverId?: string;
  guestId?: string;
}

export type VerifyResult =
  | { outcome: "OK"; identity: AuthenticatedIdentity }
  | { outcome: "LOCKED" }
  | { outcome: "INVALID" };

// A precomputed hash with no matching PIN, compared against on every
// "phone not found" path so lookup and comparison always take comparable
// time - otherwise a missing user short-circuits before the (relatively
// slow) bcrypt.compare a real user takes, and that timing gap lets an
// attacker enumerate which phone numbers are actually registered.
const DUMMY_HASH = bcrypt.hashSync("no-such-account", 10);

/**
 * Single Responsibility: this class answers exactly one question - "are
 * these credentials valid, and is this account allowed to try right now?"
 * It knows nothing about HTTP, cookies, or JWTs (see routes/auth.ts and
 * middleware/auth.ts for those) and depends on the LoginAttemptTracker
 * *interface* rather than constructing its own lockout storage (Dependency
 * Inversion) - the constructor takes one in, defaulting to the shared
 * in-memory singleton so existing call sites don't need to change, but a
 * test (or a future Redis-backed deployment) can inject a different one.
 */
export class AuthService {
  constructor(private readonly attemptTracker: LoginAttemptTracker = loginAttemptTracker) {}

  async verifyCredentials({ phone, pin }: Credentials): Promise<VerifyResult> {
    if (this.attemptTracker.isLockedOut(phone)) {
      return { outcome: "LOCKED" };
    }

    const user = await prisma.user.findUnique({ where: { phone } });
    const ok = await bcrypt.compare(pin, user?.pinHash ?? DUMMY_HASH);

    if (!user || !ok) {
      this.attemptTracker.recordFailure(phone);
      return { outcome: "INVALID" };
    }

    this.attemptTracker.clear(phone);
    return {
      outcome: "OK",
      identity: {
        userId: user.id,
        role: user.role as Role,
        name: user.name,
        driverId: user.driverId ?? undefined,
        guestId: user.guestId ?? undefined,
      },
    };
  }
}

export const authService = new AuthService();
