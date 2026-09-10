import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RiderDto, UserDto } from "@ronmacrae/contracts";
import { apiFetch, onSessionExpires, setAccessToken } from "./api.js";

export interface AuthState {
  user: UserDto | null;
  rider: RiderDto | null;
  loading: boolean;
  login: (identifier: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<UserDto | null>(null);
  const [rider, setRider] = useState<RiderDto | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const me = await apiFetch<{ user: UserDto; rider: RiderDto | null }>("/auth/me");
      setUser(me.user);
      setRider(me.rider);
    } catch {
      setUser(null);
      setRider(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // restore the session from the httpOnly refresh cookie on first load
    void loadMe();
    onSessionExpires(() => {
      setUser(null);
      setRider(null);
    });
    return () => onSessionExpires(null);
  }, [loadMe]);

  const login = useCallback(
    async (identifier: string, password: string, totpCode?: string) => {
      const body = await apiFetch<{ user: UserDto; riderId: string | null; accessToken: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password, ...(totpCode ? { totpCode } : {}) }),
      });
      setAccessToken(body.accessToken);
      setUser(body.user);
      // Login returns only riderId; load the full rider DTO needed by the rider dashboard.
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // session is cleared client-side regardless
    }
    setAccessToken(null);
    setUser(null);
    setRider(null);
  }, []);

  const value = useMemo(
    () => ({ user, rider, loading, login, logout }),
    [user, rider, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
