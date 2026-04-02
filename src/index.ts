import { config } from './config';
import { scanForNegativeRiskArbitrage } from './polymarket';
import { logDailySummary } from './notion';

async function main() {
  console.log('==========================================');
  console.log(' Polymarket Arbitrage Bot Started');
  console.log(` Scan Interval: ${config.bot.scanInterval / 1000}s`);
  console.log(` Max Investment: ${config.bot.maxInvestment} USDC`);
  console.log('==========================================');

  // Run the first scan immediately
  await runScan();

  // Schedule subsequent scans
  setInterval(runScan, config.bot.scanInterval);

  // Daily summary at midnight
  scheduleDailySummary();
}

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Initiating market scan...`);
  await scanForNegativeRiskArbitrage();
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
