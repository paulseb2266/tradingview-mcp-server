import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
import { TradingViewClient } from "../api/client.js";
import { TAClient, scoreToLabel } from "../api/ta.js";
import { Cache } from "../utils/cache.js";
import { RateLimiter } from "../utils/rateLimit.js";

// ── Public types ───────────────────────────────────────────────────────────────

export interface ScanTarget {
  ticker:   string;
  tvSymbol: string;
}

export const DEFAULT_TARGETS: ScanTarget[] = [
  // Regime signals
  { ticker: "SPY",  tvSymbol: "AMEX:SPY"      },
  { ticker: "QQQ",  tvSymbol: "NASDAQ:QQQ"    },
  { ticker: "NDX",  tvSymbol: "NASDAQ:NDX"    },
  // Large cap tech
  { ticker: "NVDA", tvSymbol: "NASDAQ:NVDA"   },
  { ticker: "AAPL", tvSymbol: "NASDAQ:AAPL"   },
  { ticker: "AMD",  tvSymbol: "NASDAQ:AMD"    },
  { ticker: "AMZN", tvSymbol: "NASDAQ:AMZN"   },
  { ticker: "META", tvSymbol: "NASDAQ:META"   },
  { ticker: "MSFT", tvSymbol: "NASDAQ:MSFT"   },
  { ticker: "GOOGL",tvSymbol: "NASDAQ:GOOGL"  },
  { ticker: "NFLX", tvSymbol: "NASDAQ:NFLX"   },
  { ticker: "TSLA", tvSymbol: "NASDAQ:TSLA"   },
  // Semis
  { ticker: "MU",   tvSymbol: "NASDAQ:MU"     },
  { ticker: "MARA", tvSymbol: "NASDAQ:MARA"   },
  { ticker: "RIOT", tvSymbol: "NASDAQ:RIOT"   },
  // High-beta / growth
  { ticker: "COIN", tvSymbol: "NASDAQ:COIN"   },
  { ticker: "PLTR", tvSymbol: "NASDAQ:PLTR"   },
  { ticker: "SOUN", tvSymbol: "NASDAQ:SOUN"   },
  { ticker: "UBER", tvSymbol: "NYSE:UBER"     },
  { ticker: "PYPL", tvSymbol: "NASDAQ:PYPL"   },
  // Thinner chains
  { ticker: "HOOD", tvSymbol: "NASDAQ:HOOD"   },
  { ticker: "SOFI", tvSymbol: "NASDAQ:SOFI"   },
  { ticker: "RIVN", tvSymbol: "NASDAQ:RIVN"   },
];

// These tickers are used only for regime detection — never as option trades.
export const REGIME_TICKERS = new Set(["SPY", "QQQ", "NDX"]);

export type Regime =
  | "BULLISH"       // SPY + QQQ both buy/strong_buy  → calls only,  +20 bonus
  | "BEARISH"       // SPY + QQQ both sell/strong_sell → puts only,   +20 bonus
  | "PARTIAL_BULL"  // one bullish, one neutral        → calls,       +10 bonus
  | "PARTIAL_BEAR"  // one bearish, one neutral        → puts,        +10 bonus
  | "CONFLICTED"    // one bull, one bear              → per-ticker dir, 0 bonus
  | "CHOPPY";       // both neutral                   → skip (range-bound)

export interface TASignal {
  symbol:           string;
  score:            number;
  label:            string;
  breakdown:        Record<string, number>;
  strongTimeframes: string[];
}

export interface ScoreBreakdown {
  taStrength:   number;  // ta.score
  expansion:    number;  // 0.4 + 0.6 * (ep/100)
  atm:          number;  // proximity to spot
  liquidity:    number;  // volume log-score
  oi:           number;  // OI log-score
  spread:       number;  // 1 - spreadPct/max
  tfAlignment:  number;  // 0.5 + 0.5 * aligned/4
  ivQuality:    number;  // penalty for outlier IV
  regimeFactor: number;  // 1 + bonus/40
  monthly:      number;  // 1.0 or 1.1
}

