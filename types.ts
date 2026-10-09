export const CRYPTO_FEAR_GREED_PLUGIN_ID = "crypto-fear-greed";
export const CRYPTO_FEAR_GREED_PANE_ID = "crypto-fear-greed";

/** Who publishes the index. The terms require this credit beside every display of the data. */
export const SOURCE_NAME = "Alternative.me";
/** A page to open in the browser, never fetched; the only request goes to the API host in client.ts. */
const SOURCE_PAGE = "alternative.me/crypto/fear-and-greed-index/";
export const SOURCE_URL = `https://${SOURCE_PAGE}`;
export const SOURCE_CREDIT = `Source: ${SOURCE_NAME}`;

export type ZoneId = "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed";

export type RangeId = "30D" | "90D" | "1Y" | "ALL";

/** One daily reading. `time` is unix seconds at 00:00 UTC of the day it describes. */
export interface FngPoint {
  time: number;
  value: number;
  zone: ZoneId;
}

/** What one API response carries. */
export interface FngPayload {
  /** Oldest first, one entry per day, no repeats. */
  points: FngPoint[];
  /** `time_until_update` of the newest entry, in seconds, when the response had one. */
  secondsUntilUpdate: number | null;
}

export interface FngSummary {
  latest: FngPoint;
  yesterday: FngPoint | null;
  lastWeek: FngPoint | null;
  lastMonth: FngPoint | null;
}
