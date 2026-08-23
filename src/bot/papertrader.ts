/**
 * Paper trading position manager. Runs as a single "tick" — intended to be
 * invoked every ~15 minutes during market hours via a scheduled task, not as
 * a long-running daemon. Each tick:
 *
 *   1. If today's signals (from signal.ts) haven't been ingested yet, opens a
 *      paper position for each one the balance can afford (highest score first).
 *   2. Re-prices every open position and applies exit rules:
 *        - stop loss:      price <= entryPrice * (1 - STOP_LOSS_PCT)
 *        - profit target:  price >= entryPrice * (1 + PROFIT_TARGET_PCT)
 *        - expiry risk:    dte remaining <= EXPIRY_RISK_DTE (force close —
 *          avoids pin/assignment/theta-cliff risk near expiry)
 *   3. Persists portfolio.json, trades_log.csv, and a combined JSON blob for
 *      the dashboard to read in one fetch.
 *
 * Self-gates on US market hours — safe to schedule at a fixed interval
 * all day without a separate start/stop trigger.
 */

import YahooFinance from "yahoo-finance2";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { OptionSetup } from "./scanner.js";
import {
  loadPortfolio, savePortfolio, appendTradeLog, readTradeLog,
  SIGNALS_PATH, DASHBOARD_DATA_PATH,
  type Position, type ClosedTrade, type ExitReason,
} from "./portfolio.js";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

const STOP_LOSS_PCT     = 0.50; // -50%
const PROFIT_TARGET_PCT = 1.00; // +100%
const EXPIRY_RISK_DTE   = 2;    // force-close at or below this many days to expiry

function isMarketHours(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === "weekday")!.value;
  const hour    = parseInt(parts.find(p => p.type === "hour")!.value, 10);
  const minute  = parseInt(parts.find(p => p.type === "minute")!.value, 10);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 16 * 60;
}

interface Quote { bid: number; ask: number; lastPrice: number; dteRemaining: number; }

async function fetchQuote(ticker: string, expiryDate: string, strike: number, optionType: "Call" | "Put"): Promise<Quote | null> {
  try {
    const expiry = new Date(expiryDate + "T00:00:00Z");
    const chain  = await yahooFinance.options(ticker, { date: expiry }, { validateResult: false }) as any;
    const contracts = optionType === "Call" ? chain.options[0]?.calls : chain.options[0]?.puts;
    const match = contracts?.find((c: any) => c.strike === strike);
    if (!match) return null;
    const dteRemaining = Math.round((expiry.getTime() - Date.now()) / 86_400_000);
    return { bid: match.bid ?? 0, ask: match.ask ?? 0, lastPrice: match.lastPrice ?? 0, dteRemaining };
  } catch {
    return null;
  }
}

function positionId(t: { ticker: string; strikePrice?: number; strike?: number; optionType: string; expiryDate: string }): string {
  const strike = t.strikePrice ?? t.strike;
  return `${t.ticker}-${strike}-${t.optionType}-${t.expiryDate}`;
}

async function ingestTodaysSignals(portfolio: ReturnType<typeof loadPortfolio>): Promise<void> {
  if (!existsSync(SIGNALS_PATH)) return;
  const { date, signals }: { date: string; signals: OptionSetup[] } = JSON.parse(readFileSync(SIGNALS_PATH, "utf8"));
  if (portfolio.lastIngestedSignalDate === date) return; // already opened today's positions

  console.log(`[papertrader] Ingesting ${signals.length} signal(s) from ${date}`);
  for (const sig of signals) {
    const costBasis = sig.ask * 100;
    if (costBasis <= 0) { console.log(`[papertrader] ${sig.ticker} skipped — no valid ask`); continue; }
    if (costBasis > portfolio.balance) { console.log(`[papertrader] ${sig.ticker} skipped — costBasis $${costBasis.toFixed(0)} > balance $${portfolio.balance.toFixed(0)}`); continue; }

    const position: Position = {
      id: positionId(sig), ticker: sig.ticker, optionType: sig.optionType, strike: sig.strikePrice,
      expiryDate: sig.expiryDate, entryDate: date, entryPrice: sig.ask, costBasis,
      entryScore: sig.score, entryDelta: sig.delta, entryTheta: sig.theta, entryIv: sig.iv,
      qualifyingPath: sig.qualifyingPath, dteAtEntry: sig.dte,
    };
    portfolio.positions.push(position);
    portfolio.balance -= costBasis;
    console.log(`[papertrader] Opened ${position.ticker} ${position.strike}${position.optionType[0]} @ $${position.entryPrice.toFixed(2)} (cost $${costBasis.toFixed(0)}, balance now $${portfolio.balance.toFixed(0)})`);
  }
  portfolio.lastIngestedSignalDate = date;
}

