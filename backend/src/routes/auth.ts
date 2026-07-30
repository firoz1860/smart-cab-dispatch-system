import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { signToken, requireAuth, setAuthCookie, clearAuthCookie } from "../middleware/auth";
import { authService } from "../lib/authService";

export const authRouter = Router();

const loginSchema = z.object({
  phone: z.string().min(3),
  pin: z.string().min(1),
});

// Coarse per-IP throttle against scripted brute-forcing. This is on top of
// (not instead of) AuthService's per-phone lockout - see lib/authService.ts
// and lib/loginAttemptTracker.ts - since a distributed attacker rotating
// IPs could otherwise bypass a purely per-IP limit to brute-force one
// specific account.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this network. Please try again later." },
});

// This handler's only job is HTTP orchestration: parse the request, ask
// AuthService whether the credentials are valid, and translate its answer
// into a status code + cookie + response body. All the actual security
// logic (timing-safe comparison, lockout policy) lives in AuthService,
// which knows nothing about Express - it's testable and reusable on its own.
authRouter.post("/login", loginRateLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await authService.verifyCredentials(parsed.data);

  if (result.outcome === "LOCKED") {
    return res.status(429).json({ error: "Too many failed attempts for this account. Please try again later." });
  }
  if (result.outcome === "INVALID") {
    return res.status(401).json({ error: "Invalid phone or PIN" });
  }

  const { identity } = result;
  const token = signToken(identity);

  // The JWT itself is never sent in the response body - only as an httpOnly
  // cookie, so it's inaccessible to any JavaScript running on the page
  // (including an XSS payload). The body just carries the non-secret display
  // info the frontend needs to render the right view.
  setAuthCookie(res, token);
  res.json({ role: identity.role, name: identity.name, driverId: identity.driverId, guestId: identity.guestId });
});

authRouter.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(req.auth ?? null);
});
