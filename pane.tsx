import { useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities } from "gloomberb/ui";
import {
  Button,
  CompositeChart,
  EmptyState,
  ExternalLinkText,
  PaneStatusBody,
  QueryBar,
  SpeedometerGauge,
  StatGrid,
  scalarPoint,
  staticSeries,
  statGridRows,
  usePaneStatusFooter,
  type SpeedometerSegment,
  type StatItem,
} from "gloomberb/components";
import { useAsyncResource, usePaneVisible, usePluginPaneState, useShortcut } from "gloomberb/react";
import { blendHex, colors } from "gloomberb/theme";
import { isPlainKey } from "gloomberb/utils";
import type { PaneProps } from "gloomberb/types/plugin";
import type { ResolvedSeries } from "gloomberb/time-series";
import { getCachedCryptoFearGreed, loadCryptoFearGreed, type FngLoadResult } from "./cache";
import {
  DEFAULT_RANGE,
  RANGES,
  ZONES,
  ZONE_EDGES,
  classifyValue,
  formatDay,
  parseRange,
  retryDelayMs,
  sliceRange,
  summarize,
  zoneLabel,
  zoneSegments,
} from "./model";
import { SOURCE_NAME, SOURCE_URL, type FngPoint, type RangeId, type ZoneId } from "./types";

/** The index's own palette: red to green through amber and grey, as the stock-market gauge draws it. */
function zoneColor(zone: ZoneId): string {
  switch (zone) {
    case "extreme-fear": return colors.negative;
    case "fear": return colors.warning;
    case "neutral": return colors.neutral;
    case "greed":
    case "extreme-greed": return colors.positive;
  }
}

function gaugeSegments(): SpeedometerSegment[] {
  const edges = [0, 25.999, 46.999, 54.999, 75.999, 100];
  return ZONES.map((zone, index) => ({
    from: index === 0 ? 0 : zone.min,
    to: edges[index + 1]!,
    label: zone.label.toUpperCase(),
    color: zoneColor(zone.id),
  }));
}

/** Rows the speedometer takes: the terminal's dial and its labels, or the desktop's compact SVG. */
const GAUGE_ROWS_TERMINAL = 12;
const GAUGE_ROWS_DESKTOP = 10;
/** The chart keeps at least this many rows beside the dial; a pane too short for both shows the bar instead. */
const MIN_CHART_ROWS_WITH_GAUGE = 12;
/** The chart's floor, whatever else the pane shows. */
const MIN_CHART_ROWS = 6;
/** Below this width the credit stacks under the value instead of sitting beside it. */
const STACK_CREDIT_WIDTH = 46;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Fires `refresh` when `at` arrives, only while the pane can be seen; catches up at once if it came due meanwhile. */
function useRefreshAt(at: number | null, refresh: () => void): void {
  const visible = usePaneVisible();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (at === null || !visible) return;
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => refreshRef.current(), delay);
    return () => clearTimeout(timer);
  }, [at, visible]);
}

/** "Source: Alternative.me", linked. The terms ask for this beside every display of the data. */
function SourceCredit() {
  return (
    <Box flexDirection="row" height={1} flexShrink={0} gap={1}>
      <Text fg={colors.textDim}>Source:</Text>
      <ExternalLinkText url={SOURCE_URL} label={SOURCE_NAME} color={colors.textBright} />
    </Box>
  );
}

/** The reading and its word, with the credit beside it (or under it on a narrow pane). */
function ValueLine({ point, width }: { point: FngPoint; width: number }) {
  const color = zoneColor(point.zone);
  const stacked = width < STACK_CREDIT_WIDTH;
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box flexDirection="row" height={1} gap={2}>
        <Text fg={color} attributes={TextAttributes.BOLD}>{String(Math.round(point.value))}</Text>
        <Text fg={color} attributes={TextAttributes.BOLD}>{zoneLabel(point.zone)}</Text>
        {stacked ? null : (
          <>
            <Box flexGrow={1} />
            <SourceCredit />
          </>
        )}
      </Box>
      {stacked ? <SourceCredit /> : null}
    </Box>
  );
}

/**
 * The short pane's gauge: the five zones as one strip, dimmed except for the
 * zone today sits in, with a bright cell where the reading falls. Plain boxes,
 * so the desktop draws real rectangles and the terminal draws coloured cells.
 */
