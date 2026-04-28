import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const INVENTORY_FILE = path.join(__dirname, '../inventory_state.json');
const RADAR_FILE = path.join(__dirname, '../radar_signals.json');
const TMP_FILE = path.join(__dirname, '../radar_signals.tmp');

interface RadarSignals {
  last_updated: number;
  markets: Record<string, {
    status?: 'ACTIVE' | 'HALTED';
    smart_money_bias?: 'YES' | 'NO' | 'NEUTRAL';
    arbitrage_spread?: number;
    reason?: string;
  }>;
  target_whitelist: string[];
}

function runRadar() {
  console.log(`[Surf Radar] Starting heartbeat scan...`);
  
  let signals: RadarSignals = {
    last_updated: Date.now(),
    markets: {},
    target_whitelist: []
  };

  // 1. Read existing radar signals to merge/preserve data
  try {
    if (fs.existsSync(RADAR_FILE)) {
      const existing = JSON.parse(fs.readFileSync(RADAR_FILE, 'utf8'));
      if (existing && existing.markets) {
        signals.markets = existing.markets;
        signals.target_whitelist = existing.target_whitelist || [];
      }
    }
  } catch (e) {
    console.warn(`[Surf Radar] Could not parse existing radar signals, starting fresh.`);
  }

  // Update timestamp
  signals.last_updated = Date.now();

  // 2. Read inventory state to find Top 3 markets
  let topMarkets: string[] = [];
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
      topMarkets = inventory.top_markets || [];
    }
  } catch (e) {
    console.warn(`[Surf Radar] Could not read inventory state:`, e);
  }

  // 3. Action 1: Smart Money Bias (Top 3 markets)
  for (const conditionId of topMarkets.slice(0, 3)) {
    try {
      console.log(`[Surf Radar] Scanning Smart Money for condition: ${conditionId}`);
      const output = execSync(`surf polymarket-smart-money --condition-id ${conditionId} --view summary`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      
      // Parse output. The CLI might output JSON or text. We assume it contains JSON or keywords.
      // If the command is an AI tool, it might output a JSON block or text like "bias: YES"
      // Since we don't have the exact output format, let's try to extract JSON.
      let bias: 'YES' | 'NO' | 'NEUTRAL' = 'NEUTRAL';
      const outputLower = output.toLowerCase();
      
      if (outputLower.includes('smart_money_bias: yes') || outputLower.includes('"smart_money_bias":"yes"')) {
        bias = 'YES';
      } else if (outputLower.includes('smart_money_bias: no') || outputLower.includes('"smart_money_bias":"no"')) {
        bias = 'NO';
      }

      if (!signals.markets[conditionId]) {
        signals.markets[conditionId] = {};
      }
      signals.markets[conditionId].smart_money_bias = bias;
      signals.markets[conditionId].reason = `Smart money scanned at ${new Date().toISOString()}`;
      
    } catch (e: any) {
      if (e.status === 4) {
        console.error(`[Surf Radar] Quota exhausted (Exit Code 4). Sleeping radar.`);
        // Stop radar operations for today by writing current state and exiting.
        writeAtomic(signals);
        process.exit(0);
      }
      console.warn(`[Surf Radar] Error scanning smart money for ${conditionId}`);
    }
  }

  // 4. Action 2: Arbitrage Spread (Discovery)
  try {
    console.log(`[Surf Radar] Discovering arbitrage opportunities...`);
    const output = execSync(`surf matching-market-pairs --active-only true --sort-by price_diff_pct --order desc --limit 5`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    
    // We assume the output contains token IDs or condition IDs.
    // For this implementation, we will mock parsing or rely on the actual command returning JSON.
    const whitelist: string[] = [];
    const regex = /0x[a-fA-F0-9]{64}/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      whitelist.push(match[0]);
    }
    if (whitelist.length > 0) {
      signals.target_whitelist = [...new Set([...signals.target_whitelist, ...whitelist])];
    }
  } catch (e: any) {
    if (e.status === 4) {
      console.error(`[Surf Radar] Quota exhausted (Exit Code 4). Sleeping radar.`);
      writeAtomic(signals);
      process.exit(0);
    }
    console.warn(`[Surf Radar] Error scanning arbitrage pairs`);
  }

  // 5. Write to contract file
  writeAtomic(signals);
  console.log(`[Surf Radar] Scan complete. Signals updated.`);
}

function writeAtomic(data: RadarSignals) {
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, RADAR_FILE);
}

runRadar();
