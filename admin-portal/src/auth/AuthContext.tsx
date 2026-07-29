import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { api, ApiError } from "../api/client";

export type Role = "ADMIN" | "DRIVER" | "GUEST";

interface Session {
  role: Role;
  name: string;
  driverId?: string;
  guestId?: string;
}

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  login: (phone: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

type MeResponse = { role: Role; name: string; driverId?: string; guestId?: string };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Starts true: the session lives in an httpOnly cookie, invisible to this
  // JS, so on first load we don't yet know if the user is signed in - we
  // have to ask the server (which can read the cookie) before deciding
  // whether to show the login form or the app.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<MeResponse | null>("/auth/me")
      .then((res) => {
        if (res) setSession({ role: res.role, name: res.name, driverId: res.driverId, guestId: res.guestId });
      })
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (phone: string, pin: string) => {
    const res = await api.post<MeResponse>("/auth/login", { phone, pin });
    setSession({ role: res.role, name: res.name, driverId: res.driverId, guestId: res.guestId });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      setSession(null);
    }
  }, []);

  return <AuthContext.Provider value={{ session, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