function ZoneBar({ point, width }: { point: FngPoint; width: number }) {
  const barWidth = Math.max(10, width - 2);
  const marker = Math.round((Math.min(100, Math.max(0, point.value)) / 100) * (barWidth - 1));
  const runs: Array<{ color: string; cells: number }> = [];
  for (let cell = 0; cell < barWidth; cell += 1) {
    const zone = classifyValue((cell / (barWidth - 1)) * 100);
    const color = cell === marker
      ? colors.textBright
      : zone === point.zone ? zoneColor(zone) : blendHex(colors.bg, zoneColor(zone), 0.4);
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.cells += 1;
    else runs.push({ color, cells: 1 });
  }
  return (
    <Box flexDirection="row" height={1} paddingX={1} flexShrink={0}>
      {runs.map((run, index) => <Box key={index} width={run.cells} height={1} backgroundColor={run.color} />)}
    </Box>
  );
}

function buildSeries(points: readonly FngPoint[]): ResolvedSeries[] {
  const dates = points.map((point) => new Date(point.time * 1000));
  return zoneSegments(points).map(({ zone, values }) => staticSeries(
    values.map((value, index) => scalarPoint(dates[index]!, value)),
    { id: `zone-${zone}`, label: zoneLabel(zone), color: zoneColor(zone), style: "line", calendarSpaced: true },
  ));
}

function HistoryChart({ points, width, height }: { points: FngPoint[]; width: number; height: number }) {
  const series = useMemo(() => buildSeries(points), [points]);
  const levels = useMemo(() => ({
    seriesId: series[0]?.id ?? "",
    items: ZONE_EDGES.map((value) => ({
      id: `edge-${value}`,
      value,
      color: colors.textDim,
      editable: false,
      actionable: false,
    })),
  }), [series]);
  const formatAxis = useCallback((value: number) => String(Math.round(value)), []);

  if (points.length < 2) {
    return (
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <EmptyState title="Not enough readings for a chart." />
      </Box>
    );
  }
  return (
    <CompositeChart
      width={width}
      height={height}
      series={series}
      panels={[{ id: "main" }]}
      levels={levels}
      focused={false}
      navigable={false}
      showLegend={false}
      showTimeAxis
      axisWidth={5}
      formatAxisValue={formatAxis}
      emptyMessage="No readings in this range"
    />
  );
}

const CREDIT_WIDTH = `Source: ${SOURCE_NAME}`.length;

function zoneKeyLabels(width: number): string[] | null {
  const full = ZONES.map((zone) => zone.label);
  const compact = ZONES.map((zone) => zone.label.replace("Extreme", "Ext"));
  // "● label" per zone, two spaces apart, then room for the credit and the pane's padding.
  const need = (labels: string[]) => labels.reduce((total, label) => total + label.length + 2, 0) + 2 * (labels.length - 1);
  const room = width - 2 - CREDIT_WIDTH - 2;
  if (need(full) <= room) return full;
  if (need(compact) <= room) return compact;
  return null;
}

