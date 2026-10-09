import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MemoryPluginPersistence, testRender } from "gloomberb/test-support";
import { attachCryptoFearGreedPersistence, loadCryptoFearGreed, resetCryptoFearGreedPersistence } from "./cache";
import { parseFngPayload } from "./client";
import { ZONES } from "./model";
import { PaneHarness, serveApi, settle } from "./test-helpers";
import latest from "./fixtures/fng-latest-130.json";

/** Mid-morning UTC on the day the fixture was captured: the 9 October reading is today's. */
const MORNING = Date.UTC(2026, 9, 9, 6, 0, 0);

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restoreApi: (() => void) | undefined;

beforeEach(() => {
  setSystemTime(new Date(MORNING));
  attachCryptoFearGreedPersistence(new MemoryPluginPersistence());
});
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  restoreApi?.();
  restoreApi = undefined;
  resetCryptoFearGreedPersistence();
  setSystemTime();
});

async function open(width: number, height: number): Promise<string> {
  setup = await testRender(<PaneHarness width={width} height={height} />, { width, height });
  await settle(setup);
  return setup.captureCharFrame();
}

async function press(key: "left" | "right"): Promise<string> {
  await act(async () => {
    setup!.mockInput.pressArrow(key);
    await setup!.renderOnce();
  });
  await settle(setup!, 3);
  return setup!.captureCharFrame();
}

const credits = (frame: string) => frame.split("Source: Alternative.me").length - 1;

describe("a normal reading", () => {
  // Gloom's own pane in a 90x30 terminal is about 22 rows tall; the harness gives the pane the rows it is told.
  test("shows today, the comparisons and the credit beside the value and beside the chart at 90 columns", async () => {
    restoreApi = serveApi(() => Response.json(latest)).restore;
    const frame = await open(90, 24);
    for (const text of ["59  Greed", "Yesterday  64  Greed", "Last week  72  Greed", "Last month 66  Greed", "30D  90D  1Y  All", "as of Oct 9", "[o]pen source"]) {
      expect(frame).toContain(text);
    }
    expect(credits(frame)).toBe(2);
    // The credit sits on the value's own line and on the line above the chart.
    const lines = frame.split("\n");
    expect(lines.find((line) => line.includes("59  Greed"))).toContain("Source: Alternative.me");
    expect(lines.find((line) => line.includes("Extreme Fear") && line.includes("Extreme Greed"))).toContain("Source: Alternative.me");
    expect(lines.every((line) => line.length <= 90)).toBe(true);
    expect(frame).not.toContain("Loading");
  });

  test("with the full 90x30 behind it, the dial and the chart both fit", async () => {
    restoreApi = serveApi(() => Response.json(latest)).restore;
    const frame = await open(90, 30);
    expect(frame).toContain("Current reading Greed");
    expect(frame).toContain("Sep 10 2026");
    expect(credits(frame)).toBe(2);
    expect(frame.split("\n").every((line) => line.length <= 90)).toBe(true);
  });

  test("uses the dial when there is room for it and the chart, and the bar when there is not", async () => {
    restoreApi = serveApi(() => Response.json(latest)).restore;
    const tall = await open(100, 42);
    expect(tall).toContain("Current reading Greed");
    expect(credits(tall)).toBe(2);
    expect(tall).toContain("EXT FEAR");
    setup!.renderer.destroy();
    const short = await open(100, 26);
    expect(short).not.toContain("Current reading");
    expect(short).toContain("59  Greed");
    expect(credits(short)).toBe(2);
  });

  test("keeps the credit on a very narrow pane", async () => {
    restoreApi = serveApi(() => Response.json(latest)).restore;
    const frame = await open(44, 24);
    expect(credits(frame)).toBe(2);
    expect(frame).toContain("59  Greed");
    expect(frame.split("\n").every((line) => line.length <= 44)).toBe(true);
  });

  test("the arrow keys switch the range", async () => {
    // The fixture is 130 days: 30D shows September, 90D reaches back to July.
    restoreApi = serveApi(() => Response.json(latest)).restore;
    const thirty = await open(100, 36);
    expect(thirty).toContain("Sep 10 2026");
    const ninety = await press("right");
    expect(ninety).toContain("Jul");
    expect(ninety).not.toContain("Sep 10 2026");
    const back = await press("left");
    expect(back).toContain("Sep 10 2026");
  });
});

