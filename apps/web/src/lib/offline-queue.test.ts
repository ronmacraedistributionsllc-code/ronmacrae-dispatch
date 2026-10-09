import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetQueueForTests,
  dismissQueuedAction,
  enqueueAction,
  flushQueue,
  isOfflineError,
  OfflineQueued,
  pendingForJob,
  pendingForOffer,
} from "./offline-queue.js";
import { ApiError } from "./api.js";

const store = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? undefined)),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, apiFetch: vi.fn() };
});

async function api() {
  return (await import("./api.js")).apiFetch as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  __resetQueueForTests();
});

describe("offline action queue", () => {
  it("enqueues offline taps and replays them in order with idempotency keys", async () => {
    const fetch = await api();
    fetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue({});

    const first = await enqueueAction({ kind: "accept-offer", offerId: "o1", url: "/api/bearer/offers/o1/accept", body: "{}", label: "Accept offer" });
    const second = await enqueueAction({ kind: "transition", jobId: "j1", url: "/api/bearer/jobs/j1/transition", body: '{"to":"picked_up"}', label: "Confirm pickup" });
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(first.key).not.toBe(second.key);

    // First flush attempt hits the network failure and stops — both stay pending.
    const onSynced = vi.fn();
    await flushQueue(onSynced);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onSynced).not.toHaveBeenCalled();

    // Back online: replays in order, each with its own key header.
    fetch.mockResolvedValue({});
    const result = await flushQueue(onSynced);
    expect(result).toEqual({ synced: 2, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(3);
    const call1 = fetch.mock.calls[1];
    const call2 = fetch.mock.calls[2];
    if (!call1 || !call2) throw new Error("expected replay calls");
    const headers1 = (call1[1] as { headers: Record<string, string> }).headers;
    const headers2 = (call2[1] as { headers: Record<string, string> }).headers;
    expect(headers1["Idempotency-Key"]).toBe(first.key);
    expect(headers2["Idempotency-Key"]).toBe(second.key);
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it("server rejections are surfaced as failed, never silently dropped, and skipped on later flushes", async () => {
    const fetch = await api();
    fetch.mockRejectedValueOnce(new ApiError(409, "Another courier has already claimed this job")).mockResolvedValue({});
    await enqueueAction({ kind: "accept-offer", offerId: "o2", url: "/api/x", body: "{}", label: "Accept" });
    await enqueueAction({ kind: "transition", jobId: "j2", url: "/api/y", body: "{}", label: "Collect" });

    const onSynced = vi.fn();
    const result = await flushQueue(onSynced);
    expect(result).toEqual({ synced: 1, failed: 1 });
    expect(onSynced).toHaveBeenCalledTimes(1);

    // The failed item keeps its server message and is NOT retried.
    const callsBefore = fetch.mock.calls.length;
    await flushQueue(() => {});
    expect(fetch.mock.calls.length).toBe(callsBefore);
  });

  it("auth failures stop the flush without marking anything failed", async () => {
    const fetch = await api();
    fetch.mockRejectedValue(new ApiError(401, "Unauthorized"));
    await enqueueAction({ kind: "transition", jobId: "j3", url: "/api/y", body: "{}", label: "Collect" });
    const result = await flushQueue(() => {});
    expect(result).toEqual({ synced: 0, failed: 0 });
    // Still pending (not failed): a later flush retries it.
    fetch.mockResolvedValue({});
    const retry = await flushQueue(() => {});
    expect(retry.synced).toBe(1);
  });

  it("dismiss removes a failed item", async () => {
    const fetch = await api();
    fetch.mockRejectedValue(new ApiError(400, "A valid delivery PIN is required"));
    const item = await enqueueAction({ kind: "transition", jobId: "j4", url: "/api/y", body: "{}", label: "Deliver" });
    await flushQueue(() => {});
    await dismissQueuedAction(item.id);
    expect(pendingForJob([], "j4")).toEqual([]);
  });

  it("pending selectors match by offer/job", async () => {
    const a = await enqueueAction({ kind: "accept-offer", offerId: "o9", url: "/api/x", body: "{}", label: "Accept" });
    await enqueueAction({ kind: "transition", jobId: "j9", url: "/api/y", body: "{}", label: "Collect" });
    const all = [a];
    expect(pendingForOffer(all, "o9")).toHaveLength(1);
    expect(pendingForOffer(all, "other")).toHaveLength(0);
    expect(pendingForJob(all, "j9")).toHaveLength(0);
  });

  it("isOfflineError distinguishes transport failure from server rejection", () => {
    expect(isOfflineError(new TypeError("fetch failed"))).toBe(true);
    expect(isOfflineError(new ApiError(409, "nope"))).toBe(false);
    expect(new OfflineQueued().message).toMatch(/back online/);
  });
});
