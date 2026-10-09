import type { FngPoint, FngSummary, RangeId, ZoneId } from "./types";

const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;

export interface ZoneDef {
  id: ZoneId;
  label: string;
  /** Lowest and highest whole value the index puts in this zone. */
  min: number;
  max: number;
}

/**
 * The five readings, as the index's own labels draw them: the API calls 25
 * Extreme Fear, 26 Fear, 46 Fear, 47 Neutral, 54 Neutral, 55 Greed, 75 Greed
 * and 76 Extreme Greed, and the fixture tests check every whole value against
 * its labels.
 */
export const ZONES: readonly ZoneDef[] = [
  { id: "extreme-fear", label: "Extreme Fear", min: 0, max: 25 },
  { id: "fear", label: "Fear", min: 26, max: 46 },
  { id: "neutral", label: "Neutral", min: 47, max: 54 },
  { id: "greed", label: "Greed", min: 55, max: 75 },
  { id: "extreme-greed", label: "Extreme Greed", min: 76, max: 100 },
];

/** The highest value of each zone but the last, drawn as lines across the history chart. */
export const ZONE_EDGES: readonly number[] = [25, 46, 54, 75];

export function classifyValue(value: number): ZoneId {
  const rounded = Math.round(value);
  for (const zone of ZONES) {
    if (rounded <= zone.max) return zone.id;
  }
  return "extreme-greed";
}

export function zoneDef(id: ZoneId): ZoneDef {
  return ZONES.find((zone) => zone.id === id) ?? ZONES[2]!;
}

export function zoneLabel(id: ZoneId): string {
  return zoneDef(id).label;
}

/** The API's `value_classification`, when it is one of the five known words. */
export function zoneFromLabel(label: unknown): ZoneId | null {
  if (typeof label !== "string") return null;
  const wanted = label.trim().toLowerCase();
  return ZONES.find((zone) => zone.label.toLowerCase() === wanted)?.id ?? null;
}

export interface RangeDef {
  id: RangeId;
  label: string;
  /** Calendar days the window spans; null is everything. */
  days: number | null;
}

export const RANGES: readonly RangeDef[] = [
  { id: "30D", label: "30D", days: 30 },
  { id: "90D", label: "90D", days: 90 },
  { id: "1Y", label: "1Y", days: 365 },
  { id: "ALL", label: "All", days: null },
];

export const DEFAULT_RANGE: RangeId = "30D";

export function parseRange(value: unknown): RangeId {
  const wanted = typeof value === "string" ? value.trim().toUpperCase() : "";
  return RANGES.find((range) => range.id === wanted)?.id ?? DEFAULT_RANGE;
}

/** The newest `days` calendar days ending at the latest reading, oldest first. */
export function sliceRange(points: readonly FngPoint[], range: RangeId): FngPoint[] {
  const latest = points[points.length - 1];
  const days = RANGES.find((entry) => entry.id === range)?.days ?? null;
  if (!latest || days === null) return [...points];
  const cutoff = latest.time - (days - 1) * DAY_SECONDS;
  return points.filter((point) => point.time >= cutoff);
}

/** A gap in the history this wide or narrower still counts as "that day". */
const LOOKBACK_TOLERANCE_DAYS = 3;

/**
 * The reading `days` before the newest one. The index misses a day now and
 * then, so a missing day falls back to the nearest earlier reading within a
 * few days instead of showing the wrong neighbour or nothing.
 */
export function readingDaysAgo(points: readonly FngPoint[], days: number): FngPoint | null {
  const latest = points[points.length - 1];
  if (!latest) return null;
  const target = latest.time - days * DAY_SECONDS;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.time > target) continue;
    return target - point.time <= LOOKBACK_TOLERANCE_DAYS * DAY_SECONDS ? point : null;
  }
  return null;
}

export function summarize(points: readonly FngPoint[]): FngSummary | null {
  const latest = points[points.length - 1];
  if (!latest) return null;
  return {
    latest,
    yesterday: readingDaysAgo(points, 1),
    lastWeek: readingDaysAgo(points, 7),
    lastMonth: readingDaysAgo(points, 30),
  };
}

