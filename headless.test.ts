import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "gloomberb/types/plugin";
import { parseFngPayload } from "./client";
import type { FngLoadResult } from "./cache";
import { createCryptoFearGreedHeadless, projectCryptoFearGreed } from "./headless";
import latest from "./fixtures/fng-latest-130.json";

const loaded: FngLoadResult = {
  points: parseFngPayload(latest).points,
  fetchedAt: Date.UTC(2026, 9, 9, 0, 34, 38),
  nextFetchAt: Date.UTC(2026, 9, 10, 0, 2, 0),
  stale: false,
};

const args = (range?: string): HeadlessPaneLoadArgs => ({
  rawArgument: "",
  argument: null,
  symbols: [],
  options: range ? { range } : {},
});

describe("the report", () => {
  test("carries today, the comparisons and the source credit", () => {
    const [summary] = projectCryptoFearGreed(loaded, args()).sections;
    const entries = Object.fromEntries((summary as { entries: Array<{ key?: string; value: unknown; formatted?: string }> }).entries.map((entry) => [entry.key, entry]));
    expect(entries.value).toMatchObject({ value: 59, formatted: "59" });
    expect(entries.classification).toMatchObject({ value: "greed", formatted: "Greed" });
    expect(entries.yesterday?.formatted).toBe("64 Greed");
    expect(entries.lastWeek?.formatted).toBe("72 Greed");
    expect(entries.lastMonth?.formatted).toBe("66 Greed");
    expect(entries.asOf?.formatted).toBe("Oct 9, 2026 UTC");
    expect(entries.source?.value).toBe("https://alternative.me/crypto/fear-and-greed-index/");
    expect(entries.source?.formatted).toBe("Alternative.me (https://alternative.me/crypto/fear-and-greed-index/)");
  });

  test("lists the history for the range, newest first", () => {
    const result = projectCryptoFearGreed(loaded, args("90D"));
    const history = result.sections[1] as { title: string; rows: Array<{ date: string; value: number; classification: string }> };
    expect(history.title).toBe("History | 90D");
    expect(history.rows).toHaveLength(90);
    expect(history.rows[0]).toEqual({ date: "2026-10-09", value: 59, classification: "Greed" });
    expect(history.rows[89]!.date).toBe("2026-07-12");
    expect(result.metadata).toMatchObject({ range: "90D", readings: 90, stale: false, source: "Alternative.me" });
  });

  test("an unknown range is the default, and a failed refresh is reported beside the cached readings", () => {
    const result = projectCryptoFearGreed({ ...loaded, stale: true, refreshError: "The index did not answer (HTTP 503)." }, args("5Y"));
    expect((result.sections[1] as { rows: unknown[] }).rows).toHaveLength(30);
    expect(result.errors).toEqual(["The index did not answer (HTTP 503)."]);
    expect(result.metadata?.stale).toBe(true);
  });
});

describe("the definition", () => {
  test("declares the range option, wired to the pane's own range", () => {
    const definition = createCryptoFearGreedHeadless({ load: async () => loaded });
    expect(definition.shape).toBe("bundle");
    expect(definition.argument.kind).toBe("none");
    const [range] = definition.options;
    expect(range).toMatchObject({
      key: "range",
      type: "enum",
      defaultValue: "30D",
      pluginState: { pluginId: "crypto-fear-greed", key: "range" },
    });
    expect(range!.values?.map((entry) => entry.value)).toEqual(["30D", "90D", "1Y", "ALL"]);
  });

  test("a report reads only the days it shows, and the whole history for All", async () => {
    const requested: Array<{ refresh: boolean; wantDays: number | undefined }> = [];
    const definition = createCryptoFearGreedHeadless({
      load: async (refresh, _signal, wantDays) => {
        requested.push({ refresh, wantDays });
        return loaded;
      },
    });
    const context = { signal: new AbortController().signal, refresh: true } as HeadlessPaneContext;
    await definition.load(args("30D"), context);
    await definition.load(args("1Y"), context);
    await definition.load(args("ALL"), context);
    expect(requested).toEqual([
      { refresh: true, wantDays: 30 },
      { refresh: true, wantDays: 365 },
      { refresh: true, wantDays: undefined },
    ]);
  });

  test("names the range in the report title", () => {
    const definition = createCryptoFearGreedHeadless({ load: async () => loaded });
    const describe = definition.describe as (args: HeadlessPaneLoadArgs) => string;
    expect(describe(args("1Y"))).toBe("Crypto Fear & Greed | 1Y");
  });
});
