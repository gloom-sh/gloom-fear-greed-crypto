import type { GloomPlugin } from "gloomberb/types/plugin";
import { attachCryptoFearGreedPersistence, resetCryptoFearGreedPersistence } from "./cache";
import { cryptoFearGreedHeadless } from "./headless";
import { CryptoFearGreedPane } from "./pane";
import { CRYPTO_FEAR_GREED_PANE_ID, CRYPTO_FEAR_GREED_PLUGIN_ID } from "./types";

export const cryptoFearGreedPlugin: GloomPlugin = {
  id: CRYPTO_FEAR_GREED_PLUGIN_ID,
  name: "Crypto Fear & Greed",
  version: "1.0.0",
  description: "The Crypto Fear and Greed Index, today and over time. Data from Alternative.me. Not affiliated with or endorsed by Alternative.me.",
  homepage: "https://github.com/gloom-sh/gloom-fear-greed-crypto",
  toggleable: true,

  // Public JSON over HTTPS, so every renderer. The host is declared so the
  // web app's proxy covers it whatever its CORS headers say.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["api.alternative.me"],

  setup(ctx) {
    attachCryptoFearGreedPersistence(ctx.persistence);
  },

  dispose() {
    resetCryptoFearGreedPersistence();
  },

  panes: [
    {
      id: CRYPTO_FEAR_GREED_PANE_ID,
      name: "Crypto Fear & Greed",
      icon: "C",
      component: CryptoFearGreedPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
      headless: cryptoFearGreedHeadless,
    },
  ],

  paneTemplates: [
    {
      id: "crypto-fear-greed-pane",
      paneId: CRYPTO_FEAR_GREED_PANE_ID,
      label: "Crypto Fear & Greed",
      description: "Today's Crypto Fear and Greed Index with yesterday, last week, last month and a history chart. Data from Alternative.me.",
      keywords: ["crypto", "fear", "greed", "sentiment", "bitcoin", "index", "alternative"],
      shortcut: { prefix: "CFNG" },
      headless: cryptoFearGreedHeadless,
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};

export default cryptoFearGreedPlugin;
