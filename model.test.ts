import { describe, expect, test } from "bun:test";
import { parseFngPayload } from "./client";
import {
  MAX_REFETCH_MS,
  MIN_REFETCH_MS,
  OVERDUE_RETRY_MS,
  PUBLISH_SLACK_MS,
  ZONES,
  classifyValue,
  mergePoints,
  nextRefreshAt,
  parseRange,
  planFetch,
  readingDaysAgo,
  retryDelayMs,
  sliceRange,
  summarize,
  zoneFromLabel,
  zoneLabel,
  zoneSegments,
} from "./model";
import type { FngPoint, ZoneId } from "./types";
import latest from "./fixtures/fng-latest-130.json";
import labelSamples from "./fixtures/fng-label-samples.json";

const DAY = 86_400;
const point = (time: number, value: number, zone: ZoneId = classifyValue(value)): FngPoint => ({ time, value, zone });
/** One reading a day for `days` days ending at `end`, values cycling 0 to 99. */
function daily(days: number, end = 1_791_504_000): FngPoint[] {
  return Array.from({ length: days }, (_, index) => point(end - (days - 1 - index) * DAY, (index * 7) % 100));
}

describe("classification", () => {
  test("agrees with the label the API gives every whole value it has published", () => {
    // Real entries, one per distinct value from the full history.
    expect(labelSamples.length).toBeGreaterThan(80);
    for (const sample of labelSamples) {
      expect(zoneLabel(classifyValue(Number(sample.value)))).toBe(sample.value_classification);
    }
  });

  test("zone edges fall where the API puts them", () => {
    const at = (value: number) => classifyValue(value);
    expect([at(0), at(25)]).toEqual(["extreme-fear", "extreme-fear"]);
    expect([at(26), at(46)]).toEqual(["fear", "fear"]);
    expect([at(47), at(54)]).toEqual(["neutral", "neutral"]);
    expect([at(55), at(75)]).toEqual(["greed", "greed"]);
    expect([at(76), at(100)]).toEqual(["extreme-greed", "extreme-greed"]);
  });

  test("zones cover 0 to 100 without a gap or overlap", () => {
    let next = 0;
    for (const zone of ZONES) {
      expect(zone.min).toBe(next);
      next = zone.max + 1;
    }
    expect(next).toBe(101);
  });

  test("labels are read case-insensitively and anything else is unknown", () => {
    expect(zoneFromLabel("Extreme Greed")).toBe("extreme-greed");
    expect(zoneFromLabel("  fear ")).toBe("fear");
    expect(zoneFromLabel("Panic")).toBeNull();
    expect(zoneFromLabel(undefined)).toBeNull();
  });
});

describe("ranges", () => {
  const year = daily(400);

  test("each range ends at the newest reading and spans that many days", () => {
    const end = year[year.length - 1]!.time;
    for (const [range, days] of [["30D", 30], ["90D", 90], ["1Y", 365]] as const) {
      const slice = sliceRange(year, range);
      expect(slice).toHaveLength(days);
      expect(slice[slice.length - 1]!.time).toBe(end);
      expect(slice[0]!.time).toBe(end - (days - 1) * DAY);
    }
    expect(sliceRange(year, "ALL")).toHaveLength(400);
  });

  test("a range wider than the history returns all of it, and an empty history returns nothing", () => {
    expect(sliceRange(daily(10), "1Y")).toHaveLength(10);
    expect(sliceRange([], "30D")).toEqual([]);
  });

  test("a missing day shortens the window by a reading, not by a day", () => {
    const withGap = daily(40).filter((_, index) => index !== 30);
    expect(sliceRange(withGap, "30D")).toHaveLength(29);
  });

  test("unknown range names fall back to 30D", () => {
    expect(parseRange("90d")).toBe("90D");
    expect(parseRange("all")).toBe("ALL");
    expect(parseRange("5Y")).toBe("30D");
    expect(parseRange(undefined)).toBe("30D");
  });
});

describe("yesterday, last week, last month", () => {
  test("come from the real fixture by date", () => {
    const summary = summarize(parseFngPayload(latest).points)!;
    expect([summary.latest.value, summary.latest.zone]).toEqual([59, "greed"]);
    expect(summary.yesterday?.value).toBe(64);
    expect(summary.lastWeek?.value).toBe(72);
    expect(summary.lastMonth?.value).toBe(66);
  });

  test("a missing day falls back to the nearest earlier reading within three days", () => {
    const points = daily(40);
    const end = points[points.length - 1]!.time;
    const without = (days: number[]) => points.filter((entry) => !days.some((day) => entry.time === end - day * DAY));
    expect(readingDaysAgo(without([7]), 7)?.time).toBe(end - 8 * DAY);
    expect(readingDaysAgo(without([7, 8, 9, 10]), 7)).toBeNull();
    expect(readingDaysAgo(daily(5), 30)).toBeNull();
  });

  test("is null for an empty history", () => {
    expect(summarize([])).toBeNull();
  });
});

