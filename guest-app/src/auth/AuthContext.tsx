import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { closeSocket } from "../api/socket";

interface Session {
  role: "GUEST";
  name: string;
  guestId: string;
}

export interface SignupInput {
  name: string;
  phone: string;
  pin: string;
}

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  login: (phone: string, pin: string) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type AuthResponse = { role: string; name: string; guestId?: string };

// This app is guest-only. An ADMIN/DRIVER cookie is a valid session but not one
// this UI can render, so we reject it (and clear its cookie) rather than render
// a broken dashboard.
function toGuestSession(res: AuthResponse): Session | null {
  if (res.role !== "GUEST" || !res.guestId) return null;
  return { role: "GUEST", name: res.name, guestId: res.guestId };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Starts true: the session lives in an httpOnly cookie, invisible to this JS,
  // so on first load we must ask the server (which can read the cookie) before
  // deciding whether to show the login form or the app.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<AuthResponse | null>("/auth/me")
      .then((res) => {
        if (res) setSession(toGuestSession(res));
      })
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (phone: string, pin: string) => {
    const res = await api.post<AuthResponse>("/auth/login", { phone, pin });
    const guestSession = toGuestSession(res);
    if (!guestSession) {
      // Valid credentials for a non-guest account: clear the cookie we were
      // just issued so it can't linger, and tell the user plainly.
      await api.post("/auth/logout").catch(() => {});
      throw new Error("This app is for registered event guests only.");
    }
    setSession(guestSession);
  }, []);

  const signup = useCallback(async ({ name, phone, pin }: SignupInput) => {
    const res = await api.post<AuthResponse>("/auth/signup", { name, phone, pin });
    const guestSession = toGuestSession(res);
    if (!guestSession) throw new Error("Sign-up failed. Please try again.");
    setSession(guestSession);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      closeSocket();
      setSession(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ session, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
