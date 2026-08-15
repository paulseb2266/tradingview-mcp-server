/**
 * Daily signal sender.
 * Runs the scanner once and sends market intelligence to Telegram.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional:
 *   MAX_CONTRACT_COST (default 500), MAX_SIGNALS (default 3)
 *   DYNAMIC_UNIVERSE (default true) — screen TradingView for a live candidate
 *     list instead of the hardcoded DEFAULT_TARGETS watchlist. Falls back to
 *     DEFAULT_TARGETS if the screen fails or returns nothing.
 *   UNIVERSE_LIMIT (default 40) — max candidates pulled from the dynamic screen.
 */

import fetch from "node-fetch";
import {
  OptionsScanner, DEFAULT_TARGETS, REGIME_TICKERS,
  type ScanTarget, type OptionSetup, type Regime, type ScanResult, type TickerState, type ScoreBreakdown,
} from "./scanner.js";
import { buildDynamicUniverse } from "./universe.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) { console.error(`ERROR: ${key} is required`); process.exit(1); }
  return val;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelStrength(label: string): string {
  switch (label) {
    case "strong_buy":  return "strong bull";
    case "buy":         return "bull";
    case "neutral":     return "neutral";
    case "sell":        return "bear";
    case "strong_sell": return "strong bear";
    default:            return label;
  }
}

function regimeLine(regime: Regime, spyLabel: string, qqqLabel: string, bonus: number): string {
  const icons: Record<Regime, string> = {
    BULLISH:      "📈", BEARISH:      "📉",
    PARTIAL_BULL: "📈", PARTIAL_BEAR: "📉",
    CONFLICTED:   "⚡", CHOPPY:       "⏸",
  };
  const labels: Record<Regime, string> = {
    BULLISH:      "BULLISH",       BEARISH:      "BEARISH",
    PARTIAL_BULL: "PARTIAL BULL",  PARTIAL_BEAR: "PARTIAL BEAR",
    CONFLICTED:   "CONFLICTED",    CHOPPY:       "CHOPPY",
  };
  const icon  = icons[regime]  ?? "⏸";
  const label = labels[regime] ?? regime;
  return `${icon} *${label}* (+${bonus} pts)  ·  SPY ${labelStrength(spyLabel)} / QQQ ${labelStrength(qqqLabel)}`;
}

// ── Market condition classifier ───────────────────────────────────────────────

function classifyCondition(regime: Regime, states: TickerState[]): string {
  if (regime === "CHOPPY") return "Choppy / range-bound compression";

  const total     = states.length;
  if (total === 0) return "Insufficient data";

  const invalid   = states.filter(s => s.status === "INVALID").length;
  const building  = states.filter(s => s.status === "BUILDING").length;
  const coiling   = states.filter(s => s.status === "COILING").length;
  const ready     = states.filter(s => s.status === "READY").length;
  const aligned   = total - invalid;
  const breadthPct = aligned / total;

  if (ready >= 2)                         return "Late expansion / exhaustion phase";
  if (coiling >= 3 && breadthPct >= 0.4)  return "Strong trend with participation";
  if (coiling >= 1 && breadthPct >= 0.25) return "Early accumulation phase";
  if (breadthPct < 0.25)                  return "Weak trend (low breadth)";
  return "Early accumulation phase";
}

// ── Setup map ─────────────────────────────────────────────────────────────────

function buildSetupMap(states: TickerState[]): string {
  const ready    = states.filter(s => s.status === "READY").map(s => s.ticker);
  const coiling  = states.filter(s => s.status === "COILING").map(s => s.ticker);
  const building = states.filter(s => s.status === "BUILDING").map(s => s.ticker);
  const invalid  = states.filter(s => s.status === "INVALID").map(s => s.ticker);

  const fmt = (tickers: string[], fallback = "—") =>
    tickers.length ? tickers.join(", ") : fallback;

  return [
    `🟢 *READY:* ${fmt(ready)}`,
    `🟡 *COILING:* ${fmt(coiling)}`,
    `🔵 *BUILDING:* ${fmt(building)}`,
    `🔴 *INVALID:* ${fmt(invalid)}`,
  ].join("\n");
}