export interface OptionSetup {
  ticker:              string;
  optionType:          "Call" | "Put";
  strikePrice:         number;
  expiryDate:          string;
  dte:                 number;
  isMonthly:           boolean;
  bid:                 number;
  ask:                 number;
  contractCost:        number;
  spreadPct:           number;
  volume:              number;
  openInterest:        number;
  iv:                  number;
  delta:               number;
  underlyingPrice:     number;
  pctOtm:              number;
  ta:                  TASignal;
  compressionState:    CompressionState;
  expansionPotential:  number;
  breakoutType:        "volume_close" | "retest" | "ema_retest" | null;
  triggerLevel:        number;
  volumeSpike:         number;
  scoreBreakdown:      ScoreBreakdown;
  conflictedRegime:    boolean;
  score:               number;
}

export interface TickerState {
  ticker:           string;
  status:           "READY" | "COILING" | "BUILDING" | "INVALID";
  compressionScore: number;
  compressionState: CompressionState | null;
  stopReason:       string;
}

export interface ScanResult {
  scannedAt:           string;
  regime:              Regime;
  regimeBonus:         number;
  spyLabel:            string;
  qqqLabel:            string;
  setups:              OptionSetup[];
  skippedEarnings:     string[];
  tickerStates:        TickerState[];
  contractsEvaluated:  number;
  contractsPassed:     number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TIMEFRAMES       = ["60", "240", "1D", "1W"] as const;
const STRONG_LABELS    = new Set(["strong_buy",  "buy"]);
const WEAK_LABELS      = new Set(["strong_sell", "sell"]);

// Options filters — quality-first
const MIN_DTE          = 21;      // was 12
const MAX_DTE          = 45;      // was 30
const MIN_OI           = 1_000;   // was 500
const MAX_SPREAD_PCT   = 0.15;    // was 0.25 — tighter spread requirement
const MAX_IV           = 1.20;
const MIN_DELTA        = 0.35;    // was 0.25
const MAX_DELTA        = 0.55;
const MIN_STRONG_TFS   = 3;

const EARNINGS_SKIP_DAYS   = 7;
const OHLCV_DAYS           = 65;  // daily bars to fetch for compression/breakout

// Breakout
const MIN_VOLUME_SPIKE     = 1.3; // confirmed breakout needs 1.3x avg volume

// Compression — minimum combined score required to proceed
const MIN_COMPRESSION_SCORE = 0.20;

// Tickers with thinner options chains get relaxed OI/volume thresholds
const LOW_OI_TICKERS = new Set(["HOOD", "SOFI", "RIVN", "MARA", "RIOT", "SOUN"]);

// ── Internal types ─────────────────────────────────────────────────────────────

interface OHLCVBar {
  open: number; high: number; low: number; close: number; volume: number;
}

export type CompressionState = "EARLY BUILD" | "COILING" | "EXPANSION READY";

interface CompressionSignal {
  isCompressing:        boolean;
  compressionStrength:  number;  // 0–1
  compressionState:     CompressionState;
  atrRatio:             number;
  bbWidth:              number;
}

interface BreakoutSignal {
  hasBreakout:      boolean;
  breakoutType:     "volume_close" | "retest" | "ema_retest" | null;
  breakoutStrength: number;  // 0–1
  volumeSpike:      number;
  triggerLevel:     number;  // price level that was broken
}

interface RegimeAnalysis {
  regime:             Regime;
  regimeBonus:        number;
  preferredDirection: "Call" | "Put" | "Both";
  shouldSkip:         boolean;
}

// ── Black-Scholes delta ────────────────────────────────────────────────────────

function erfApprox(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  return sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}

function normCdf(x: number): number { return (1 + erfApprox(x / Math.SQRT2)) / 2; }

function bsDelta(spot: number, strike: number, dte: number, iv: number, isCall: boolean, rfr = 0.05): number {
  const T = dte / 365;
  if (T <= 0 || iv <= 0 || spot <= 0 || strike <= 0) return 0;
  const d1 = (Math.log(spot / strike) + (rfr + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}

// ── OHLCV fetch ────────────────────────────────────────────────────────────────

async function fetchOHLCV(ticker: string): Promise<OHLCVBar[]> {
  try {
    const period1 = new Date();
    period1.setDate(period1.getDate() - OHLCV_DAYS);
    const result = await (yahooFinance as any).chart(
      ticker,
      { period1: Math.floor(period1.getTime() / 1000), period2: Math.floor(Date.now() / 1000), interval: "1d" },
      { validateResult: false },
    );
    const quotes: any[] = result?.quotes ?? [];
    return quotes
      .map((r: any) => ({ open: r.open ?? 0, high: r.high ?? 0, low: r.low ?? 0, close: r.close ?? 0, volume: r.volume ?? 0 }))
      .filter((r: OHLCVBar) => r.close > 0);
  } catch {
    return [];
  }
}

// ── ATR + Bollinger Band helpers ───────────────────────────────────────────────

function calcATR(bars: OHLCVBar[], period = 14): number[] {
  const trs = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  if (trs.length < period) return trs;
  const atrs: number[] = [];
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  atrs.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }
  return atrs;
}

function calcBBWidth(closes: number[], period = 20): number {
  if (closes.length < period) return 1;
  const slice = closes.slice(-period);
  const sma   = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
  return sma > 0 ? (4 * std) / sma : 1;  // (upper - lower) / mid
}

// Maps a ratio to a [0,1] score: 1 at fullAt, 0 at zeroAt
function linearScore(value: number, fullAt: number, zeroAt: number): number {
  if (value <= fullAt) return 1;
  if (value >= zeroAt) return 0;
  return (zeroAt - value) / (zeroAt - fullAt);
}

function calcEMA(closes: number[], period: number): number[] {
  const result = new Array(closes.length).fill(0);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// ── Compression detection ──────────────────────────────────────────────────────

function detectCompression(bars: OHLCVBar[]): CompressionSignal {
  const none = { isCompressing: false, compressionStrength: 0, compressionState: "EARLY BUILD" as CompressionState, atrRatio: 1, bbWidth: 1 };
  if (bars.length < 30) return none;

  const closes  = bars.map(b => b.close);
  const atrs    = calcATR(bars);

  // ATR: current vs prior 14-period average
  const recentATRs = atrs.slice(-15);
  const avgATR     = recentATRs.slice(0, -1).reduce((s, v) => s + v, 0) / (recentATRs.length - 1);
  const currentATR = recentATRs.at(-1)!;
  const atrRatio   = avgATR > 0 ? currentATR / avgATR : 1;

  // BB width: current vs 10 bars ago (squeeze = width contracting)
  const currentBBW = calcBBWidth(closes);
  const priorBBW   = calcBBWidth(closes.slice(0, -10));
  const bbRatio    = priorBBW > 0 ? currentBBW / priorBBW : 1;

  // Range contraction: avg bar range over last 5 vs prior 20 bars
  const rangeOf    = (b: OHLCVBar) => b.high - b.low;
  const avgLast5   = bars.slice(-5).reduce((s, b) => s + rangeOf(b), 0) / 5;
  const avgPrev20  = bars.slice(-25, -5).reduce((s, b) => s + rangeOf(b), 0) / 20;
  const rangeRatio = avgPrev20 > 0 ? avgLast5 / avgPrev20 : 1;

  // Score each dimension: lower ratio = more compressed = higher score
  const atrScore   = linearScore(atrRatio,   0.50, 0.90);
  const bbScore    = linearScore(bbRatio,    0.50, 0.90);
  const rangeScore = linearScore(rangeRatio, 0.50, 0.85);

  const compressionStrength = (atrScore + bbScore + rangeScore) / 3;

  const compressionState: CompressionState =
    compressionStrength >= 0.35 ? "EXPANSION READY" :
    compressionStrength >= 0.20 ? "COILING" :
    "EARLY BUILD";

  return {
    isCompressing: compressionStrength >= MIN_COMPRESSION_SCORE,
    compressionStrength,
    compressionState,
    atrRatio,
    bbWidth: currentBBW,
  };
}

// ── Breakout detection ─────────────────────────────────────────────────────────

function detectBreakout(bars: OHLCVBar[], isCall: boolean): BreakoutSignal {
  const none = { hasBreakout: false, breakoutType: null as null, breakoutStrength: 0, volumeSpike: 1, triggerLevel: 0 };
  if (bars.length < 25) return none;

  const current  = bars.at(-1)!;
  const prev     = bars.at(-2)!;
  const lookback = bars.slice(-22, -1);  // 21 bars before the current completed bar

  const resistance = Math.max(...lookback.map(b => b.high));
  const support    = Math.min(...lookback.map(b => b.low));
  const avgVol     = lookback.reduce((s, b) => s + b.volume, 0) / lookback.length;
  const volumeSpike = avgVol > 0 ? current.volume / avgVol : 1;

  // Pattern A: close above resistance / below support with volume confirmation
  if (isCall && current.close > resistance && volumeSpike >= MIN_VOLUME_SPIKE) {
    const pct = (current.close - resistance) / resistance;
    const breakoutStrength = Math.min(1, pct * 15 + Math.min(0.5, (volumeSpike - 1) * 0.3));
    return { hasBreakout: true, breakoutType: "volume_close", breakoutStrength, volumeSpike, triggerLevel: resistance };
  }
  if (!isCall && current.close < support && volumeSpike >= MIN_VOLUME_SPIKE) {
    const pct = (support - current.close) / support;
    const breakoutStrength = Math.min(1, pct * 15 + Math.min(0.5, (volumeSpike - 1) * 0.3));
    return { hasBreakout: true, breakoutType: "volume_close", breakoutStrength, volumeSpike, triggerLevel: support };
  }

  // Pattern B: previous bar broke out, current bar retests the level and holds
  const prevLookback = bars.slice(-23, -2);
  if (prevLookback.length < 5) return none;

  const prevResistance = Math.max(...prevLookback.map(b => b.high));
  const prevSupport    = Math.min(...prevLookback.map(b => b.low));

  if (isCall) {
    const prevBroke = prev.close > prevResistance;
    const retested  = current.low  <= prevResistance * 1.02;
    const held      = current.close >= prevResistance * 0.99;
    if (prevBroke && retested && held) {
      return { hasBreakout: true, breakoutType: "retest", breakoutStrength: 0.65, volumeSpike, triggerLevel: prevResistance };
    }
  } else {
    const prevBroke = prev.close < prevSupport;
    const retested  = current.high >= prevSupport * 0.98;
    const held      = current.close <= prevSupport * 1.01;
    if (prevBroke && retested && held) {
      return { hasBreakout: true, breakoutType: "retest", breakoutStrength: 0.65, volumeSpike, triggerLevel: prevSupport };
    }
  }

  // Pattern C: EMA retest — last two closes crossed above/below 10-EMA from opposite side
  const closes = bars.map(b => b.close);
  const emas   = calcEMA(closes, 10);
  const ema0   = emas.at(-1)!;
  const ema1   = emas.at(-2)!;
  const ema2   = emas.at(-3)!;

  if (ema0 > 0 && ema1 > 0 && ema2 > 0) {
    if (isCall) {
      if (current.close > ema0 && prev.close > ema1 && bars.at(-3)!.close < ema2) {
        return { hasBreakout: true, breakoutType: "ema_retest", breakoutStrength: 0.50, volumeSpike, triggerLevel: ema0 };
      }
    } else {
      if (current.close < ema0 && prev.close < ema1 && bars.at(-3)!.close > ema2) {
        return { hasBreakout: true, breakoutType: "ema_retest", breakoutStrength: 0.50, volumeSpike, triggerLevel: ema0 };
      }
    }
  }

  return none;
}

// ── Regime analysis ────────────────────────────────────────────────────────────

function analyzeRegime(taByTicker: Map<string, TASignal>): RegimeAnalysis {
  const spy = taByTicker.get("SPY");
  const qqq = taByTicker.get("QQQ");

  if (!spy || !qqq) {
    return { regime: "CHOPPY", regimeBonus: 0, preferredDirection: "Both", shouldSkip: true };
  }

  const spyBull = STRONG_LABELS.has(spy.label), qqqBull = STRONG_LABELS.has(qqq.label);
  const spyBear = WEAK_LABELS.has(spy.label),   qqqBear = WEAK_LABELS.has(qqq.label);
  const spyNtr  = !spyBull && !spyBear,         qqqNtr  = !qqqBull && !qqqBear;

  if (spyBull && qqqBull) return { regime: "BULLISH",      regimeBonus: 20, preferredDirection: "Call", shouldSkip: false };
  if (spyBear && qqqBear) return { regime: "BEARISH",      regimeBonus: 20, preferredDirection: "Put",  shouldSkip: false };
  if ((spyBull && qqqNtr) || (qqqBull && spyNtr)) return { regime: "PARTIAL_BULL", regimeBonus: 10, preferredDirection: "Call", shouldSkip: false };
  if ((spyBear && qqqNtr) || (qqqBear && spyNtr)) return { regime: "PARTIAL_BEAR", regimeBonus: 10, preferredDirection: "Put",  shouldSkip: false };
  if (spyNtr  && qqqNtr)  return { regime: "CHOPPY",       regimeBonus:  0, preferredDirection: "Both", shouldSkip: true  };
  // one bull, one bear
  return { regime: "CONFLICTED", regimeBonus: 0, preferredDirection: "Both", shouldSkip: false };
}

// ── Higher-timeframe opposition check ─────────────────────────────────────────

function higherTFOpposes(ta: TASignal, isCall: boolean): boolean {
  const label1D = scoreToLabel(ta.breakdown["1D"] ?? 0);
  const label1W = scoreToLabel(ta.breakdown["1W"] ?? 0);
  return isCall
    ? WEAK_LABELS.has(label1D) || WEAK_LABELS.has(label1W)
    : STRONG_LABELS.has(label1D) || STRONG_LABELS.has(label1W);
}

// ── Expansion potential score (0–100) ─────────────────────────────────────────
// Estimates the option's ability to 2x–5x based on setup quality.

function calcExpansionPotential(
  compression: CompressionSignal,
  breakout:    BreakoutSignal,
  ta:          TASignal,
  regimeBonus: number,
  iv:          number,
): number {
  // Compression energy (0–25): tighter coil = more potential
  const compressionPts = compression.compressionStrength * 25;

  // Breakout quality (0–35): confirmed with volume is highest weight
  const breakoutPts = breakout.hasBreakout
    ? (breakout.breakoutStrength * 25 + Math.min(10, (breakout.volumeSpike - 1) * 5))
    : 0;

  // TF alignment (0–20)
  const tfPts = (ta.strongTimeframes.length / 4) * 20;

  // IV quality (0–10): optimal zone 20–70%; penalize very low or very high
  const ivPct = iv * 100;
  const ivPts = ivPct >= 20 && ivPct <= 70
    ? 10
    : ivPct < 20
      ? (ivPct / 20) * 7
      : Math.max(0, 10 - (ivPct - 70) / 8);

  // Regime alignment (0–10)
  const regimePts = regimeBonus / 2;

  return Math.min(100, compressionPts + breakoutPts + tfPts + ivPts + regimePts);
}

// ── Expiry helpers ─────────────────────────────────────────────────────────────

function isThirdFriday(d: Date): boolean {
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

function toDateStr(d: Date | number): string {
  return (d instanceof Date ? d : new Date(d * 1000)).toISOString().slice(0, 10);
}

function expiryMs(d: Date | number): number {
  return d instanceof Date ? d.getTime() : (d as number) * 1000;
}

// ── Earnings check ─────────────────────────────────────────────────────────────

async function hasEarningsSoon(ticker: string): Promise<boolean> {
  try {
    const summary = await yahooFinance.quoteSummary(
      ticker,
      { modules: ["calendarEvents"] },
      { validateResult: false },
    );
    const dates: any[] = (summary as any)?.calendarEvents?.earnings?.earningsDate ?? [];
    const now      = Date.now();
    const windowMs = EARNINGS_SKIP_DAYS * 86_400_000;
    return dates.some(d => {
      const t = d instanceof Date ? d.getTime() : Number(d) * 1000;
      return t >= now && t <= now + windowMs;
    });
  } catch {
    return false;
  }
}

// ── Main scanner ───────────────────────────────────────────────────────────────

export class OptionsScanner {
  private taClient: TAClient;

  constructor(
    private targets:         ScanTarget[] = DEFAULT_TARGETS,
    private maxContractCost: number = 500,
  ) {
    const tvClient = new TradingViewClient();
    const cache    = new Cache(300);
    const limiter  = new RateLimiter(10);
    this.taClient  = new TAClient(tvClient, cache, limiter);
  }

  async scan(): Promise<ScanResult> {
    const scannedAt = new Date().toISOString();
    console.log(`[scanner] Starting scan at ${scannedAt}`);

    // ── Step 1: Fetch TA for all targets ─────────────────────────────────────
    const taResult = await this.taClient.rankByTA({
      symbols:    this.targets.map(t => t.tvSymbol),
      timeframes: [...TIMEFRAMES],
    });

    const taBySymbol = new Map<string, TASignal>();
    const taByTicker = new Map<string, TASignal>();

    for (const ranked of taResult.ranked) {
      const strongTimeframes = TIMEFRAMES.filter(tf =>
        STRONG_LABELS.has(scoreToLabel(ranked.breakdown[tf] ?? 0))
      );
      const signal: TASignal = {
        symbol: ranked.symbol, score: ranked.score, label: ranked.label,
        breakdown: ranked.breakdown, strongTimeframes,
      };
      taBySymbol.set(ranked.symbol, signal);
      const bare = ranked.symbol.includes(":") ? ranked.symbol.split(":")[1] : ranked.symbol;
      taBySymbol.set(bare, signal);
      taByTicker.set(bare, signal);
    }

    // ── Step 2: Regime analysis ───────────────────────────────────────────────
    const spyLabel = taByTicker.get("SPY")?.label ?? "neutral";
    const qqqLabel = taByTicker.get("QQQ")?.label ?? "neutral";

    const { regime, regimeBonus, preferredDirection, shouldSkip } = analyzeRegime(taByTicker);
    console.log(`[scanner] Regime: ${regime} (+${regimeBonus})  SPY=${spyLabel}  QQQ=${qqqLabel}`);

    if (shouldSkip) {
      return { scannedAt, regime, regimeBonus, spyLabel, qqqLabel, setups: [], skippedEarnings: [], tickerStates: [], contractsEvaluated: 0, contractsPassed: 0 };
    }

    // ── Step 3: Per-ticker scan ───────────────────────────────────────────────
    const skippedEarnings: string[]    = [];
    const setups: OptionSetup[]        = [];
    const conflictedSetups: OptionSetup[] = [];
    const stateMap = new Map<string, TickerState>();
    let contractsEvaluated = 0;
    let contractsPassed    = 0;

    const invalidState  = (ticker: string, reason: string): TickerState =>
      ({ ticker, status: "INVALID",  compressionScore: 0, compressionState: null, stopReason: reason });
    const buildingState = (ticker: string, reason: string, cs = 0, cst: CompressionState | null = null): TickerState =>
      ({ ticker, status: "BUILDING", compressionScore: cs, compressionState: cst,  stopReason: reason });
    const coilingState  = (ticker: string, cs: number, cst: CompressionState): TickerState =>
      ({ ticker, status: "COILING",  compressionScore: cs, compressionState: cst,  stopReason: "awaiting breakout above resistance with volume" });

    for (const target of this.targets) {
      if (REGIME_TICKERS.has(target.ticker)) continue;

      const ta = taBySymbol.get(target.tvSymbol) ?? taBySymbol.get(target.ticker);
      if (!ta) {
        stateMap.set(target.ticker, invalidState(target.ticker, "no TA data"));
        console.log(`[scanner] ${target.ticker} no TA data — skipping`);
        continue;
      }

      // Determine trade direction
      let isCallMode: boolean;
      if (preferredDirection === "Both") {
        // CONFLICTED regime: follow individual ticker TA
        if      (STRONG_LABELS.has(ta.label)) isCallMode = true;
        else if (WEAK_LABELS.has(ta.label))   isCallMode = false;
        else {
          stateMap.set(target.ticker, invalidState(target.ticker, "neutral in conflicted regime"));
          console.log(`[scanner] ${target.ticker} neutral in conflicted regime — skipping`);
          continue;
        }
      } else {
        isCallMode = preferredDirection === "Call";
        const aligned = isCallMode ? STRONG_LABELS.has(ta.label) : WEAK_LABELS.has(ta.label);
        if (!aligned) {
          stateMap.set(target.ticker, invalidState(target.ticker, `TA=${ta.label}`));
          console.log(`[scanner] ${target.ticker} TA=${ta.label} — wrong direction for ${regime}`);
          continue;
        }
      }

      // Higher timeframe must not oppose direction (prevents counter-trend entries)
      if (higherTFOpposes(ta, isCallMode)) {
        stateMap.set(target.ticker, invalidState(target.ticker, "1D/1W opposing"));
        console.log(`[scanner] ${target.ticker} 1D/1W opposes ${isCallMode ? "calls" : "puts"} — skipping`);
        continue;
      }

      // Require ≥3 of 4 TFs aligned
      if (ta.strongTimeframes.length < MIN_STRONG_TFS) {
        stateMap.set(target.ticker, buildingState(target.ticker, `${ta.strongTimeframes.length}/4 TFs aligned`));
        console.log(`[scanner] ${target.ticker} only ${ta.strongTimeframes.length}/${TIMEFRAMES.length} strong TFs`);
        continue;
      }

      // Fetch OHLCV and gate on compression → breakout pattern
      const bars = await fetchOHLCV(target.ticker);

      const compression = detectCompression(bars);
      if (!compression.isCompressing) {
        stateMap.set(target.ticker, buildingState(target.ticker, "price not yet compressing", compression.compressionStrength, compression.compressionState));
        console.log(`[scanner] ${target.ticker} [${compression.compressionState}] score=${compression.compressionStrength.toFixed(2)} — skipping`);
        continue;
      }

      const breakout = detectBreakout(bars, isCallMode);
      if (!breakout.hasBreakout) {
        stateMap.set(target.ticker, coilingState(target.ticker, compression.compressionStrength, compression.compressionState));
        console.log(`[scanner] ${target.ticker} no breakout confirmed — skipping`);
        continue;
      }

      console.log(
        `[scanner] ${target.ticker} [${compression.compressionState}] score=${compression.compressionStrength.toFixed(2)}` +
        ` breakout=${breakout.breakoutType} vol=${breakout.volumeSpike.toFixed(1)}x`,
      );

      // Earnings check
      if (await hasEarningsSoon(target.ticker)) {
        stateMap.set(target.ticker, invalidState(target.ticker, "earnings within 7d"));
        console.log(`[scanner] ${target.ticker} earnings within ${EARNINGS_SKIP_DAYS}d — skipping`);
        skippedEarnings.push(target.ticker);
        continue;
      }

      // ── Options chain ─────────────────────────────────────────────────────
      const optionType = isCallMode ? "Call" : "Put";
      console.log(`[scanner] ${target.ticker} TA=${ta.label} ${ta.strongTimeframes.length}/4 TFs — scanning ${optionType}s`);

      try {
        const index = await yahooFinance.options(target.ticker, {}, { validateResult: false }) as any;
        const spot  = index.quote.regularMarketPrice ?? 0;
        if (!spot) continue;

        const now = Date.now();

        // Prefer monthly expiry in 21–45 DTE window
        const candidates = (index.expirationDates as any[])
          .map((d: any) => ({ raw: d, ms: expiryMs(d) }))
          .filter(({ ms }: { ms: number }) => {
            const dte = (ms - now) / 86_400_000;
            return dte >= MIN_DTE && dte <= MAX_DTE;
          });

        if (candidates.length === 0) {
          console.log(`[scanner] ${target.ticker} no expiry in ${MIN_DTE}–${MAX_DTE} DTE window`);
          continue;
        }

        const monthly    = candidates.find(({ ms }) => isThirdFriday(new Date(ms)));
        const chosen     = monthly ?? candidates[0];
        const dte        = Math.round((chosen.ms - now) / 86_400_000);
        const isMonthly  = isThirdFriday(new Date(chosen.ms));
        const expiryDate = toDateStr(chosen.raw);
        const expiryArg  = chosen.raw instanceof Date ? chosen.raw : new Date(chosen.ms);

        console.log(`[scanner] ${target.ticker} expiry=${expiryDate} DTE=${dte} monthly=${isMonthly}`);

        const chain     = await yahooFinance.options(target.ticker, { date: expiryArg }, { validateResult: false }) as any;
        const contracts = chain.options[0];
        if (!contracts) continue;

        const side = isCallMode ? contracts.calls : contracts.puts;

        for (const c of side) {
          const bid = c.bid ?? 0;
          const ask = c.ask ?? 0;
          if (ask <= 0 || bid <= 0) continue;
          contractsEvaluated++;

          // Hard cost cap
          const contractCost = ask * 100;
          if (contractCost > this.maxContractCost) continue;

          // Spread quality
          const mid       = (bid + ask) / 2;
          const spreadPct = (ask - bid) / mid;
          if (spreadPct > MAX_SPREAD_PCT) continue;

          // OI hard floor (relaxed for thin-chain tickers)
          const oi    = c.openInterest ?? 0;
          const minOI = LOW_OI_TICKERS.has(target.ticker) ? 500 : MIN_OI;
          if (oi < minOI) continue;

          // IV bounds
          const iv = c.impliedVolatility ?? 0;
          if (iv <= 0 || iv > MAX_IV) continue;

          // OTM distance
          const pctOtm = ((c.strike - spot) / spot) * 100;
          if (Math.abs(pctOtm) > 10) continue;

          // Delta — quality zone
          const delta = Math.abs(bsDelta(spot, c.strike, dte, iv, isCallMode));
          if (delta < MIN_DELTA || delta > MAX_DELTA) continue;

          // Volume: preferred ≥1000, waived if OI is strong (threshold relaxed for thin-chain tickers)
          const volume        = c.volume ?? 0;
          const volumeWaiver  = LOW_OI_TICKERS.has(target.ticker) ? 1_000 : 2_000;
          if (volume < 1_000 && oi < volumeWaiver) continue;

          contractsPassed++;

          // ── Expansion potential + scoring ───────────────────────────────
          const ep = calcExpansionPotential(compression, breakout, ta, regimeBonus, iv);

          const atmScore       = Math.max(0, 1 - Math.abs(pctOtm) / 10);
          const liquidityScore = Math.min(1, Math.log10(Math.max(1, volume)) / 4);
          const oiScore        = Math.min(1, Math.log10(Math.max(1, oi)) / 3);
          const spreadScore    = Math.max(0, 1 - spreadPct / MAX_SPREAD_PCT);
          const monthlyBonus   = isMonthly ? 1.1 : 1.0;
          const tfBonus        = ta.strongTimeframes.length / TIMEFRAMES.length;

          const ivPct    = iv * 100;
          const ivQuality = ivPct >= 20 && ivPct <= 70
            ? 1.0
            : ivPct < 20
              ? (ivPct / 20) * 0.8
              : Math.max(0.2, 1 - (ivPct - 70) / 100);

          const expansionNorm   = ep / 100;
          const expansionFactor = 0.4 + 0.6 * expansionNorm;
          const tfAlignFactor   = 0.5 + 0.5 * tfBonus;
          const regimeFactor    = regime === "CONFLICTED"
            ? (1 + regimeBonus / 40) * 0.80
            : 1 + regimeBonus / 40;

          const score = ta.score
            * expansionFactor
            * atmScore
            * liquidityScore
            * oiScore
            * spreadScore
            * monthlyBonus
            * tfAlignFactor
            * ivQuality
            * regimeFactor;

          const setup: OptionSetup = {
            ticker: target.ticker, optionType, strikePrice: c.strike,
            expiryDate, dte, isMonthly, bid, ask, contractCost, spreadPct,
            volume, openInterest: oi, iv, delta, underlyingPrice: spot,
            pctOtm, ta, compressionState: compression.compressionState,
            expansionPotential: ep,
            breakoutType:  breakout.breakoutType,
            triggerLevel:  breakout.triggerLevel,
            volumeSpike:   breakout.volumeSpike,
            scoreBreakdown: {
              taStrength:   ta.score,
              expansion:    expansionFactor,
              atm:          atmScore,
              liquidity:    liquidityScore,
              oi:           oiScore,
              spread:       spreadScore,
              tfAlignment:  tfAlignFactor,
              ivQuality,
              regimeFactor,
              monthly:      monthlyBonus,
            },
            conflictedRegime: regime === "CONFLICTED",
            score,
          };
          (regime === "CONFLICTED" ? conflictedSetups : setups).push(setup);
        }
      } catch (err) {
        console.error(`[scanner] ${target.ticker} error:`, (err as Error).message);
      }
    }

    // Allow top-1 conflicted setup through (with 0.80 regimeFactor penalty already applied)
    if (conflictedSetups.length > 0) {
      conflictedSetups.sort((a, b) => b.score - a.score);
      setups.push(conflictedSetups[0]);
    }

    setups.sort((a, b) => b.score - a.score);

    // Mark tickers that produced qualifying contracts as READY
    const readyTickers = new Set(setups.map(s => s.ticker));
    for (const ticker of readyTickers) {
      stateMap.set(ticker, { ticker, status: "READY", compressionScore: 1, compressionState: "EXPANSION READY", stopReason: "signal active" });
    }

    const tickerStates = Array.from(stateMap.values());
    console.log(`[scanner] ${setups.length} qualifying setups | Regime: ${regime} | contracts: ${contractsEvaluated} evaluated, ${contractsPassed} passed`);
    return { scannedAt, regime, regimeBonus, spyLabel, qqqLabel, setups, skippedEarnings, tickerStates, contractsEvaluated, contractsPassed };
  }
}
