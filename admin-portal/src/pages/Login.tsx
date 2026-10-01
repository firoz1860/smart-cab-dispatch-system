import { useState, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

// Pulls in @google/model-viewer (bundles three.js) - deferred to its own chunk
// so it's only downloaded after a successful sign-in, not on initial load of
// the login page itself.
const SignInIntro = lazy(() => import("../components/SignInIntro").then((m) => ({ default: m.SignInIntro })));

// API errors arrive as JSON-stringified bodies (usually a quoted string). Strip
// the quoting so the banner shows a clean sentence.
function humanizeError(raw?: string): string {
  if (!raw) return "Something went wrong. Please try again.";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const field = parsed.fieldErrors && Object.values(parsed.fieldErrors).flat()[0];
      if (typeof field === "string") return field;
      const form = parsed.formErrors && parsed.formErrors[0];
      if (typeof form === "string") return form;
    }
  } catch {
    // Not JSON - already a plain message.
  }
  return raw;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(phone.trim(), pin);
      setShowIntro(true);
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : undefined));
      setLoading(false);
    }
  }

  if (showIntro) {
    return (
      <Suspense fallback={<div className="signin-intro" />}>
        <SignInIntro onDone={() => navigate("/")} />
      </Suspense>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-shell">
        <aside className="auth-hero">
          <div className="auth-hero-logo" aria-hidden="true">🚕</div>
          <div>
            <h2>Dispatch control<br />for your whole fleet.</h2>
            <p>Assign drivers, track rides live, and keep every guest moving — from one console.</p>
          </div>
          <ul className="auth-features">
            <li><span className="tick" aria-hidden="true">✓</span> Real-time fleet &amp; trip map</li>
            <li><span className="tick" aria-hidden="true">✓</span> Automatic driver matching</li>
            <li><span className="tick" aria-hidden="true">✓</span> One sign-in for Admin, Driver &amp; Guest</li>
          </ul>
        </aside>

        <main className="auth-panel">
          <div className="auth-panel-brand">
            <span className="mark" aria-hidden="true">🚕</span>
            <span className="name">Smart Cab Dispatch</span>
          </div>

          <div className="auth-heading">
            <h1>Sign in</h1>
            <p>One sign-in for Admin, Driver, and Guest.</p>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. 9000000001"
                inputMode="tel"
                autoComplete="tel"
                required
              />
            </div>

            <div className="field field-pin">
              <label htmlFor="pin">PIN</label>
              <input
                id="pin"
                type={showPin ? "text" : "password"}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="Your PIN"
                inputMode="numeric"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="pin-toggle"
                onClick={() => setShowPin((s) => !s)}
                aria-label={showPin ? "Hide PIN" : "Show PIN"}
              >
                {showPin ? "Hide" : "Show"}
              </button>
            </div>

            {error && <div className="auth-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="auth-hint">
            <strong>Demo logins</strong>
            <span>Admin — <code>9000000001</code> / <code>admin123</code></span>
            <span>Driver — <code>9010000000</code> / <code>1234</code></span>
            <span>Guest — <code>92000000000</code> / <code>1234</code></span>
          </div>

          <div className="auth-foot">Accounts are provisioned by your event organizer.</div>
        </main>
      </div>
    </div>
  );
}
