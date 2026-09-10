import { format, type FxRate } from "@ronmacrae/money";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;
let refreshInFlight: Promise<boolean> | null = null;

/**
 * One refresh shared by every concurrent 401. The API rotates the refresh
 * session on each call (deleting the presented token's row), so two parallel
 * refreshes with the same cookie would invalidate each other and the second
 * would 401 - which would otherwise log the user out.
 */
function doRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return false;
        const body = (await res.json()) as { accessToken: string };
        accessToken = body.accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onSessionExpires(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

/** Force a refresh of the access token (e.g. before reconnecting a websocket whose auth expired). */
export function refreshAccessToken(): Promise<boolean> {
  return doRefresh();
}

export function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Older web calls are relative to API_BASE ("/jobs"); shared contracts are
  // absolute API paths ("/api/jobs"). Support both without producing /api/api.
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const attempt = (withAuth: boolean): Promise<Response> =>
    fetch(`${API_BASE}${apiPath}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body != null && init.body !== "" ? { "content-type": "application/json" } : {}),
        ...(withAuth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });

  return (async () => {
    let res = await attempt(true);
    if (res.status === 401 && !apiPath.startsWith("/auth/login") && !apiPath.startsWith("/auth/refresh")) {
      const refreshed = await doRefresh();
      if (refreshed) {
        res = await attempt(true);
      } else {
        accessToken = null;
        onSessionExpired?.();
      }
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  })();
}

export function formatMoney(m: { amount: number; currency: string } | null | undefined, fx?: FxRate): string {
  if (!m) return "–";
  return format(m, fx);
}
