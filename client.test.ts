import { afterEach, describe, expect, test } from "bun:test";
import { fetchFng, parseFngPayload } from "./client";
import { serveApi } from "./test-helpers";
import latest from "./fixtures/fng-latest-130.json";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("parsing the API response", () => {
  test("reads the real response: oldest first, one reading a day, the newest carries the schedule", () => {
    const payload = parseFngPayload(latest);
    expect(payload.points).toHaveLength(130);
    expect(payload.points.every((entry, index) => index === 0 || entry.time - payload.points[index - 1]!.time === 86_400)).toBe(true);
    const newest = payload.points[payload.points.length - 1]!;
    expect(newest).toEqual({ time: 1_791_504_000, value: 59, zone: "greed" });
    expect(payload.secondsUntilUpdate).toBe(84_322);
  });

  test("keeps the API's own classification", () => {
    const payload = parseFngPayload({ data: [{ value: "30", value_classification: "Extreme Fear", timestamp: "86400" }] });
    expect(payload.points[0]!.zone).toBe("extreme-fear");
  });

  test("classifies a reading whose label is missing or unknown", () => {
    const payload = parseFngPayload({ data: [
      { value: "80", timestamp: "86400" },
      { value: "10", value_classification: "Panic", timestamp: "172800" },
    ] });
    expect(payload.points.map((entry) => entry.zone)).toEqual(["extreme-greed", "extreme-fear"]);
  });

  test("drops entries that are not a whole reading and keeps the rest", () => {
    const payload = parseFngPayload({ data: [
      { value: "50", value_classification: "Neutral", timestamp: "86400" },
      { value: "abc", timestamp: "172800" },
      { value: "101", timestamp: "259200" },
      { value: "-1", timestamp: "345600" },
      { value: "40", timestamp: "0" },
      { value: "40" },
      null,
      "text",
      { value: 62, value_classification: "Greed", timestamp: 432_000 },
    ] });
    expect(payload.points.map((entry) => entry.value)).toEqual([50, 62]);
  });

  test("a repeated day keeps its last entry", () => {
    const payload = parseFngPayload({ data: [
      { value: "50", timestamp: "86400" },
      { value: "52", timestamp: "86400" },
    ] });
    expect(payload.points).toHaveLength(1);
    expect(payload.points[0]!.value).toBe(52);
  });

  test("no schedule when time_until_update is missing or not positive", () => {
    expect(parseFngPayload({ data: [{ value: "50", timestamp: "86400" }] }).secondsUntilUpdate).toBeNull();
    expect(parseFngPayload({ data: [{ value: "50", timestamp: "86400", time_until_update: "0" }] }).secondsUntilUpdate).toBeNull();
  });

  test("an error, an empty answer or a non-answer is an error, never an empty index", () => {
    expect(() => parseFngPayload({ data: [], metadata: { error: "Too many requests" } })).toThrow("Too many requests");
    expect(() => parseFngPayload({ data: [], metadata: { error: null } })).toThrow("no readings");
    expect(() => parseFngPayload({ data: [{ value: "x" }] })).toThrow("no readings");
    expect(() => parseFngPayload({ name: "Fear and Greed Index" })).toThrow("unreadable");
    expect(() => parseFngPayload(null)).toThrow("unreadable");
    expect(() => parseFngPayload("<html>")).toThrow("unreadable");
  });
});

describe("requesting", () => {
  test("asks for the number of days it is told to, nothing else", async () => {
    const api = serveApi(() => Response.json(latest));
    restore = api.restore;
    const payload = await fetchFng(130);
    expect(payload.points).toHaveLength(130);
    await fetchFng(0);
    expect(api.urls).toEqual(["https://api.alternative.me/fng/?limit=130", "https://api.alternative.me/fng/?limit=0"]);
  });

  test("an unsuccessful status says so in words", async () => {
    restore = serveApi(() => new Response("nope", { status: 404 })).restore;
    await expect(fetchFng(3)).rejects.toThrow("did not answer (HTTP 404)");
  });

  test("a body that is not JSON is an error", async () => {
    restore = serveApi(() => new Response("<html>maintenance</html>", { status: 200 })).restore;
    await expect(fetchFng(3)).rejects.toThrow("unreadable");
  });
});
