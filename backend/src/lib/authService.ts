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

export interface Registration {
  name: string;
  phone: string;
  pin: string;
}

export type RegisterResult =
  | { outcome: "OK"; identity: AuthenticatedIdentity }
  | { outcome: "PHONE_TAKEN" };

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

  /**
   * Self-service guest registration. Creates a Guest profile plus its linked
   * GUEST-role User (the auth record) in a single transaction so a half-made
   * account can never exist. The PIN is bcrypt-hashed exactly like seeded
   * accounts - the plaintext is never stored. Returns an identity ready to be
   * signed into a session, mirroring verifyCredentials' "OK" shape so the
   * route can issue a cookie and auto-sign-in the new guest.
   *
   * Driver and admin accounts are intentionally NOT registerable here: those
   * remain provisioned by organizers (seed/admin tooling), so the public
   * signup surface can only ever mint a least-privilege GUEST.
   */
  async registerGuest({ name, phone, pin }: Registration): Promise<RegisterResult> {
    // Phone is unique on BOTH User and Guest. Pre-checking gives a clean 409
    // instead of a 500 in the common case; the transaction's catch below still
    // guards the race where two signups for the same phone arrive at once.
    const [existingUser, existingGuest] = await Promise.all([
      prisma.user.findUnique({ where: { phone } }),
      prisma.guest.findUnique({ where: { phone } }),
    ]);
    if (existingUser || existingGuest) return { outcome: "PHONE_TAKEN" };

    const pinHash = await bcrypt.hash(pin, 10);

    try {
      const identity = await prisma.$transaction(async (tx) => {
        const guest = await tx.guest.create({
          data: { name, phone, partySize: 1, luggageCount: 1 },
        });
        const user = await tx.user.create({
          data: { role: "GUEST", phone, name, pinHash, guestId: guest.id },
        });
        return {
          userId: user.id,
          role: "GUEST" as Role,
          name: user.name,
          guestId: guest.id,
        } satisfies AuthenticatedIdentity;
      });
      return { outcome: "OK", identity };
    } catch (err) {
      // P2002 = unique-constraint violation: another request registered this
      // phone between our pre-check and insert. Treat as "already taken".
      if (err && typeof err === "object" && (err as { code?: string }).code === "P2002") {
        return { outcome: "PHONE_TAKEN" };
      }
      throw err;
    }
  }
}

export const authService = new AuthService();
