import { createThrottledFetch, httpFetch } from "gloomberb/utils";
import { classifyValue, zoneFromLabel } from "./model";
import type { FngPayload, FngPoint } from "./types";

const API_URL = "https://api.alternative.me/fng/";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The API is free and keyless, so be gentle with it: a handful of requests a
 * minute at most, one retry, and the cache decides when a request is made at
 * all (see cache.ts).
 */
function createClient() {
  return createThrottledFetch({
    requestsPerMinute: 6,
    maxRetries: 1,
    timeoutMs: REQUEST_TIMEOUT_MS,
    backoffBaseMs: 2_000,
    dedupeGetRequests: true,
    defaultHeaders: {
      Accept: "application/json",
      "User-Agent": "gloomberb-crypto-fear-greed",
    },
    transport: httpFetch,
  });
}

let client = createClient();

/** A fresh request window and no shared in-flight requests, for tests that serve the API themselves. */
export function resetFngClient(): void {
  client = createClient();
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function parseEntry(entry: unknown): FngPoint | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const value = finiteNumber(record.value);
  const time = finiteNumber(record.timestamp);
  if (value === null || time === null || value < 0 || value > 100 || time <= 0) return null;
  return {
    time: Math.floor(time),
    value,
    zone: zoneFromLabel(record.value_classification) ?? classifyValue(value),
  };
}

/**
 * Reads an API response into days, oldest first. Entries that are not a whole
 * reading are dropped; a response with none left is an error, because an empty
 * index is never the right thing to show.
 */
export function parseFngPayload(body: unknown): FngPayload {
  if (!body || typeof body !== "object") throw new Error("The index sent an unreadable response.");
  const { data, metadata } = body as { data?: unknown; metadata?: { error?: unknown } };
  const apiError = metadata && typeof metadata === "object" ? metadata.error : null;
  if (typeof apiError === "string" && apiError.trim()) throw new Error(`The index reported an error: ${apiError.trim()}`);
  if (!Array.isArray(data)) throw new Error("The index sent an unreadable response.");

  const byTime = new Map<number, FngPoint>();
  let newest: { time: number; secondsUntilUpdate: number | null } | null = null;
  for (const entry of data) {
    const point = parseEntry(entry);
    if (!point) continue;
    byTime.set(point.time, point);
    if (!newest || point.time > newest.time) {
      const until = finiteNumber((entry as Record<string, unknown>).time_until_update);
      newest = { time: point.time, secondsUntilUpdate: until !== null && until > 0 ? until : null };
    } else if (point.time === newest.time) {
      const until = finiteNumber((entry as Record<string, unknown>).time_until_update);
      if (until !== null && until > 0) newest.secondsUntilUpdate = until;
    }
  }
  const points = [...byTime.values()].sort((left, right) => left.time - right.time);
  if (points.length === 0) throw new Error("The index returned no readings.");
  return { points, secondsUntilUpdate: newest?.secondsUntilUpdate ?? null };
}

/**
 * `limit` is how many of the newest days to read; 0 is the whole history. Only
 * the newest entry carries `time_until_update`, which is what schedules the
 * next read.
 */
export async function fetchFng(limit: number, signal?: AbortSignal): Promise<FngPayload> {
  const url = `${API_URL}?limit=${Math.max(0, Math.floor(limit))}`;
  const response = await client.fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : undefined,
  });
  if (!response.ok) {
    throw new Error(response.status === 429
      ? "The index is rate limiting requests. It will be retried later."
      : `The index did not answer (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The index sent an unreadable response.");
  }
  return parseFngPayload(body);
}
