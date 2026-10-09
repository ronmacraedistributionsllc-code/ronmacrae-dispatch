import { useEffect, useState } from "react";
import { get, set } from "idb-keyval";
import { ApiError, apiFetch } from "./api.js";

/**
 * Offline action queue for rider mutations (accept offer, accept job,
 * status transitions incl. deliver). Rider-only; other roles never touch it.
 *
 * Correctness rules (enforced here, not just documented):
 * - Every item carries an idempotency key, sent as `Idempotency-Key` and
 *   replayed in enqueue order on reconnect — a response lost to the network
 *   replays to the stored success instead of a confusing 409.
 * - A queued "deliver" stays PENDING (never "Delivered") until the server
 *   accepts it: the UI only ever renders server-confirmed job data, and a
 *   pending item renders as "Pending sync", never as a completed state.
 * - Server rejections (offer taken, job cancelled, wrong PIN) mark the item
 *   FAILED with the server's message — surfaced, dismissible, never
 *   silently dropped. Network failures stop the flush and stay pending.
 * - 401/403 stops the flush WITHOUT marking anything failed (auth state is
 *   uncertain; the session flow owns that, not the queue).
 */

export type QueuedKind = "accept-offer" | "accept-job" | "transition";

export interface QueuedAction {
  id: string;
  /** Sent as `Idempotency-Key`; generated once at enqueue time. */
  key: string;
  kind: QueuedKind;
  offerId?: string;
  jobId?: string;
  url: string;
  /** JSON request body, captured at tap time (PIN/amount included). */
  body: string;
  /** Human-readable label, e.g. "Accept offer A12 → Downtown". */
  label: string;
  createdAt: number;
  state: "pending" | "failed";
  error?: string;
}

/** Thrown when a tap was queued instead of sent — not a real failure. */
export class OfflineQueued extends Error {
  constructor() {
    super("Saved — will sync when you're back online");
    this.name = "OfflineQueued";
  }
}

/** True for transport failures (no HTTP response at all). */
export function isOfflineError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

const STORE_KEY = "rider-offline-queue-v1";

let cache: QueuedAction[] | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

async function load(): Promise<QueuedAction[]> {
  if (cache === null) {
    try {
      cache = (await get<QueuedAction[]>(STORE_KEY)) ?? [];
    } catch {
      cache = [];
    }
  }
  return cache;
}

async function persist(items: QueuedAction[]): Promise<void> {
  cache = items;
  try {
    await set(STORE_KEY, items);
  } catch {
    // memory copy still works for this session; next reload loses the queue
  }
  emit();
}

export function newQueueKeys(): { id: string; key: string } {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    key: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

export async function enqueueAction(input: {
  kind: QueuedKind;
  offerId?: string;
  jobId?: string;
  url: string;
  body: string;
  label: string;
}): Promise<QueuedAction> {
  const item: QueuedAction = { ...input, ...newQueueKeys(), createdAt: Date.now(), state: "pending" };
  await persist([...(await load()), item]);
  return item;
}

async function markFailed(id: string, error: string): Promise<void> {
  await persist((await load()).map((i) => (i.id === id ? { ...i, state: "failed" as const, error } : i)));
}

export async function dismissQueuedAction(id: string): Promise<void> {
  await persist((await load()).filter((i) => i.id !== id));
}

/** Put a failed item back to pending (user-tapped Retry). */
export async function retryQueuedAction(id: string): Promise<void> {
  await persist((await load()).map((i) => (i.id === id ? { ...i, state: "pending" as const, error: undefined } : i)));
}

/**
 * Replay pending items in order. Stops at the first network failure
 * (everything after it stays pending) or auth failure. Calls `onSynced`
 * when at least one item synced so callers refetch (offers, jobs).
 */
export async function flushQueue(onSynced: () => void): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  for (const item of await load()) {
    if (item.state === "failed") continue;
    try {
      await apiFetch(item.url, { method: "POST", headers: { "Idempotency-Key": item.key }, body: item.body });
      await persist((await load()).filter((i) => i.id !== item.id));
      synced += 1;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) break;
        await markFailed(item.id, err.message);
      } else {
        // Still offline — stop, leave this and everything after it pending.
        break;
      }
    }
  }
  const failed = (await load()).filter((i) => i.state === "failed").length;
  if (synced > 0) onSynced();
  return { synced, failed };
}

export function pendingForOffer(actions: QueuedAction[], offerId: string): QueuedAction[] {
  return actions.filter((a) => a.offerId === offerId);
}

export function pendingForJob(actions: QueuedAction[], jobId: string): QueuedAction[] {
  return actions.filter((a) => a.jobId === jobId);
}

/** React binding over the module queue (loads once, re-renders on change). */
export function useQueuedActions(): QueuedAction[] {
  const [actions, setActions] = useState<QueuedAction[]>(cache ?? []);
  useEffect(() => {
    let cancelled = false;
    void load().then((items) => {
      if (!cancelled) setActions(items);
    });
    const onChange = () => void load().then((items) => {
      if (!cancelled) setActions(items);
    });
    listeners.add(onChange);
    return () => {
      cancelled = true;
      listeners.delete(onChange);
    };
  }, []);
  return actions;
}

/** Test-only reset (memory + listeners; store left for idb-keyval mocks). */
export function __resetQueueForTests(): void {
  cache = null;
  listeners.clear();
}
