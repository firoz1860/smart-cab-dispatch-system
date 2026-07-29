import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signToken, requireAuth, setAuthCookie, clearAuthCookie } from "../middleware/auth";

export const authRouter = Router();

const loginSchema = z.object({
  phone: z.string().min(3),
  pin: z.string().min(1),
});

// Coarse per-IP throttle against scripted brute-forcing.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this network. Please try again later." },
});

// Finer per-phone lockout on top of the IP limiter, since a distributed
// attacker (many IPs) could otherwise still hammer one specific account.
const FAILED_ATTEMPT_LIMIT = 5;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; firstAttemptAt: number; lockedUntil?: number }>();

function isLockedOut(phone: string): boolean {
  const record = failedAttempts.get(phone);
  if (!record?.lockedUntil) return false;
  if (Date.now() > record.lockedUntil) {
    failedAttempts.delete(phone);
    return false;
  }
  return true;
}

function recordFailedAttempt(phone: string): void {
  const now = Date.now();
  const record = failedAttempts.get(phone);
  if (!record || now - record.firstAttemptAt > FAILED_ATTEMPT_WINDOW_MS) {
    failedAttempts.set(phone, { count: 1, firstAttemptAt: now });
    return;
  }
  record.count += 1;
  if (record.count >= FAILED_ATTEMPT_LIMIT) {
    record.lockedUntil = now + LOCKOUT_MS;
  }
}

function clearFailedAttempts(phone: string): void {
  failedAttempts.delete(phone);
}

// A precomputed hash with no matching PIN, compared against on every
// "phone not found" path so that lookup and comparison always take
// comparable time - otherwise a missing user short-circuits before the
// (relatively slow) bcrypt.compare a real user takes, and that timing gap
// lets an attacker enumerate which phone numbers are actually registered.
const DUMMY_HASH = bcrypt.hashSync("no-such-account", 10);

authRouter.post("/login", loginRateLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { phone, pin } = parsed.data;

  if (isLockedOut(phone)) {
    return res.status(429).json({ error: "Too many failed attempts for this account. Please try again later." });
  }

  const user = await prisma.user.findUnique({ where: { phone } });
  const ok = await bcrypt.compare(pin, user?.pinHash ?? DUMMY_HASH);

  if (!user || !ok) {
    recordFailedAttempt(phone);
    return res.status(401).json({ error: "Invalid phone or PIN" });
  }
  clearFailedAttempts(phone);

  const token = signToken({
    userId: user.id,
    role: user.role as any,
    name: user.name,
    driverId: user.driverId ?? undefined,
    guestId: user.guestId ?? undefined,
  });

  // The JWT itself is never sent in the response body - only as an httpOnly
  // cookie, so it's inaccessible to any JavaScript running on the page
  // (including an XSS payload). The body just carries the non-secret display
  // info the frontend needs to render the right view.
  setAuthCookie(res, token);
  res.json({ role: user.role, name: user.name, driverId: user.driverId, guestId: user.guestId });
});

authRouter.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(req.auth ?? null);
});
