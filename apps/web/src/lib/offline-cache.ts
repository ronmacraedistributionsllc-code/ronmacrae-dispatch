import { get, set } from "idb-keyval";
import type { JobDto, JobOfferDto } from "@ronmacrae/contracts";

/**
 * Last-known rider data cache (IndexedDB via the existing `idb-keyval`
 * dependency — previously listed but never imported anywhere). Written on
 * every successful fetch; read only when the live fetch is unavailable
 * AND the connection status is offline, so cached rows are always
 * explicitly labelled with their age and never mistaken for live data.
 */

export interface CachedJobs {
  savedAt: number;
  jobs: JobDto[];
}

export interface CachedOffers {
  savedAt: number;
  offers: JobOfferDto[];
}

const JOBS_KEY = "rider-jobs-cache-v1";
const OFFERS_KEY = "rider-offers-cache-v1";

async function read<T>(key: string): Promise<T | null> {
  try {
    return (await get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await set(key, value);
  } catch {
    // cache is best-effort; the live path is unaffected
  }
}

export function saveJobsCache(jobs: JobDto[]): Promise<void> {
  return write(JOBS_KEY, { savedAt: Date.now(), jobs } satisfies CachedJobs);
}

export function saveOffersCache(offers: JobOfferDto[]): Promise<void> {
  return write(OFFERS_KEY, { savedAt: Date.now(), offers } satisfies CachedOffers);
}

export function loadJobsCache(): Promise<CachedJobs | null> {
  return read<CachedJobs>(JOBS_KEY);
}

export function loadOffersCache(): Promise<CachedOffers | null> {
  return read<CachedOffers>(OFFERS_KEY);
}

/** "3m ago" style age for the offline cache label. */
export function cacheAge(savedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
