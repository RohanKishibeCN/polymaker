import { config } from './config';
import { initClobClient, runMarketMakingCycle, runDailySummary, startHeartbeat } from './market_maker';

async function main() {
  console.log('==========================================');
  console.log(' Polymarket Market Maker & LP Rewards Bot');
  console.log(` Scan Interval: ${config.bot.scanIntervalMs / 1000}s`);
  console.log(` Max Markets: ${config.bot.maxMarkets}`);
  console.log('==========================================');

  await initClobClient();

  startHeartbeat();

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
  setTimeout(runCycleLoop, config.bot.scanIntervalMs);
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