// ── Action status ─────────────────────────────────────────────────────────────

function actionStatus(states: TickerState[], setupCount: number): string {
  if (setupCount > 0)  return `🚨 *TRADE ACTIVE* — ${setupCount} signal${setupCount > 1 ? "s" : ""} generated`;
  const armed = states.filter(s => s.status === "COILING").length;
  if (armed > 0) return `🔔 *${armed} ARMED SETUP${armed > 1 ? "S" : ""}* — awaiting breakout trigger`;
  return "⏳ *NO TRADE* — monitoring setup development";
}

// ── Closest to trigger ────────────────────────────────────────────────────────

function closestToTrigger(states: TickerState[], setupCount: number): string | null {
  if (setupCount > 0) return null;

  // Prefer COILING over BUILDING, then sort by compressionScore desc
  const candidates = [
    ...states.filter(s => s.status === "COILING"),
    ...states.filter(s => s.status === "BUILDING"),
  ].sort((a, b) => b.compressionScore - a.compressionScore);

  if (candidates.length === 0) return null;

  const top = candidates[0];
  const scoreStr = top.compressionScore > 0
    ? ` (compression ${(top.compressionScore * 100).toFixed(0)}%)`
    : "";
  return `🎯 *Closest:* ${top.ticker}${scoreStr} — ${top.stopReason}`;
}

// ── Score breakdown formatter ─────────────────────────────────────────────────

function formatScoreBreakdown(bd: ScoreBreakdown, ep: number): string {
  const components: Array<{ label: string; value: number; note: string }> = [
    { label: "Expansion potential", value: bd.expansion,    note: `(${ep.toFixed(0)}/100 — compression → breakout)` },
    { label: "Regime alignment",    value: bd.regimeFactor, note: `(SPY + QQQ factor)` },
    { label: "TF alignment",        value: bd.tfAlignment,  note: `(${bd.tfAlignment >= 1.0 ? "4/4" : bd.tfAlignment >= 0.875 ? "3/4" : "2/4"} timeframes)` },
    { label: "ATM proximity",       value: bd.atm,          note: "(distance from spot)" },
    { label: "Liquidity — volume",  value: bd.liquidity,    note: "(volume depth)" },
    { label: "Liquidity — OI",      value: bd.oi,           note: "(open interest depth)" },
    { label: "Spread quality",      value: bd.spread,       note: "(bid/ask tightness)" },
    { label: "IV quality",          value: bd.ivQuality,    note: "(optimal: 20–70%)" },
    { label: "Monthly bonus",       value: bd.monthly,      note: bd.monthly > 1 ? "(monthly expiry)" : "(weekly expiry)" },
  ];

  // Sort by value descending, take top 5
  const sorted = [...components].sort((a, b) => b.value - a.value);
  const top5   = sorted.slice(0, 5);
  const weak   = components.filter(c => c.value < 0.70 && c.label !== "Monthly bonus");

  const lines = [`📊 *Score Breakdown:*`];
  for (const c of top5) {
    lines.push(`  · ${c.label}: ${c.value.toFixed(2)} ${c.note}`);
  }

  if (weak.length > 0) {
    lines.push(`📉 *Weakness penalties:*`);
    for (const c of weak) {
      lines.push(`  · ${c.label}: ${c.value.toFixed(2)} ${c.note}`);
    }
  }

  return lines.join("\n");
}

// ── Trade signal block ────────────────────────────────────────────────────────