describe("zone segments for the history line", () => {
  test("each segment takes the colour of the zone it ends in, and the first point starts a segment only", () => {
    const points = [point(0, 20), point(DAY, 30), point(2 * DAY, 31), point(3 * DAY, 60)];
    const byZone = Object.fromEntries(zoneSegments(points).map((entry) => [entry.zone, entry.values]));
    expect(byZone["fear"]).toEqual([20, 30, 31, null]);
    expect(byZone["greed"]).toEqual([null, null, 31, 60]);
    expect(byZone["extreme-fear"]).toBeUndefined();
  });

  test("a single reading draws nothing", () => {
    expect(zoneSegments([point(0, 50)])).toEqual([]);
  });
});

describe("merging a top-up into the history", () => {
  test("newer readings replace the same day and the rest stay in order", () => {
    const merged = mergePoints([point(0, 10), point(DAY, 20), point(2 * DAY, 30)], [point(2 * DAY, 35), point(3 * DAY, 40)]);
    expect(merged.map((entry) => [entry.time / DAY, entry.value])).toEqual([[0, 10], [1, 20], [2, 35], [3, 40]]);
  });
});

describe("when to ask again", () => {
  // The first live response: the 9 October reading, fetched at 00:34:38 UTC with 84322 s to go.
  const latestTime = 1_791_504_000;
  const fetchedAt = Date.UTC(2026, 9, 9, 0, 34, 38);

  test("follows time_until_update, plus a little for the index to publish", () => {
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: 84_322, fetchedAt }))
      .toBe(Date.UTC(2026, 9, 10, 0, 0, 0) + PUBLISH_SLACK_MS);
  });

  test("without it, waits for the next UTC midnight", () => {
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: null, fetchedAt }))
      .toBe(Date.UTC(2026, 9, 10, 0, 0, 0) + PUBLISH_SLACK_MS);
  });

  test("never sooner than a few minutes, however soon the index says it updates", () => {
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: 20, fetchedAt })).toBe(fetchedAt + MIN_REFETCH_MS);
  });

  test("never later than a day and a bit, whatever a response claims", () => {
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: 900_000, fetchedAt })).toBe(fetchedAt + MAX_REFETCH_MS);
  });

  test("a response still showing yesterday after the day turned is retried in minutes", () => {
    const late = Date.UTC(2026, 9, 10, 0, 5, 0);
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: null, fetchedAt: late })).toBe(late + OVERDUE_RETRY_MS);
    expect(nextRefreshAt({ latestTime, secondsUntilUpdate: 30, fetchedAt: late })).toBe(late + OVERDUE_RETRY_MS);
  });

  test("failures back off from five minutes to an hour", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([5, 10, 20, 40, 60, 60].map((minutes) => minutes * 60_000));
    expect(retryDelayMs(0)).toBe(5 * 60_000);
  });
});

describe("what to request", () => {
  const now = Date.UTC(2026, 9, 9, 6, 0, 0);
  const cached = (days: number, fullFetchedAt = now - 3_600_000) => ({
    points: daily(days),
    fullFetchedAt,
  });

  test("the whole history the first time", () => {
    expect(planFetch(null, now)).toEqual({ limit: 0, full: true });
  });

  test("a short first read when a report only needs a few weeks", () => {
    expect(planFetch(null, now, 30)).toEqual({ limit: 32, full: false });
  });

  test("a top-up of the days since the last reading, with an overlap day", () => {
    // The newest cached day is 9 October; the clock says the same day.
    expect(planFetch(cached(100), now)).toEqual({ limit: 3, full: false });
    // Two days behind.
    expect(planFetch(cached(100), now + 2 * DAY * 1000)).toEqual({ limit: 5, full: false });
  });

  test("the whole history again after a week, or when far behind", () => {
    expect(planFetch(cached(100, now - 8 * DAY * 1000), now)).toEqual({ limit: 0, full: true });
    expect(planFetch(cached(100), now + 120 * DAY * 1000)).toEqual({ limit: 0, full: true });
  });

  test("a short first read is topped up as a full one next time", () => {
    expect(planFetch({ points: daily(40), fullFetchedAt: 0 }, now, 30)).toEqual({ limit: 0, full: true });
  });
});