/** The five zones in their colours, so the history chart reads without the gauge in view. */
function ZoneKey({ width }: { width: number }) {
  const labels = zoneKeyLabels(width);
  if (!labels) return null;
  return (
    <Box flexDirection="row" height={1} gap={2} flexShrink={1} overflow="hidden">
      {ZONES.map((zone, index) => (
        <Box key={zone.id} flexDirection="row" flexShrink={0}>
          <Text fg={zoneColor(zone.id)}>● </Text>
          <Text fg={colors.textDim}>{labels[index]}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function CryptoFearGreedPane({ paneId, focused, width, height }: PaneProps) {
  const host = useRendererHost();
  const { nativePaneChrome } = useUiCapabilities();
  const [storedRange, setRange] = usePluginPaneState<RangeId>("range", DEFAULT_RANGE);
  const range = parseRange(storedRange);

  const loader = useCallback((force: boolean) => loadCryptoFearGreed(force), []);
  const resource = useAsyncResource<FngLoadResult>(loader, { initialData: getCachedCryptoFearGreed });
  const { load, reload, loading } = resource;
  const data = resource.data;
  const error = resource.error ?? data?.refreshError ?? null;

  // The index publishes once a day and says when: read again then, not on a
  // timer. With nothing to show, a failed read is retried every five minutes.
  const retryAt = useMemo(
    () => (!data && resource.error && !loading ? Date.now() + retryDelayMs(1) : null),
    [data, loading, resource.error],
  );
  const refresh = useCallback(() => void load(false), [load]);
  useRefreshAt(data ? data.nextFetchAt : retryAt, refresh);

  useShortcut((event) => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void reload();
      return;
    }
    const direction = isPlainKey(event, "h") ? -1 : isPlainKey(event, "l") ? 1 : 0;
    if (!direction) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const index = RANGES.findIndex((entry) => entry.id === range);
    setRange(RANGES[(index + direction + RANGES.length) % RANGES.length]!.id);
  }, { enabled: focused });

  const summary = useMemo(() => (data ? summarize(data.points) : null), [data]);
  const visible = useMemo(() => (data ? sliceRange(data.points, range) : []), [data, range]);

  const openSource = useCallback(() => void host.openExternal(SOURCE_URL), [host]);
  const info = useMemo(() => (summary ? [{
    id: "as-of",
    parts: [{ text: `as of ${formatDay(summary.latest.time)} UTC`, tone: "muted" as const }],
  }] : []), [summary]);
  const hints = useMemo(() => [{ id: "source", key: "o", label: "pen source", onPress: openSource }], [openSource]);
  usePaneStatusFooter({ registrationId: paneId, loading, error, stale: data?.stale ?? false, info, hints });

  if (!data || !summary) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody
          loading={loading && !error}
          error={error}
          empty={!loading && !error}
          subject="Crypto Fear & Greed"
          emptyTitle="No readings yet."
          align={loading ? "center" : "start"}
          actions={error ? <Button label="Try again" onPress={() => void reload()} /> : undefined}
        />
      </Box>
    );
  }

  const stats: StatItem[] = [
    { id: "yesterday", label: "Yesterday", point: summary.yesterday },
    { id: "week", label: "Last week", point: summary.lastWeek },
    { id: "month", label: "Last month", point: summary.lastMonth },
  ].map(({ id, label, point }) => (point
    ? { id, label, value: String(Math.round(point.value)), detail: zoneLabel(point.zone), color: zoneColor(point.zone) }
    : { id, label, value: "--", tone: "muted" as const }));

  // Rows above the chart: query bar, figures, the hero, then the key and credit line.
  const gaugeRows = (nativePaneChrome ? GAUGE_ROWS_DESKTOP : GAUGE_ROWS_TERMINAL) + 1;
  const barRows = 1 + 1 + (width < STACK_CREDIT_WIDTH ? 1 : 0) + 1;
  const aboveChart = 1 + statGridRows(stats, width) + 2;
  const gaugeFits = height - aboveChart - gaugeRows >= MIN_CHART_ROWS_WITH_GAUGE;
  const chartHeight = Math.max(MIN_CHART_ROWS, height - aboveChart - (gaugeFits ? gaugeRows : barRows));

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <QueryBar
        width={width}
        view={{
          value: range,
          options: RANGES.map((entry) => ({ value: entry.id, label: entry.label })),
          onChange: (value: string) => setRange(parseRange(value)),
          focused,
        }}
      />
      <StatGrid items={stats} width={width} />
      {gaugeFits ? (
        <Box flexDirection="column" alignItems="center" flexShrink={0} marginTop={nativePaneChrome ? 1 : 0}>
          <SpeedometerGauge
            value={summary.latest.value}
            valueLabel={zoneLabel(summary.latest.zone)}
            width={width}
            segments={gaugeSegments()}
            minWidth={nativePaneChrome ? Math.min(34, Math.max(1, width - 2)) : undefined}
            compact={nativePaneChrome}
          />
          <SourceCredit />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <ValueLine point={summary.latest} width={width} />
          <ZoneBar point={summary.latest} width={width} />
        </Box>
      )}
      <Box flexDirection="row" height={1} paddingX={1} marginTop={1} flexShrink={0}>
        <ZoneKey width={width} />
        <Box flexGrow={1} />
        <SourceCredit />
      </Box>
      <Box flexGrow={1} flexBasis={0} minHeight={0}>
        <HistoryChart points={visible} width={width} height={chartHeight} />
      </Box>
    </Box>
  );
}