function formatSignal(s: OptionSetup, rank: number, maxSignals: number, contractsPassed: number): string {
  const icon      = s.optionType === "Call" ? "🟢" : "🔴";
  const monthly   = s.isMonthly ? " 📅" : "";
  const otmStr    = `${s.pctOtm >= 0 ? "+" : ""}${s.pctOtm.toFixed(1)}%`;
  const spreadStr = `${(s.spreadPct * 100).toFixed(0)}%`;
  const ivStr     = `${(s.iv * 100).toFixed(0)}%`;
  const confidence = Math.min(100, Math.round(s.score * 200));

  // Trigger condition
  const triggerLine = s.breakoutType === "volume_close"
    ? `Close above $${s.triggerLevel.toFixed(2)} with vol ≥ 1.3x avg — ✅ confirmed`
    : s.breakoutType === "retest"
    ? `Retest of $${s.triggerLevel.toFixed(2)} held — ✅ confirmed`
    : s.breakoutType === "ema_retest"
    ? `EMA Retest — 10 EMA at $${s.triggerLevel.toFixed(2)} — ✅ confirmed`
    : "Breakout confirmed";

  // Compression state icon
  const csIcon = s.compressionState === "EXPANSION READY" ? "🟢"
    : s.compressionState === "COILING" ? "🟡" : "🔵";

  const lines = [
    ...(s.conflictedRegime ? [`⚠️ *CONFLICTED REGIME* — SPY & QQQ diverge, reduced confidence`, ``] : []),
    `${icon} *#${rank} ${s.ticker} — ${s.optionType.toUpperCase()}${monthly}*`,
    ``,
    `*Contract*`,
    `Strike $${s.strikePrice} · Exp ${s.expiryDate} · ${s.dte}d DTE`,
    `Delta ${s.delta.toFixed(2)} · Ask $${s.ask.toFixed(2)} · Cost $${s.contractCost.toFixed(0)}`,
    `IV ${ivStr} · Spread ${spreadStr} · OTM ${otmStr}`,
    `Vol ${s.volume.toLocaleString()} · OI ${s.openInterest.toLocaleString()}`,
    ``,
    formatScoreBreakdown(s.scoreBreakdown, s.expansionPotential),
    ``,
    `${csIcon} *Compression:* ${s.compressionState} (${(s.expansionPotential * 0.25).toFixed(0)}/25 pts)`,
    ``,
    `🎯 *Trigger:* ${triggerLine}`,
    ``,
    `⭐ *Confidence: ${confidence}/100*`,
  ];

  return lines.join("\n");
}

// ── Master formatter ──────────────────────────────────────────────────────────

