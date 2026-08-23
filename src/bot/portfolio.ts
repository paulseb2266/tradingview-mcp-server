/**
 * Paper trading portfolio — shared data layer.
 * Used by papertrader.ts (position management) and the dashboard server.
 *
 * Storage: portfolio.json (balance + open positions), trades_log.csv (closed
 * trade history, append-only). Both live in the project root, matching the
 * pre-existing (previously unused) stub files of the same name.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

export const PORTFOLIO_PATH  = join(PROJECT_ROOT, "portfolio.json");
export const TRADES_LOG_PATH = join(PROJECT_ROOT, "trades_log.csv");
export const SIGNALS_PATH    = join(PROJECT_ROOT, "paper-signals.json");
export const DASHBOARD_DATA_PATH = join(PROJECT_ROOT, "paper-dashboard-data.json");

export interface Position {
  id:             string; // `${ticker}-${strike}-${optionType}-${expiryDate}`
  ticker:         string;
  optionType:     "Call" | "Put";
  strike:         number;
  expiryDate:     string; // YYYY-MM-DD
  entryDate:      string; // YYYY-MM-DD
  entryPrice:     number; // ask at entry, $ per share
  costBasis:      number; // entryPrice * 100
  entryScore:     number;
  entryDelta:     number;
  entryTheta:     number;
  entryIv:        number;
  qualifyingPath: string;
  dteAtEntry:     number;
}

export type ExitReason = "stop_loss" | "profit_target" | "expiry_risk" | "manual";

export interface ClosedTrade extends Position {
  exitDate:      string;
  exitPrice:     number;
  profitLoss:    number; // $, (exitPrice - entryPrice) * 100
  profitLossPct: number; // (exitPrice - entryPrice) / entryPrice
  exitReason:    ExitReason;
  balanceAfter:  number;
}

export interface Portfolio {
  balance:                 number;
  positions:               Position[];
  lastIngestedSignalDate:  string | null; // guards against opening the same day's signals twice
  lastUpdated:             string;
}

const STARTING_BALANCE = 1000.0; // matches the pre-existing portfolio.json stub

export function loadPortfolio(): Portfolio {
  if (!existsSync(PORTFOLIO_PATH)) {
    return { balance: STARTING_BALANCE, positions: [], lastIngestedSignalDate: null, lastUpdated: new Date().toISOString() };
  }
  const raw = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf8"));
  return {
    balance: raw.balance ?? STARTING_BALANCE,
    positions: raw.positions ?? [],
    lastIngestedSignalDate: raw.lastIngestedSignalDate ?? null,
    lastUpdated: raw.lastUpdated ?? new Date().toISOString(),
  };
}

export function savePortfolio(p: Portfolio): void {
  p.lastUpdated = new Date().toISOString();
  writeFileSync(PORTFOLIO_PATH, JSON.stringify(p, null, 2));
}

const CSV_HEADER = "ticker,contract,direction,entry_date,entry_price,exit_date,exit_price,profit_loss,profit_loss_pct,exit_reason,balance_after,entry_score,entry_delta,entry_theta,entry_iv,qualifying_path,dte_at_entry";

export function appendTradeLog(t: ClosedTrade): void {
  if (!existsSync(TRADES_LOG_PATH)) {
    writeFileSync(TRADES_LOG_PATH, CSV_HEADER + "\n");
  } else {
    // Pre-existing stub (or an older schema) had a header-only file with no data
    // rows — safe to just fix the header in place rather than append under it.
    const existing = readFileSync(TRADES_LOG_PATH, "utf8");
    const lines = existing.split("\n").filter(l => l.length > 0);
    if (lines[0] !== CSV_HEADER && lines.length <= 1) {
      writeFileSync(TRADES_LOG_PATH, CSV_HEADER + "\n");
    }
  }
  const contract = `${t.strike}${t.optionType[0]} ${t.expiryDate}`;
  const row = [
    t.ticker, contract, t.optionType, t.entryDate, t.entryPrice.toFixed(2),
    t.exitDate, t.exitPrice.toFixed(2), t.profitLoss.toFixed(2), (t.profitLossPct * 100).toFixed(1),
    t.exitReason, t.balanceAfter.toFixed(2), t.entryScore.toFixed(4), t.entryDelta.toFixed(3),
    t.entryTheta.toFixed(4), t.entryIv.toFixed(3), t.qualifyingPath, t.dteAtEntry,
  ].join(",");
  appendFileSync(TRADES_LOG_PATH, row + "\n");
}

export function readTradeLog(): ClosedTrade[] {
  if (!existsSync(TRADES_LOG_PATH)) return [];
  const lines = readFileSync(TRADES_LOG_PATH, "utf8").trim().split("\n");
  if (lines.length <= 1) return [];
  return lines.slice(1).map(line => {
    const [ticker, contract, optionType, entryDate, entryPrice, exitDate, exitPrice, profitLoss, profitLossPct, exitReason, balanceAfter, entryScore, entryDelta, entryTheta, entryIv, qualifyingPath, dteAtEntry] = line.split(",");
    const strikeMatch = contract.match(/^([\d.]+)/);
    return {
      id: `${ticker}-${contract}`, ticker, optionType: optionType as "Call" | "Put",
      strike: strikeMatch ? parseFloat(strikeMatch[1]) : 0,
      expiryDate: contract.split(" ")[1] ?? "", entryDate, entryPrice: parseFloat(entryPrice),
      costBasis: parseFloat(entryPrice) * 100, entryScore: parseFloat(entryScore), entryDelta: parseFloat(entryDelta),
      entryTheta: parseFloat(entryTheta), entryIv: parseFloat(entryIv), qualifyingPath, dteAtEntry: parseInt(dteAtEntry, 10),
      exitDate, exitPrice: parseFloat(exitPrice), profitLoss: parseFloat(profitLoss),
      profitLossPct: parseFloat(profitLossPct) / 100, exitReason: exitReason as ExitReason, balanceAfter: parseFloat(balanceAfter),
    };
  });
}
