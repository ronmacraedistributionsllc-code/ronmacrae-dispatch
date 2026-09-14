import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RiderDto, UserDto } from "@ronmacrae/contracts";
import { apiFetch, onSessionExpires, setAccessToken } from "./api.js";
import { applyRemoteTheme } from "./theme.js";

/** sessionStorage key for a merchant-portal session — shared with
 *  merchant-portal.tsx, which reads this same key on mount. Kept here
 *  (not imported from that page) since login.tsx needs to write it
 *  without pulling in the whole merchant-portal page module. */
export const MERCHANT_PORTAL_TOKEN_KEY = "merchantPortalToken";
/** Same idea, for a logistics-company portal session — see logistics-portal.tsx. */
export const LOGISTICS_PORTAL_TOKEN_KEY = "logisticsPortalToken";

type Workspace = { type: "merchant" | "logistics"; id: string; name: string };

export type LoginOutcome =
  | { workspace: "staff" }
  | { workspace: "merchant" }
  | { workspace: "logistics" }
  | { workspace: "select"; options: Workspace[] };

interface LoginResponse {
  workspace: "staff" | "merchant" | "logistics" | "select";
  // staff
  user?: UserDto;
  riderId?: string | null;
  accessToken?: string;
  // merchant
  token?: string;
  merchant?: { id: string; name: string };
  // logistics
  logisticsCompany?: { id: string; name: string };
  // select
  options?: Workspace[];
}

export interface AuthState {
  user: UserDto | null;
  rider: RiderDto | null;
  /** Merchant/logistics workspaces this same account also has access to —
   *  shows up as a "Switch workspace" control (see layout.tsx) whenever
   *  non-empty. */
  otherWorkspaces: Workspace[];
  /** This session's own real staff business, if any (roles/memberships:
   *  "one account, multiple roles" — a courier who is ALSO a dispatcher
   *  gets a real businessId here too, from the same token, no separate
   *  "switch" step; see resolveStaffContext's own doc comment in
   *  auth.ts). Null for a rider-only account, exactly as before this
   *  existed — nothing changes for the common case. */
  businessId: string | null;
  /** The role actually granted for THIS session's chosen business — same
   *  value requireStaff() itself checks server-side. Distinct from
   *  `user.role`, the stable identity-level field that never changes with
   *  which business is chosen: a courier who is also a dispatcher has
   *  `user.role === "rider"` (their real account type) but
   *  `effectiveRole === "dispatcher"` (what they're actually granted here
   *  and now) — role-gated nav should ask this, not `user.role`. */
  effectiveRole: string | null;
  loading: boolean;
  /** One shared sign-in for every kind of account (spec: "no separate
   *  rider, merchant, logistics, or admin login pages") — the caller
   *  (login.tsx) inspects the returned `workspace` to decide where to go
   *  next; this function itself only ever updates the *staff* session
   *  state, since a "merchant"/"logistics" outcome routes to an entirely
   *  separate portal with its own session (see merchant-portal.tsx /
   *  logistics-portal.tsx). Pass `workspaceId` to finalize a previous
   *  "select" outcome. */
  login: (identifier: string, password: string, totpCode?: string, workspaceId?: string) => Promise<LoginOutcome>;
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
  const [otherWorkspaces, setOtherWorkspaces] = useState<Workspace[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [effectiveRole, setEffectiveRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const me = await apiFetch<{ user: UserDto; rider: RiderDto | null; otherWorkspaces: Workspace[]; businessId: string | null; effectiveRole: string | null }>("/auth/me");
      setUser(me.user);
      setRider(me.rider);
      setOtherWorkspaces(me.otherWorkspaces ?? []);
      setBusinessId(me.businessId ?? null);
      setEffectiveRole(me.effectiveRole ?? null);
      // Stage E ("persist per user") — a saved server-side preference
      // follows this person to a new device, overriding whatever that
      // device's own localStorage already had.
      applyRemoteTheme(me.user.theme);
    } catch {
      setUser(null);
      setRider(null);
      setOtherWorkspaces([]);
      setBusinessId(null);
      setEffectiveRole(null);
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
    async (identifier: string, password: string, totpCode?: string, workspaceId?: string): Promise<LoginOutcome> => {
      const body = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password, ...(totpCode ? { totpCode } : {}), ...(workspaceId ? { workspaceId } : {}) }),
      });
      if (body.workspace === "select") {
        return { workspace: "select", options: body.options ?? [] };
      }
      if (body.workspace === "merchant") {
        sessionStorage.setItem(MERCHANT_PORTAL_TOKEN_KEY, body.token!);
        return { workspace: "merchant" };
      }
      if (body.workspace === "logistics") {
        sessionStorage.setItem(LOGISTICS_PORTAL_TOKEN_KEY, body.token!);
        return { workspace: "logistics" };
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
    setBusinessId(null);
    setEffectiveRole(null);
  }, []);

  const value = useMemo(
    () => ({ user, rider, otherWorkspaces, businessId, effectiveRole, loading, login, logout, refresh: loadMe }),
    [user, rider, otherWorkspaces, businessId, effectiveRole, loading, login, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
