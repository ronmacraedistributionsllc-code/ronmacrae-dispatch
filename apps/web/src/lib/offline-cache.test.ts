import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheAge, loadJobsCache, loadOffersCache, saveJobsCache, saveOffersCache } from "./offline-cache.js";

const store = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? undefined)),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
}));

beforeEach(() => {
  store.clear();
});

describe("offline last-known cache", () => {
  it("round-trips jobs and offers with a timestamp", async () => {
    await saveJobsCache([{ id: "j1" } as never]);
    await saveOffersCache([{ id: "o1" } as never]);
    const jobs = await loadJobsCache();
    const offers = await loadOffersCache();
    expect(jobs?.jobs).toEqual([{ id: "j1" }]);
    expect(offers?.offers).toEqual([{ id: "o1" }]);
    expect(Date.now() - jobs!.savedAt).toBeLessThan(5_000);
  });

  it("formats ages for the offline label", () => {
    const now = Date.now();
    expect(cacheAge(now - 10_000, now)).toBe("just now");
    expect(cacheAge(now - 3 * 60_000, now)).toBe("3m ago");
    expect(cacheAge(now - 2 * 3600_000, now)).toBe("2h ago");
    expect(cacheAge(now - 3 * 86400_000, now)).toBe("3d ago");
  });
});