describe("states", () => {
  test("loading says so and shows no figures or credit yet", async () => {
    restoreApi = serveApi(() => new Promise<Response>(() => {})).restore;
    const frame = await open(90, 24);
    expect(frame).toContain("Loading Crypto Fear & Greed...");
    expect(frame).not.toContain("Source: Alternative.me");
  });

  test("a failed first load says what happened and offers another try, which works once the API is back", async () => {
    let ok = false;
    const api = serveApi(() => (ok ? Response.json(latest) : new Response("down", { status: 404 })));
    restoreApi = api.restore;
    const failed = await open(90, 24);
    expect(failed).toContain("Crypto Fear & Greed unavailable.");
    expect(failed).toContain("did not answer (HTTP 404)");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("59  Greed");

    ok = true;
    await act(async () => {
      setup!.mockInput.pressKey("r");
      await setup!.renderOnce();
    });
    await settle(setup!);
    const recovered = setup!.captureCharFrame();
    expect(recovered).toContain("59  Greed");
    expect(recovered).not.toContain("unavailable");
    expect(api.urls).toHaveLength(2);
  });

  test("when a refresh fails the last readings stay and the footer says stale", async () => {
    // Yesterday's cache, and the next update has come due: the pane has to ask, and the API is down.
    await loadCryptoFearGreed(false, { fetch: async () => parseFngPayload(latest) });
    setSystemTime(new Date(Date.UTC(2026, 9, 10, 12, 0, 0)));
    restoreApi = serveApi(() => new Response("down", { status: 404 })).restore;
    const frame = await open(90, 24);
    expect(frame).toContain("59  Greed");
    expect(frame).toContain("stale");
    expect(frame).toContain("HTTP 404");
    expect(credits(frame)).toBe(2);
  });

  test("a history of one day shows the reading, dashes for the comparisons and no chart", async () => {
    const [today] = latest.data;
    restoreApi = serveApi(() => Response.json({ ...latest, data: [today] })).restore;
    const frame = await open(90, 24);
    expect(frame).toContain("59  Greed");
    expect(frame).toContain("Yesterday  --");
    expect(frame).toContain("Last month --");
    expect(frame).toContain("Not enough readings for a chart.");
    expect(credits(frame)).toBe(2);
  });

  test("a pane opened before the index is due paints from the cache without a request", async () => {
    await loadCryptoFearGreed(false, { fetch: async () => parseFngPayload(latest) });
    const api = serveApi(() => Response.json(latest));
    restoreApi = api.restore;
    const frame = await open(90, 24);
    expect(frame).toContain("59  Greed");
    expect(api.urls).toEqual([]);
  });
});

describe("schedule", () => {
  test("reads the index again by itself when its next update comes due, and not before", async () => {
    // A real clock and a real timer: the cache says the next update is 600 ms away.
    setSystemTime();
    const persistence = new MemoryPluginPersistence();
    attachCryptoFearGreedPersistence(persistence);
    const points = parseFngPayload(latest).points;
    persistence.setResource("crypto-fear-greed", "daily", {
      p: points.map((entry) => [entry.time, entry.value, ZONES.findIndex((zone) => zone.id === entry.zone)]),
      n: Date.now() + 600,
      f: Date.now(),
    }, { sourceKey: "crypto-fear-greed", schemaVersion: 1, cachePolicy: { staleMs: 60_000, expireMs: 3_600_000 } });
    const api = serveApi(() => Response.json(latest));
    restoreApi = api.restore;

    const frame = await open(90, 24);
    expect(frame).toContain("59  Greed");
    expect(api.urls).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 900));
    await settle(setup!);
    expect(api.urls).toHaveLength(1);
  });
});
