import { useState, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

// Pulls in @google/model-viewer (bundles three.js) - deferred to its own
// chunk so it's only downloaded after a successful sign-in, not on initial
// load of the login page itself.
const SignInIntro = lazy(() => import("../components/SignInIntro").then((m) => ({ default: m.SignInIntro })));

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(phone, pin);
      setShowIntro(true);
    } catch (err: any) {
      setError(err.message ?? "Login failed");
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
    <div className="centered-page">
      <form className="card login-card" onSubmit={handleSubmit}>
        <div className="login-header">
          <span className="brand-mark">🚕</span>
          <h1>Smart Cab Dispatch</h1>
          <p className="subtitle">One sign-in for Admin, Driver, and Guest</p>
        </div>
        <label>
          Phone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 9000000001" required />
        </label>
        <label>
          PIN
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            required
          />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <div className="demo-hint">
          <strong>Demo logins</strong>
          <span>Admin — <code>9000000001</code> / <code>admin123</code></span>
          <span>Driver — <code>9010000000</code> / <code>1234</code></span>
          <span>Guest — <code>92000000000</code> / <code>1234</code></span>
        </div>
      </form>
    </div>
  );
}
