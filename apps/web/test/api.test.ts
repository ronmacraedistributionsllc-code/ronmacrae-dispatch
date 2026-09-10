import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, setAccessToken } from "../src/lib/api.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

describe("apiFetch", () => {
  beforeEach(() => {
    setAccessToken("access-1");
  });
  afterEach(() => {
    setAccessToken(null);
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and parses JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { zones: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await apiFetch<{ zones: unknown[] }>("/zones");
    expect(out.zones).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/zones");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer access-1");
    expect((init as { credentials: string }).credentials).toBe("include");
  });

  it("refreshes the session on 401 and retries the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "Invalid token" } }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "access-2", user: { name: "Ada" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await apiFetch<{ ok: boolean }>("/auth/me");
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, refreshInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((refreshInit.headers as Record<string, string> | undefined)?.authorization ?? "none").not.toBe(
      "Bearer access-1",
    );
  });

  it("throws ApiError carrying the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { error: { message: "Not found: /api/x", statusCode: 404 } })),
    );
    const err = await apiFetch("/x").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Not found: /api/x");
  });
});
