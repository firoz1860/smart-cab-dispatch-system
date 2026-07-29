// Cookie-based auth requires CORS to name specific allowed origins - a
// wildcard ("*") is rejected by browsers for credentialed requests. Any
// localhost port is allowed for dev (Vite auto-increments if one is taken),
// plus whatever's listed in CORS_ORIGIN for non-local deployments.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;

const extraOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, mobile apps, server-to-server) send no Origin header
  return LOCALHOST_ORIGIN.test(origin) || extraOrigins.includes(origin);
}
