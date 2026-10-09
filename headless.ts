import type {
  HeadlessBundleResult,
  HeadlessPaneColumn,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "gloomberb/types/plugin";
import { loadCryptoFearGreed, type FngLoadResult } from "./cache";
import { RANGES, formatDay, isoDay, parseRange, sliceRange, summarize, zoneLabel } from "./model";
import { CRYPTO_FEAR_GREED_PLUGIN_ID, SOURCE_NAME, SOURCE_URL, type FngPoint, type RangeId } from "./types";

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "value", header: "Value", align: "right" },
  { key: "classification", header: "Classification" },
];

function reading(point: FngPoint | null) {
  return point ? { value: point.value, classification: zoneLabel(point.zone), date: isoDay(point.time) } : null;
}

function formatReading(point: FngPoint | null): string {
  return point ? `${Math.round(point.value)} ${zoneLabel(point.zone)}` : "--";
}

/**
 * Today, the days it is compared with, and the history for one range. The
 * source credit is part of the report, as it is beside the numbers in the pane.
 */
export function projectCryptoFearGreed(result: FngLoadResult, args: HeadlessPaneLoadArgs): HeadlessBundleResult {
  const range = parseRange(args.options.range);
  const summary = summarize(result.points);
  const visible = sliceRange(result.points, range);
  const sourceText = `${SOURCE_NAME} (${SOURCE_URL})`;
  return {
    sections: [
      {
        title: "Crypto Fear & Greed Index",
        entries: summary ? [
          { key: "value", label: "Value", value: summary.latest.value, formatted: String(Math.round(summary.latest.value)) },
          { key: "classification", label: "Classification", value: summary.latest.zone, formatted: zoneLabel(summary.latest.zone) },
          { key: "yesterday", label: "Yesterday", value: reading(summary.yesterday), formatted: formatReading(summary.yesterday) },
          { key: "lastWeek", label: "Last week", value: reading(summary.lastWeek), formatted: formatReading(summary.lastWeek) },
          { key: "lastMonth", label: "Last month", value: reading(summary.lastMonth), formatted: formatReading(summary.lastMonth) },
          { key: "asOf", label: "As of", value: isoDay(summary.latest.time), formatted: `${formatDay(summary.latest.time, true)} UTC` },
          { key: "source", label: "Source", value: SOURCE_URL, formatted: sourceText },
        ] : [],
      },
      {
        title: `History | ${RANGES.find((entry) => entry.id === range)?.label ?? range}`,
        columns: HISTORY_COLUMNS,
        rows: [...visible].reverse().map((point) => ({
          date: isoDay(point.time),
          value: point.value,
          classification: zoneLabel(point.zone),
        })),
      },
    ],
    ...(result.refreshError ? { errors: [result.refreshError] } : {}),
    metadata: {
      range,
      readings: visible.length,
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      source: SOURCE_NAME,
      sourceUrl: SOURCE_URL,
    },
  };
}

export interface CryptoFearGreedHeadlessDependencies {
  load(refresh: boolean, signal: AbortSignal, wantDays: number | undefined): Promise<FngLoadResult>;
}

const defaultDependencies: CryptoFearGreedHeadlessDependencies = {
  load: (refresh, signal, wantDays) => loadCryptoFearGreed(refresh, { signal, wantDays }),
};

/** A report reads only the days it shows, plus the month that "last month" looks back over. */
function daysNeeded(range: RangeId): number | undefined {
  const days = RANGES.find((entry) => entry.id === range)?.days ?? null;
  return days === null ? undefined : Math.max(days, 30);
}

export function createCryptoFearGreedHeadless(
  dependencies: CryptoFearGreedHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    description: "Today's Crypto Fear and Greed Index (0 to 100) with its classification, yesterday, last week and last month, and the daily history for a range. Data from Alternative.me.",
    argument: { kind: "none" },
    options: [{
      key: "range",
      description: "History window.",
      type: "enum",
      values: RANGES.map((entry) => ({ value: entry.id, aliases: [entry.label.toLowerCase()] })),
      defaultValue: "30D",
      pluginState: { pluginId: CRYPTO_FEAR_GREED_PLUGIN_ID, key: "range" },
    }],
    describe: (args) => `Crypto Fear & Greed | ${parseRange(args.options.range)}`,
    async load(args, ctx) {
      const wantDays = daysNeeded(parseRange(args.options.range));
      return projectCryptoFearGreed(await dependencies.load(ctx.refresh === true, ctx.signal, wantDays), args);
    },
  };
}

export const cryptoFearGreedHeadless = createCryptoFearGreedHeadless();