function formatMessage(result: ScanResult, top: OptionSetup[], date: string, maxSignals: number): string {
  const { regime, regimeBonus, spyLabel, qqqLabel, skippedEarnings, tickerStates,
          contractsEvaluated, contractsPassed } = result;

  // ── Stats header ──────────────────────────────────────────────────────────
  const statsHeader = contractsEvaluated > 0 ? [
    `📊 Contracts scanned: ${contractsEvaluated}`,
    `✅ Passed filters: ${contractsPassed}`,
    `🏁 Final candidates: ${result.setups.length}`,
    `🎯 Sent to Telegram: top ${Math.min(maxSignals, top.length)} of ${result.setups.length}`,
    ``,
  ].join("\n") : "";

  // ── 1. MARKET REGIME ──────────────────────────────────────────────────────
  const s1 = [
    `📊 *OPTIONS SCANNER — ${date}*`,
    ``,
    `*① MARKET REGIME*`,
    regimeLine(regime, spyLabel, qqqLabel, regimeBonus),
  ].join("\n");

  // ── 2. MARKET CONDITION ───────────────────────────────────────────────────
  const condition = classifyCondition(regime, tickerStates);
  const s2 = [
    ``,
    `*② MARKET CONDITION*`,
    `📡 ${condition}`,
  ].join("\n");

  // ── 3. SETUP MAP ──────────────────────────────────────────────────────────
  const s3 = [
    ``,
    `*③ SETUP MAP*`,
    buildSetupMap(tickerStates),
  ].join("\n");

  // ── 4. ACTION STATUS ──────────────────────────────────────────────────────
  const status  = actionStatus(tickerStates, top.length);
  const closest = closestToTrigger(tickerStates, top.length);

  const s4Lines = [``, `*④ ACTION*`, status];
  if (closest) s4Lines.push(closest);
  if (skippedEarnings.length > 0) s4Lines.push(`⚠️ Earnings skip: ${skippedEarnings.join(", ")}`);
  const s4 = s4Lines.join("\n");

  // ── Trade blocks (only when signals exist) ────────────────────────────────
  let trades = "";
  if (top.length > 0) {
    const footer = [
      ``,
      `_DTE 21–45 · Delta 0.35–0.55 · Spread <15% · OI ≥1K · IV <120%_`,
      `_Exit rule: -50% stop same day_`,
    ].join("\n");
    const contractStats = `\n${statsHeader}`;
    trades = contractStats + top.map((s, i) => formatSignal(s, i + 1, maxSignals, contractsPassed)).join("\n\n─────────────────\n\n") + footer;
  }

  // CHOPPY early exit — still show regime + condition
  if (regime === "CHOPPY") {
    return [
      `📊 *OPTIONS SCANNER — ${date}*`,
      ``,
      `*① MARKET REGIME*`,
      regimeLine(regime, spyLabel, qqqLabel, regimeBonus),
      ``,
      `*② MARKET CONDITION*`,
      `📡 Choppy / range-bound compression`,
      ``,
      `*④ ACTION*`,
      `⏳ *NO TRADE* — SPY and QQQ both neutral. Waiting for directional alignment.`,
    ].join("\n");
  }

  return s1 + s2 + s3 + s4 + trades;
}

// ── Telegram sender ───────────────────────────────────────────────────────────

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram error ${res.status}: ${body}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function buildTargets(): Promise<ScanTarget[]> {
  const useDynamic = (process.env.DYNAMIC_UNIVERSE ?? "true").toLowerCase() !== "false";
  if (!useDynamic) return DEFAULT_TARGETS;

  const limit   = parseInt(process.env.UNIVERSE_LIMIT ?? "40", 10);
  const dynamic = await buildDynamicUniverse({ limit });

  if (dynamic.length === 0) {
    console.log("[signal] Dynamic universe returned no candidates — falling back to DEFAULT_TARGETS");
    return DEFAULT_TARGETS;
  }

  // Regime tickers (SPY/QQQ/NDX) are always required, never traded directly.
  const regimeTargets = DEFAULT_TARGETS.filter(t => REGIME_TICKERS.has(t.ticker));
  const seen    = new Set(regimeTargets.map(t => t.ticker));
  const targets = [...regimeTargets];

  for (const t of dynamic) {
    if (seen.has(t.ticker)) continue;
    seen.add(t.ticker);
    targets.push(t);
  }

  console.log(`[signal] Dynamic universe: ${dynamic.length} screened candidates (+${regimeTargets.length} regime tickers) = ${targets.length} targets`);
  return targets;
}

async function main(): Promise<void> {
  const telegramToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId        = requireEnv("TELEGRAM_CHAT_ID");
  const maxCost       = parseInt(process.env.MAX_CONTRACT_COST ?? "500", 10);
  const maxSignals    = parseInt(process.env.MAX_SIGNALS        ?? "3",  10);

  const targets = await buildTargets();
  const scanner = new OptionsScanner(targets, maxCost);
  const result  = await scanner.scan();
  const top     = result.setups.slice(0, maxSignals);
  const date    = new Date().toISOString().slice(0, 10);

  const message = formatMessage(result, top, date, maxSignals);
  console.log(`[signal] Regime=${result.regime} signals=${top.length} earnings_skipped=${result.skippedEarnings.length}`);
  await sendTelegram(telegramToken, chatId, message);
  console.log("[signal] Done.");
}

main().catch(err => {
  console.error("[signal] Fatal:", err);
  process.exit(1);
});
