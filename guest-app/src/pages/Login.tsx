import { useState, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

// Pulls in @google/model-viewer (bundles three.js) - deferred to its own chunk
// so it's only downloaded after a successful sign-in, not on initial load of
// the login page itself.
const SignInIntro = lazy(() => import("../components/SignInIntro").then((m) => ({ default: m.SignInIntro })));

type Mode = "signin" | "signup";

// API errors arrive as JSON-stringified bodies (a quoted string for simple
// errors, or a zod "flatten" object for validation failures). Turn either into
// one readable sentence for the banner.
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
  const { login, signup } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  const isSignup = mode === "signup";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isSignup && pin !== confirmPin) {
      setError("The two PINs don't match.");
      return;
    }
    setLoading(true);
    try {
      if (isSignup) {
        await signup({ name: name.trim(), phone: phone.trim(), pin });
      } else {
        await login(phone.trim(), pin);
      }
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
            <h2>Your event travel,<br />all in one place.</h2>
            <p>Book pickups, track your driver live, and settle fares right from your phone.</p>
          </div>
          <ul className="auth-features">
            <li><span className="tick" aria-hidden="true">✓</span> Live driver tracking &amp; ETAs</li>
            <li><span className="tick" aria-hidden="true">✓</span> One tap to request a ride</li>
            <li><span className="tick" aria-hidden="true">✓</span> Secure, cashless fare payment</li>
          </ul>
        </aside>

        <main className="auth-panel">
          <div className="auth-panel-brand">
            <span className="mark" aria-hidden="true">🚕</span>
            <span className="name">Smart Cab Dispatch</span>
          </div>

          <div className="auth-heading">
            <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
            <p>{isSignup ? "Sign up to request rides for the event." : "Sign in to manage your event rides."}</p>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Sign in or create an account">
            <button
              type="button"
              role="tab"
              aria-selected={!isSignup}
              className={`auth-tab ${!isSignup ? "is-active" : ""}`}
              onClick={() => switchMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isSignup}
              className={`auth-tab ${isSignup ? "is-active" : ""}`}
              onClick={() => switchMode("signup")}
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            {isSignup && (
              <div className="field">
                <label htmlFor="name">Full name</label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Priya Sharma"
                  autoComplete="name"
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. 92000000000"
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
                placeholder={isSignup ? "Choose a 4-8 digit PIN" : "Your PIN"}
                inputMode="numeric"
                autoComplete={isSignup ? "new-password" : "current-password"}
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

            {isSignup && (
              <div className="field">
                <label htmlFor="confirmPin">Confirm PIN</label>
                <input
                  id="confirmPin"
                  type={showPin ? "text" : "password"}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                  placeholder="Re-enter your PIN"
                  inputMode="numeric"
                  autoComplete="new-password"
                  required
                />
              </div>
            )}

            {error && <div className="auth-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={loading}>
              {loading
                ? isSignup
                  ? "Creating account…"
                  : "Signing in…"
                : isSignup
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          {!isSignup && (
            <div className="auth-hint">
              <strong>Demo guest login</strong>
              <span><code>92000000000</code> / <code>1234</code></span>
            </div>
          )}

          <div className="auth-foot">
            {isSignup ? (
              <>Already registered? <button type="button" onClick={() => switchMode("signin")}>Sign in</button></>
            ) : (
              <>New here? <button type="button" onClick={() => switchMode("signup")}>Create an account</button></>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
