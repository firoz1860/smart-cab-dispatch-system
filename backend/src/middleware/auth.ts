import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "../lib/constants";

export interface AuthPayload {
  userId: string;
  role: Role;
  name: string;
  driverId?: string;
  guestId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// httpOnly cookie is the primary session mechanism (see routes/auth.ts) so the
// JWT is never reachable from JavaScript - an XSS payload can't read
// document.cookie for an httpOnly cookie, unlike a token kept in
// localStorage/sessionStorage. The Bearer header is still accepted as a
// fallback for non-browser API access (curl, tests, tooling).
export const AUTH_COOKIE_NAME = "scds_session";
const AUTH_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h, matches signToken's expiry

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "12h" });
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
}

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Not signed in" });
  }
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Forbidden for this role" });
    }
    next();
  };
}