/** Newer readings replace older ones for the same day. Oldest first. */
export function mergePoints(existing: readonly FngPoint[], incoming: readonly FngPoint[]): FngPoint[] {
  const byTime = new Map<number, FngPoint>();
  for (const point of existing) byTime.set(point.time, point);
  for (const point of incoming) byTime.set(point.time, point);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/**
 * One value series per zone, aligned to `points`: the segment that ends at a
 * point takes that point's zone colour, so the line changes colour as it
 * crosses into a zone. Null breaks the line. The first point only starts the
 * first segment, so it never draws as a lone mark in a series of its own.
 */
export function zoneSegments(points: readonly FngPoint[]): Array<{ zone: ZoneId; values: Array<number | null> }> {
  return ZONES.flatMap((zone) => {
    const values: Array<number | null> = points.map(() => null);
    let used = false;
    for (let index = 1; index < points.length; index += 1) {
      if (points[index]!.zone !== zone.id) continue;
      used = true;
      values[index] = points[index]!.value;
      values[index - 1] = points[index - 1]!.value;
    }
    return used ? [{ zone: zone.id, values }] : [];
  });
}

// ---------------------------------------------------------------------------
// When to ask again
// ---------------------------------------------------------------------------

/** Let the index publish before asking for the new day. */
export const PUBLISH_SLACK_MS = 2 * 60_000;
/** Never ask again sooner than this after a successful read. */
export const MIN_REFETCH_MS = 5 * 60_000;
/** The new day is overdue (the latest reading is yesterday's): look again after this. */
export const OVERDUE_RETRY_MS = 10 * 60_000;
/** The index updates daily; nothing a response says moves the next read past this. */
export const MAX_REFETCH_MS = 26 * 60 * 60_000;
/** The whole history is re-read at least this often, in case old days were corrected. */
export const FULL_REFRESH_MS = 7 * DAY_MS;
/** A cache older than this many days is re-read whole rather than topped up. */
const MAX_TOP_UP_DAYS = 90;

/**
 * When the next request is due, as a timestamp. The response says how long the
 * index has until its next update; that is the schedule. Without it, the next
 * UTC midnight after the latest reading. A response that still shows an old
 * day after the new one was due (the index is late) is retried in minutes, not
 * a day.
 */
export function nextRefreshAt(input: {
  latestTime: number;
  secondsUntilUpdate: number | null;
  fetchedAt: number;
}): number {
  const { latestTime, secondsUntilUpdate, fetchedAt } = input;
  const dayEnd = (latestTime + DAY_SECONDS) * 1000;
  if (fetchedAt >= dayEnd) return fetchedAt + OVERDUE_RETRY_MS;
  const scheduled = secondsUntilUpdate != null && secondsUntilUpdate > 0
    ? fetchedAt + secondsUntilUpdate * 1000 + PUBLISH_SLACK_MS
    : dayEnd + PUBLISH_SLACK_MS;
  return Math.min(Math.max(scheduled, fetchedAt + MIN_REFETCH_MS), fetchedAt + MAX_REFETCH_MS);
}

/** After a failed request: 5, 10, 20, 40 minutes, then hourly. Never a tight loop. */
export function retryDelayMs(consecutiveFailures: number): number {
  const step = Math.max(1, Math.floor(consecutiveFailures));
  return Math.min(5 * 60_000 * 2 ** (step - 1), 60 * 60_000);
}

export interface FetchPlan {
  /** The API's `limit`: how many of the newest days to read. 0 is the whole history. */
  limit: number;
  /** The response is the whole history, not a top-up or a short read. */
  full: boolean;
}

/**
 * The whole history the first time and about weekly after that; in between, a
 * request for the days since the last cached one (plus an overlap day), which
 * is a few hundred bytes instead of the whole archive.
 */
export function planFetch(
  cached: { points: readonly FngPoint[]; fullFetchedAt: number } | null,
  now: number,
  /** With nothing cached, read only this many days (a command-line report) instead of the whole history. */
  wantDays?: number,
): FetchPlan {
  const latest = cached?.points[cached.points.length - 1];
  if (!cached || !latest || cached.points.length < 2 || now - cached.fullFetchedAt >= FULL_REFRESH_MS) {
    if (!cached && wantDays !== undefined) return { limit: Math.max(3, Math.ceil(wantDays) + 2), full: false };
    return { limit: 0, full: true };
  }
  const daysBehind = Math.ceil((now / 1000 - latest.time) / DAY_SECONDS);
  if (daysBehind > MAX_TOP_UP_DAYS) return { limit: 0, full: true };
  return { limit: Math.max(3, daysBehind + 2), full: false };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 9", or "Oct 9, 2025" when `withYear`. Days are UTC days, as the index counts them. */
export function formatDay(time: number, withYear = false): string {
  const date = new Date(time * 1000);
  return (withYear ? DAY_YEAR_FORMAT : DAY_FORMAT).format(date);
}

export function isoDay(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}
