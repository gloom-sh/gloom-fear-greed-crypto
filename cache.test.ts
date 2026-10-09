import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemoryPluginPersistence } from "gloomberb/test-support";
import { parseFngPayload } from "./client";
import {
  attachCryptoFearGreedPersistence,
  getCachedCryptoFearGreed,
  loadCryptoFearGreed,
  resetCryptoFearGreedPersistence,
} from "./cache";
import { PUBLISH_SLACK_MS, retryDelayMs } from "./model";
import type { FngPayload } from "./types";
import latest from "./fixtures/fng-latest-130.json";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The moment the real response was captured: 00:34:38 UTC on 9 October, 84322 s before the next update. */
const CAPTURED = Date.UTC(2026, 9, 9, 0, 34, 38);
const NEXT_UPDATE = Date.UTC(2026, 9, 10, 0, 0, 0) + PUBLISH_SLACK_MS;

const fixture: FngPayload = parseFngPayload(latest);

/** The newest `limit` days of the fixture, the way the API cuts them; limit 0 is all of it. */
function respondWith(limit: number, secondsUntilUpdate: number | null = 84_322): FngPayload {
  const points = limit === 0 ? fixture.points : fixture.points.slice(-limit);
  return { points, secondsUntilUpdate };
}

function stub(respond: (limit: number) => FngPayload | Error = (limit) => respondWith(limit)) {
  const limits: number[] = [];
  return {
    limits,
    fetch: async (limit: number) => {
      limits.push(limit);
      const answer = respond(limit);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

beforeEach(() => {
  setSystemTime(new Date(CAPTURED));
  attachCryptoFearGreedPersistence(new MemoryPluginPersistence());
});
afterEach(() => {
  resetCryptoFearGreedPersistence();
  setSystemTime();
});

describe("loading", () => {
  test("the first load reads the whole history and schedules the next read from the response", async () => {
    const api = stub();
    const result = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toEqual([0]);
    expect(result.points).toHaveLength(130);
    expect(result.stale).toBe(false);
    expect(result.nextFetchAt).toBe(NEXT_UPDATE);
  });

  test("until the index is due to update, loading again never reaches the network", async () => {
    const api = stub();
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    setSystemTime(new Date(CAPTURED + 12 * HOUR));
    const again = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toEqual([0]);
    expect(again.points).toHaveLength(130);
    expect(again.nextFetchAt).toBe(NEXT_UPDATE);
  });

  test("once due, it asks only for the days since the last reading and merges them in", async () => {
    const api = stub((limit) => {
      if (limit === 0) return respondWith(0);
      // Next day's answer: the newest cached days again, plus a new one.
      const last = fixture.points[fixture.points.length - 1]!;
      return {
        points: [...fixture.points.slice(-3), { time: last.time + 86_400, value: 41, zone: "fear" as const }],
        secondsUntilUpdate: 85_000,
      };
    });
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    setSystemTime(new Date(NEXT_UPDATE + MINUTE));
    const result = await loadCryptoFearGreed(false, { fetch: api.fetch });
    // The newest cached day is a day behind: that day and the one before it, plus the new one.
    expect(api.limits).toEqual([0, 4]);
    expect(result.points).toHaveLength(130 + 1);
    expect(result.points[result.points.length - 1]).toEqual({ time: 1_791_504_000 + 86_400, value: 41, zone: "fear" });
    expect(result.nextFetchAt).toBe(NEXT_UPDATE + MINUTE + 85_000 * 1000 + PUBLISH_SLACK_MS);
  });

  test("an index that is late (still yesterday after midnight) is asked again in minutes", async () => {
    const api = stub();
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    const afterMidnight = Date.UTC(2026, 9, 10, 0, 3, 0);
    setSystemTime(new Date(afterMidnight));
    const result = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toHaveLength(2);
    expect(result.nextFetchAt).toBe(afterMidnight + 10 * MINUTE);
  });

  test("the whole history is read again after a week", async () => {
    const api = stub();
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    setSystemTime(new Date(CAPTURED + 8 * 24 * HOUR));
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toEqual([0, 0]);
  });

  test("a manual refresh just after a read is answered from the cache, a later one is not", async () => {
    const api = stub();
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    setSystemTime(new Date(CAPTURED + 20_000));
    await loadCryptoFearGreed(true, { fetch: api.fetch });
    expect(api.limits).toEqual([0]);
    setSystemTime(new Date(CAPTURED + 2 * MINUTE));
    await loadCryptoFearGreed(true, { fetch: api.fetch });
    expect(api.limits).toHaveLength(2);
  });

  test("a report that needs a few weeks reads only those days", async () => {
    const api = stub();
    const result = await loadCryptoFearGreed(false, { fetch: api.fetch, wantDays: 30 });
    expect(api.limits).toEqual([32]);
    expect(result.points).toHaveLength(32);
  });

  test("concurrent loads share one request", async () => {
    const api = stub();
    const [first, second] = await Promise.all([
      loadCryptoFearGreed(false, { fetch: api.fetch }),
      loadCryptoFearGreed(false, { fetch: api.fetch }),
    ]);
    expect(api.limits).toHaveLength(1);
    expect(second.points).toBe(first.points);
  });
});

describe("failing", () => {
  test("with nothing cached the error reaches the pane", async () => {
    const api = stub(() => new Error("The index did not answer (HTTP 503)."));
    await expect(loadCryptoFearGreed(false, { fetch: api.fetch })).rejects.toThrow("HTTP 503");
  });

  test("with readings cached they stay, marked stale, and the retry backs off", async () => {
    let failing = false;
    const api = stub((limit) => (failing ? new Error("The index did not answer (HTTP 503).") : respondWith(limit)));
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    failing = true;

    let now = NEXT_UPDATE + MINUTE;
    setSystemTime(new Date(now));
    const first = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(first.points).toHaveLength(130);
    expect(first.stale).toBe(true);
    expect(first.refreshError).toContain("HTTP 503");
    expect(first.nextFetchAt).toBe(now + retryDelayMs(1));

    now = first.nextFetchAt;
    setSystemTime(new Date(now));
    const second = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(second.nextFetchAt).toBe(now + retryDelayMs(2));

    // And recovers, with no leftover mark.
    failing = false;
    now = second.nextFetchAt;
    setSystemTime(new Date(now));
    const recovered = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(recovered.stale).toBe(false);
    expect(recovered.refreshError).toBeUndefined();
  });
});

describe("persistence", () => {
  test("a restart paints from what was saved, zones and schedule included", async () => {
    const persistence = new MemoryPluginPersistence();
    attachCryptoFearGreedPersistence(persistence);
    await loadCryptoFearGreed(false, { fetch: stub().fetch });

    resetCryptoFearGreedPersistence();
    expect(getCachedCryptoFearGreed()).toBeNull();
    attachCryptoFearGreedPersistence(persistence);

    const cached = getCachedCryptoFearGreed()!;
    expect(cached.points).toHaveLength(130);
    expect(cached.points[cached.points.length - 1]).toEqual({ time: 1_791_504_000, value: 59, zone: "greed" });
    expect(cached.nextFetchAt).toBe(NEXT_UPDATE);
    expect(cached.stale).toBe(false);

    // And it does not ask again before the schedule says so.
    const api = stub();
    await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toEqual([]);
  });

  test("a damaged cache entry is ignored, not shown", async () => {
    const persistence = new MemoryPluginPersistence();
    attachCryptoFearGreedPersistence(persistence);
    persistence.setResource("crypto-fear-greed", "daily", { p: [[1, 50, 99]], n: 1, f: 1 }, {
      sourceKey: "crypto-fear-greed",
      schemaVersion: 1,
      cachePolicy: { staleMs: HOUR, expireMs: 24 * HOUR },
    });
    expect(getCachedCryptoFearGreed()).toBeNull();
    const api = stub();
    const result = await loadCryptoFearGreed(false, { fetch: api.fetch });
    expect(api.limits).toEqual([0]);
    expect(result.points).toHaveLength(130);
  });
});