async function checkExits(portfolio: ReturnType<typeof loadPortfolio>): Promise<void> {
  const stillOpen: Position[] = [];
  for (const pos of portfolio.positions) {
    const quote = await fetchQuote(pos.ticker, pos.expiryDate, pos.strike, pos.optionType);
    if (!quote) {
      console.log(`[papertrader] ${pos.ticker} ${pos.strike}${pos.optionType[0]} — no quote, holding`);
      stillOpen.push(pos);
      continue;
    }

    const price = quote.bid > 0 ? quote.bid : (quote.ask > 0 ? quote.ask : quote.lastPrice);
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;

    let exitReason: ExitReason | null = null;
    if (quote.dteRemaining <= EXPIRY_RISK_DTE) exitReason = "expiry_risk";
    else if (pnlPct <= -STOP_LOSS_PCT) exitReason = "stop_loss";
    else if (pnlPct >= PROFIT_TARGET_PCT) exitReason = "profit_target";

    if (exitReason) {
      const proceeds = price * 100;
      portfolio.balance += proceeds;
      const closed: ClosedTrade = {
        ...pos, exitDate: new Date().toISOString().slice(0, 10), exitPrice: price,
        profitLoss: proceeds - pos.costBasis, profitLossPct: pnlPct, exitReason, balanceAfter: portfolio.balance,
      };
      appendTradeLog(closed);
      console.log(`[papertrader] CLOSED ${pos.ticker} ${pos.strike}${pos.optionType[0]} @ $${price.toFixed(2)} (${exitReason}, P&L $${closed.profitLoss.toFixed(0)} / ${(pnlPct*100).toFixed(0)}%, balance now $${portfolio.balance.toFixed(0)})`);
    } else {
      console.log(`[papertrader] ${pos.ticker} ${pos.strike}${pos.optionType[0]} holding — $${price.toFixed(2)} (${(pnlPct*100).toFixed(0)}%, dte=${quote.dteRemaining})`);
      stillOpen.push(pos);
    }
  }
  portfolio.positions = stillOpen;
}

async function writeDashboardData(portfolio: ReturnType<typeof loadPortfolio>): Promise<void> {
  const positionsWithQuotes = await Promise.all(portfolio.positions.map(async pos => {
    const quote = await fetchQuote(pos.ticker, pos.expiryDate, pos.strike, pos.optionType);
    const price = quote ? (quote.bid > 0 ? quote.bid : (quote.ask > 0 ? quote.ask : quote.lastPrice)) : null;
    return {
      ...pos,
      currentPrice: price,
      pnlPct: price !== null ? (price - pos.entryPrice) / pos.entryPrice : null,
      pnlDollars: price !== null ? (price - pos.entryPrice) * 100 : null,
      dteRemaining: quote?.dteRemaining ?? null,
    };
  }));

  const closedTrades = readTradeLog().slice(-100).reverse(); // most recent first
  const wins  = closedTrades.filter(t => t.profitLoss > 0).length;
  const total = closedTrades.length;

  writeFileSync(DASHBOARD_DATA_PATH, JSON.stringify({
    balance: portfolio.balance,
    startingBalance: 1000.0,
    openPositions: positionsWithQuotes,
    closedTrades,
    stats: {
      totalTrades: total,
      wins, losses: total - wins,
      winRate: total > 0 ? wins / total : null,
      totalRealizedPnl: closedTrades.reduce((s, t) => s + t.profitLoss, 0),
    },
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

async function main(): Promise<void> {
  if (!isMarketHours() && process.env.FORCE_RUN !== "true") {
    console.log("[papertrader] Outside market hours — skipping tick. (set FORCE_RUN=true to override)");
    return;
  }

  const portfolio = loadPortfolio();
  await ingestTodaysSignals(portfolio);
  await checkExits(portfolio);
  savePortfolio(portfolio);
  await writeDashboardData(portfolio);
  console.log(`[papertrader] Tick done. Balance=$${portfolio.balance.toFixed(2)} openPositions=${portfolio.positions.length}`);
}

main().catch(err => {
  console.error("[papertrader] Fatal:", err);
  process.exit(1);
});
