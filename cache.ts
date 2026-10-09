import { createPluginCache } from "gloomberb/utils";
import { fetchFng } from "./client";
import {
  MIN_REFETCH_MS,
  ZONES,
  mergePoints,
  nextRefreshAt,
  planFetch,
  retryDelayMs,
} from "./model";
import type { FngPayload, FngPoint } from "./types";

const CACHE_KIND = "crypto-fear-greed";
const CACHE_KEY = "daily";
const CACHE_SOURCE = "crypto-fear-greed";
const CACHE_SCHEMA_VERSION = 1;
/**
 * The cache only keeps the last answer on disk. When to ask again is not a
 * staleness window: it is the index's own schedule, kept in the snapshot
 * (`nextFetchAt`). The month of expiry is what keeps an offline start useful.
 */
const CACHE_POLICY = {
  staleMs: MIN_REFETCH_MS,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** A manual refresh inside this window of the last request is answered from the cache. */
const FORCE_COOLDOWN_MS = 60_000;

interface FngSnapshot {
  points: FngPoint[];
  /** When the index is due to publish its next day, plus a margin. */
  nextFetchAt: number;
  /** When the whole history was last read, as opposed to topped up. */
  fullFetchedAt: number;
}

type StoredSnapshot = {
  /** [unix seconds, value, zone index] */
  p: Array<[number, number, number]>;
  n: number;
  f: number;
};

export interface FngLoadResult {
  points: FngPoint[];
  fetchedAt: number;
  /** When the pane should ask again. */
  nextFetchAt: number;
  /** The newest request failed and these are the last good readings. */
  stale: boolean;
  refreshError?: string;
}

export interface FngLoadDependencies {
  fetch(limit: number, signal?: AbortSignal): Promise<FngPayload>;
  now(): number;
  signal?: AbortSignal;
  /** With nothing cached, read only this many days instead of the whole history. */
  wantDays?: number;
}

const cache = createPluginCache<FngSnapshot, StoredSnapshot>({
  kind: CACHE_KIND,
  source: CACHE_SOURCE,
  schemaVersion: CACHE_SCHEMA_VERSION,
  policy: CACHE_POLICY,
  encode: (snapshot) => ({
    p: snapshot.points.map((point) => [point.time, point.value, ZONES.findIndex((zone) => zone.id === point.zone)]),
    n: snapshot.nextFetchAt,
    f: snapshot.fullFetchedAt,
  }),
  decode: (stored) => {
    const points = stored.p.map(([time, value, zoneIndex]): FngPoint => {
      const zone = ZONES[zoneIndex!];
      if (!zone || !Number.isFinite(time) || !Number.isFinite(value)) throw new Error("Corrupt cache entry");
      return { time: time!, value: value!, zone: zone.id };
    });
    if (points.length === 0 || !Number.isFinite(stored.n) || !Number.isFinite(stored.f)) throw new Error("Corrupt cache entry");
    return { points, nextFetchAt: stored.n, fullFetchedAt: stored.f };
  },
});

export const attachCryptoFearGreedPersistence = cache.attach;

/** Requests that failed in a row since the last good one; sets how long to wait. */
let consecutiveFailures = 0;

export function resetCryptoFearGreedPersistence(): void {
  cache.reset();
  consecutiveFailures = 0;
}

function toResult(snapshot: FngSnapshot, fetchedAt: number, extra: Partial<FngLoadResult> = {}): FngLoadResult {
  return { points: snapshot.points, fetchedAt, nextFetchAt: snapshot.nextFetchAt, stale: false, ...extra };
}

/** What the cache holds right now, for the first paint. Never touches the network. */
export function getCachedCryptoFearGreed(): FngLoadResult | null {
  const cached = cache.get(CACHE_KEY, { allowExpired: true });
  return cached ? toResult(cached.data, cached.fetchedAt) : null;
}

/**
 * The index changes once a day, so most calls never reach the network: while
 * the cached readings are before their `nextFetchAt` this answers from the
 * cache, and a manual refresh within a minute of the last request does too.
 * Otherwise it asks for the days since the last reading (the whole history the
 * first time and about weekly), merges them in, and schedules the next ask from
 * the response's own `time_until_update`. A failed request keeps the last good
 * readings, marks them stale and backs off.
 */
export async function loadCryptoFearGreed(
  force = false,
  dependencies: Partial<FngLoadDependencies> = {},
): Promise<FngLoadResult> {
  const fetchPayload = dependencies.fetch ?? fetchFng;
  const now = dependencies.now ?? Date.now;
  const started = now();
  const cached = cache.get(CACHE_KEY, { allowExpired: true });

  if (cached) {
    const due = started >= cached.data.nextFetchAt;
    const justFetched = started - cached.fetchedAt < FORCE_COOLDOWN_MS;
    if (force ? justFetched : !due) return toResult(cached.data, cached.fetchedAt);
  }

  try {
    const result = await cache.load(CACHE_KEY, async () => {
      const previous = cached?.data ?? null;
      const plan = planFetch(previous, started, dependencies.wantDays);
      const payload = await fetchPayload(plan.limit, dependencies.signal);
      const points = plan.full || !previous ? payload.points : mergePoints(previous.points, payload.points);
      const fetchedAt = now();
      const latest = points[points.length - 1]!;
      return {
        points,
        // A short first read is not the whole history: it is topped up as one
        // the next time it is asked for.
        fullFetchedAt: plan.full ? fetchedAt : previous ? previous.fullFetchedAt : 0,
        nextFetchAt: nextRefreshAt({ latestTime: latest.time, secondsUntilUpdate: payload.secondsUntilUpdate, fetchedAt }),
      };
    }, { force: true });

    if (result.refreshError) {
      consecutiveFailures += 1;
      return toResult(result.data, result.fetchedAt, {
        stale: true,
        refreshError: result.refreshError,
        nextFetchAt: now() + retryDelayMs(consecutiveFailures),
      });
    }
    consecutiveFailures = 0;
    return toResult(result.data, result.fetchedAt);
  } catch (error) {
    consecutiveFailures += 1;
    throw error;
  }
}
