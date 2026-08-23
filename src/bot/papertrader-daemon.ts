/**
 * Persistent paper trading daemon.
 *
 * Intended to be started ONCE per trading day (via a scheduled task around
 * market open, with "wake the computer to run this task" enabled) rather
 * than fired repeatedly by the task scheduler. Waits for market open if
 * started early, then runs a tick every 15 minutes until market close, then
 * exits — restarted fresh the next trading day by the scheduled task.
 *
 * A tick that throws is caught and logged, not fatal — one bad tick
 * (network blip, API hiccup) shouldn't kill monitoring for the rest of the
 * day.
 *
 * Note: this closes the "task got skipped" and "PC was asleep at the
 * trigger time" gaps (the latter via the scheduled task's wake-to-run
 * setting), but NOT the "PC goes back to sleep mid-day" gap — OS sleep
 * suspends this process along with everything else. Preventing idle sleep
 * during market hours is a separate, complementary fix.
 */

import { runTick } from "./papertrader.js";

const TICK_INTERVAL_MS   = 15 * 60 * 1000;
const STARTUP_POLL_MS    = 60 * 1000; // how often to re-check "has the market opened yet"
const MARKET_OPEN_MIN    = 9 * 60 + 30;  // 9:30 AM ET
const MARKET_CLOSE_MIN   = 16 * 60;      // 4:00 PM ET

function getEasternParts(): { weekday: string; minutesSinceMidnight: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === "weekday")!.value;
  const hour    = parseInt(parts.find(p => p.type === "hour")!.value, 10);
  const minute  = parseInt(parts.find(p => p.type === "minute")!.value, 10);
  return { weekday, minutesSinceMidnight: hour * 60 + minute };
}

function isWeekday(): boolean {
  const { weekday } = getEasternParts();
  return weekday !== "Sat" && weekday !== "Sun";
}
function isBeforeOpen(): boolean {
  return getEasternParts().minutesSinceMidnight < MARKET_OPEN_MIN;
}
function isAfterClose(): boolean {
  return getEasternParts().minutesSinceMidnight > MARKET_CLOSE_MIN;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!isWeekday()) {
    console.log("[daemon] Weekend — nothing to do, exiting.");
    return;
  }

  while (isBeforeOpen()) {
    console.log("[daemon] Before market open — waiting...");
    await sleep(STARTUP_POLL_MS);
  }

  if (isAfterClose()) {
    console.log("[daemon] Started after market close — nothing to do today, exiting.");
    return;
  }

  console.log("[daemon] Market open — starting tick loop (every 15 min until close).");
  while (!isAfterClose()) {
    try {
      await runTick();
    } catch (err) {
      console.error("[daemon] Tick failed (continuing):", err);
    }
    if (isAfterClose()) break;
    await sleep(TICK_INTERVAL_MS);
  }

  console.log("[daemon] Market closed — exiting for the day.");
}

main().catch(err => {
  console.error("[daemon] Fatal:", err);
  process.exit(1);
});
