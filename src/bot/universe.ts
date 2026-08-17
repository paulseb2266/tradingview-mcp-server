/**
 * Dynamic candidate universe.
 * Replaces the hardcoded DEFAULT_TARGETS watchlist with a live TradingView
 * screen for liquid, actively-moving US stocks — so the scanner isn't
 * blind to setups outside a fixed 22-ticker list.
 */

import { TradingViewClient } from "../api/client.js";
import { ScreenTool } from "../tools/screen.js";
import { Cache } from "../utils/cache.js";
import { RateLimiter } from "../utils/rateLimit.js";
import type { ScanTarget } from "./scanner.js";

export interface UniverseOptions {
  limit?:             number;  // max candidates to return
  minPrice?:          number;  // avoid penny stocks
  maxPrice?:          number;  // keep contract costs sane
  minAvgVolume?:      number;  // 90d avg volume — liquid enough for an options chain
  minRelativeVolume?: number;  // today's volume vs 10d avg — filters for "something is happening"
  minMarketCap?:      number;  // small-cap+ floor; avg-volume/relative-volume filters do most of the liquidity work
}

const DEFAULTS: Required<UniverseOptions> = {
  limit:             40,
  minPrice:          5,
  maxPrice:          1000,
  minAvgVolume:      1_000_000,
  minRelativeVolume: 1.0,
  minMarketCap:      500_000_000,
};

/**
 * Screens TradingView for liquid, actively-trading US stocks and returns
 * them as ScanTarget[]. Returns [] (never throws) on API failure — callers
 * should fall back to a static watchlist.
 */
export async function buildDynamicUniverse(opts: UniverseOptions = {}): Promise<ScanTarget[]> {
  const cfg = { ...DEFAULTS, ...opts };

  try {
    const tvClient    = new TradingViewClient();
    const cache       = new Cache(300);
    const rateLimiter = new RateLimiter(10);
    const screenTool  = new ScreenTool(tvClient, cache, rateLimiter);

    const result = await screenTool.screenStocks({
      filters: [
        { field: "close",                     operator: "in_range", value: [cfg.minPrice, cfg.maxPrice] },
        { field: "average_volume_90d_calc",   operator: "greater",  value: cfg.minAvgVolume },
        { field: "relative_volume_10d_calc",  operator: "greater",  value: cfg.minRelativeVolume },
        { field: "market_cap_basic",          operator: "greater",  value: cfg.minMarketCap },
      ],
      markets:    ["america"],
      sort_by:    "relative_volume_10d_calc",
      sort_order: "desc",
      limit:      cfg.limit,
      columns:    ["name", "close", "volume", "relative_volume_10d_calc", "market_cap_basic"],
    });

    const targets: ScanTarget[] = [];
    const seen = new Set<string>();

    for (const stock of result.stocks ?? []) {
      const tvSymbol: string = stock.symbol;
      if (!tvSymbol?.includes(":")) continue;
      const [exchange, ticker] = tvSymbol.split(":");
      if (exchange === "OTC") continue; // OTC names virtually never have a listed options chain
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      targets.push({ ticker, tvSymbol });
    }

    return targets;
  } catch (err) {
    console.error("[universe] Dynamic screen failed:", (err as Error).message);
    return [];
  }
}
