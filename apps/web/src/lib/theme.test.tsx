import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRemoteTheme, chooseTheme, getTheme, setTheme } from "./theme.js";
import { setAccessToken } from "./api.js";

// File-level, not per-describe: every describe block below needs a clean
// localStorage + DOM theme attribute, not just the first one.
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  } });
  window.localStorage.clear();
  document.documentElement.dataset.theme = "";
});

describe("theme persistence", () => {
  it("defaults to the standard Ronmacrae theme and applies the selected theme", () => {
    expect(getTheme()).toBe("ronmacrae");
    setTheme("midnight-gold");
    expect(getTheme()).toBe("midnight-gold");
    expect(document.documentElement.dataset.theme).toBe("midnight-gold");
  });

  it("rejects an unknown persisted theme", () => {
    window.localStorage.setItem("ronmacrae-theme", "unknown");
    expect(getTheme()).toBe("ronmacrae");
  });

  it("accepts the four named Stage E themes, including Ronmacrae Blue", () => {
    for (const id of ["ronmacrae-blue", "midnight-gold", "clean-light", "night-courier"] as const) {
      setTheme(id);
      expect(getTheme()).toBe(id);
      expect(document.documentElement.dataset.theme).toBe(id);
    }
  });
});

describe("chooseTheme: per-user persistence", () => {
  afterEach(() => {
    setAccessToken(null);
    vi.unstubAllGlobals();
  });

  it("persists to the server only when a session exists — never when signed out", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken(null);

    chooseTheme("ronmacrae-blue");
    expect(getTheme()).toBe("ronmacrae-blue"); // still applied locally either way
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs the choice to /api/auth/theme when a session exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    setAccessToken("access-1");

    chooseTheme("night-courier");
    expect(getTheme()).toBe("night-courier");
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget PUT's microtask run
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/theme");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ theme: "night-courier" });
  });
});

describe("applyRemoteTheme: syncing a signed-in user's saved preference on session load", () => {
  it("applies a valid server-saved theme over this device's own default", () => {
    expect(getTheme()).toBe("ronmacrae");
    applyRemoteTheme("clean-light");
    expect(getTheme()).toBe("clean-light");
  });

  it("ignores null, undefined, and an unrecognized value — never overwrites a real local choice with garbage", () => {
    setTheme("midnight-gold");
    applyRemoteTheme(null);
    expect(getTheme()).toBe("midnight-gold");
    applyRemoteTheme(undefined);
    expect(getTheme()).toBe("midnight-gold");
    applyRemoteTheme("not-a-real-theme");
    expect(getTheme()).toBe("midnight-gold");
  });
});
