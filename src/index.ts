import { config } from './config';
import { initClobClient, runMarketMakingCycle, runForceLiquidation, runDailySummary, startHeartbeat } from './market_maker';

async function main() {
  console.log('==========================================');
  console.log(' Polymarket Market Maker & LP Rewards Bot');
  console.log(` Scan Interval: ${config.bot.scanIntervalMs / 1000}s`);
  console.log(` Target Markets: ${config.bot.targetMarketsCount}`);
  console.log(` Size Pct: ${config.bot.sizePct * 100}%, Max Market Pct: ${config.bot.maxMarketPct * 100}%`);
  console.log('==========================================');

  await initClobClient();

  startHeartbeat();

  // Run the first market making cycle immediately and recursively schedule subsequent cycles
  await runCycleLoop();

  // 快速清仓子循环（每 2 分钟运行一次，独立于主循环）
  runLiquidationLoop();

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

function runLiquidationLoop() {
  setTimeout(async () => {
    try {
      await runForceLiquidation();
    } catch (e: any) {
      console.warn(`[FastLiq] Loop error: ${e.message}`);
    }
    runLiquidationLoop();
  }, 2 * 60 * 1000);  // 每 2 分钟
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
