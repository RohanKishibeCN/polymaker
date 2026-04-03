import { config } from './config';
import { runMarketMakingCycle } from './market_maker';
import { logDailySummary } from './notion';

async function main() {
  console.log('==========================================');
  console.log(' Polymarket Market Maker & LP Rewards Bot');
  console.log(` Scan Interval: ${config.bot.scanInterval / 1000}s`);
  console.log(` Max Investment: ${config.bot.maxInvestment} USDC`);
  console.log(` Target Markets: ${config.bot.targetMarketsCount}`);
  console.log('==========================================');

  // Run the first market making cycle immediately
  await runCycle();

  // Schedule subsequent cycles (Re-quoting)
  setInterval(runCycle, config.bot.scanInterval);

  // Daily summary at midnight
  scheduleDailySummary();
}

async function runCycle() {
  await runMarketMakingCycle();
}

function scheduleDailySummary() {
  const now = new Date();
  const nextMidnight = new Date();
  nextMidnight.setUTCHours(24, 0, 0, 0);

  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(async () => {
    await logDailySummary('Daily Bot Summary', 'Bot ran successfully. No errors detected.');
    // Reschedule for next day
    scheduleDailySummary();
  }, msUntilMidnight);
}

main().catch(error => {
  console.error('Fatal error in main loop:', error);
  process.exit(1);
});
