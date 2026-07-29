import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { api } from "../api/client";

interface Session {
  token: string;
  name: string;
  guestId: string;
}

interface AuthContextValue {
  session: Session | null;
  login: (phone: string, pin: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadSession(): Session | null {
  const raw = localStorage.getItem("scds_guest_session");
  return raw ? JSON.parse(raw) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);

  const login = useCallback(async (phone: string, pin: string) => {
    const res = await api.post<{ token: string; role: string; name: string; guestId?: string }>(
      "/auth/login",
      { phone, pin }
    );
    if (res.role !== "GUEST" || !res.guestId) {
      throw new Error("This app is for registered event guests only.");
    }
    const newSession: Session = { token: res.token, name: res.name, guestId: res.guestId };
    localStorage.setItem("scds_guest_token", newSession.token);
    localStorage.setItem("scds_guest_session", JSON.stringify(newSession));
    setSession(newSession);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("scds_guest_token");
    localStorage.removeItem("scds_guest_session");
    setSession(null);
  }, []);

  return <AuthContext.Provider value={{ session, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
