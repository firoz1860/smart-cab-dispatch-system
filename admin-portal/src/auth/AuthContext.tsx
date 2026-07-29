import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { api } from "../api/client";

export type Role = "ADMIN" | "DRIVER";

interface Session {
  token: string;
  role: Role;
  name: string;
  driverId?: string;
}

interface AuthContextValue {
  session: Session | null;
  login: (phone: string, pin: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadSession(): Session | null {
  const raw = localStorage.getItem("scds_session");
  return raw ? JSON.parse(raw) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);

  const login = useCallback(async (phone: string, pin: string) => {
    const res = await api.post<{ token: string; role: Role; name: string; driverId?: string }>(
      "/auth/login",
      { phone, pin }
    );
    if (res.role !== "ADMIN" && res.role !== "DRIVER") {
      throw new Error("This portal is for Admin/Operations and Driver logins only.");
    }
    const newSession: Session = { token: res.token, role: res.role, name: res.name, driverId: res.driverId };
    localStorage.setItem("scds_token", newSession.token);
    localStorage.setItem("scds_session", JSON.stringify(newSession));
    setSession(newSession);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("scds_token");
    localStorage.removeItem("scds_session");
    setSession(null);
  }, []);

  return <AuthContext.Provider value={{ session, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
