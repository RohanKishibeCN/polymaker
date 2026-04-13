import { config } from './config';
import { runMarketMakingCycle, runDailySummary } from './market_maker';

async function main() {
  console.log('==========================================');
  console.log(' Polymarket Market Maker & LP Rewards Bot');
  console.log(` Scan Interval: ${config.bot.scanInterval / 1000}s`);
  console.log(` Target Markets: ${config.bot.targetMarketsCount}`);
  console.log(` Size Pct: ${config.bot.sizePct * 100}%, Max Market Pct: ${config.bot.maxMarketPct * 100}%`);
  console.log('==========================================');

  // Run the first market making cycle immediately and recursively schedule subsequent cycles
  await runCycleLoop();

  // Daily summary at midnight UTC (8:00 AM Beijing Time)
  scheduleDailySummary();
}

async function runCycleLoop() {
  try {
    await runMarketMakingCycle();
  } catch (e: any) {
    console.error(`[Market Maker] Cycle error: ${e.message}`);
  }
  // Schedule next cycle only after the current one completes
  setTimeout(runCycleLoop, config.bot.scanInterval);
}

function scheduleDailySummary() {
  const now = new Date();
  const nextMidnight = new Date();
  nextMidnight.setUTCHours(24, 0, 0, 0);

  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(async () => {
    try {
      await runDailySummary();
    } catch (e: any) {
      console.error(`[Daily Summary Schedule] Error: ${e.message}`);
    }
    // Reschedule for next day
    scheduleDailySummary();
  }, msUntilMidnight);
}

main().catch(error => {
  console.error('Fatal error in main loop:', error);
  process.exit(1);
});
