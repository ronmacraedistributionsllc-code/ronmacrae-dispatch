import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RiderDto, UserDto } from "@ronmacrae/contracts";
import { apiFetch, onSessionExpires, setAccessToken } from "./api.js";

/** sessionStorage key for a merchant-portal session — shared with
 *  merchant-portal.tsx, which reads this same key on mount. Kept here
 *  (not imported from that page) since login.tsx needs to write it
 *  without pulling in the whole merchant-portal page module. */
export const MERCHANT_PORTAL_TOKEN_KEY = "merchantPortalToken";

export type LoginOutcome =
  | { workspace: "staff" }
  | { workspace: "merchant" }
  | { workspace: "select"; options: { type: "merchant"; id: string; name: string }[] };

interface LoginResponse {
  workspace: "staff" | "merchant" | "select";
  // staff
  user?: UserDto;
  riderId?: string | null;
  accessToken?: string;
  // merchant
  token?: string;
  merchant?: { id: string; name: string };
  // select
  options?: { type: "merchant"; id: string; name: string }[];
}

export interface AuthState {
  user: UserDto | null;
  rider: RiderDto | null;
  /** Merchant workspaces this same account also has access to — shows up
   *  as a "Switch workspace" control (see layout.tsx) whenever non-empty. */
  otherWorkspaces: { type: "merchant"; id: string; name: string }[];
  loading: boolean;
  /** One shared sign-in for every kind of account (spec: "no separate
   *  rider, merchant, logistics, or admin login pages") — the caller
   *  (login.tsx) inspects the returned `workspace` to decide where to go
   *  next; this function itself only ever updates the *staff* session
   *  state, since a "merchant" outcome routes to an entirely separate
   *  portal with its own session (see merchant-portal.tsx). Pass
   *  `merchantId` to finalize a previous "select" outcome. */
  login: (identifier: string, password: string, totpCode?: string, merchantId?: string) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
  /** Re-checks the current session — used after `setAccessToken()` is
   *  called directly (the merchant-portal's "Switch to staff" control:
   *  POST /api/merchant-portal/switch-to-staff returns a bare access
   *  token, no login() call involved, so this app's own `user` state
   *  needs an explicit nudge to notice it). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<UserDto | null>(null);
  const [rider, setRider] = useState<RiderDto | null>(null);
  const [otherWorkspaces, setOtherWorkspaces] = useState<{ type: "merchant"; id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const me = await apiFetch<{ user: UserDto; rider: RiderDto | null; otherWorkspaces: { type: "merchant"; id: string; name: string }[] }>("/auth/me");
      setUser(me.user);
      setRider(me.rider);
      setOtherWorkspaces(me.otherWorkspaces ?? []);
    } catch {
      setUser(null);
      setRider(null);
      setOtherWorkspaces([]);
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
    async (identifier: string, password: string, totpCode?: string, merchantId?: string): Promise<LoginOutcome> => {
      const body = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password, ...(totpCode ? { totpCode } : {}), ...(merchantId ? { merchantId } : {}) }),
      });
      if (body.workspace === "select") {
        return { workspace: "select", options: body.options ?? [] };
      }
      if (body.workspace === "merchant") {
        sessionStorage.setItem(MERCHANT_PORTAL_TOKEN_KEY, body.token!);
        return { workspace: "merchant" };
      }
      setAccessToken(body.accessToken!);
      setUser(body.user!);
      // Login returns only riderId; load the full rider DTO needed by the rider dashboard.
      await loadMe();
      return { workspace: "staff" };
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
    setOtherWorkspaces([]);
  }, []);

  const value = useMemo(
    () => ({ user, rider, otherWorkspaces, loading, login, logout, refresh: loadMe }),
    [user, rider, otherWorkspaces, loading, login, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
