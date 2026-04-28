import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const INVENTORY_FILE = path.join(__dirname, '../inventory_state.json');
const RADAR_FILE = path.join(__dirname, '../radar_signals.json');
const TMP_FILE = path.join(__dirname, '../radar_signals.tmp');
const SOS_FILE = path.join(__dirname, '../radar_sos.json');
const QUOTA_LOCK_FILE = path.join(__dirname, '../.quota_exhausted_until');

interface RadarSignals {
  last_updated: number;
  markets: Record<string, {
    status?: 'ACTIVE' | 'HALTED';
    smart_money_bias?: 'YES' | 'NO' | 'NEUTRAL';
    arbitrage_spread?: number;
    reason?: string;
    updated_at: number; // Fine-grained TTL
  }>;
  target_whitelist: Record<string, {
    updated_at: number; // Fine-grained TTL
  }>;
}

function checkQuotaLock(): boolean {
  if (fs.existsSync(QUOTA_LOCK_FILE)) {
    const lockUntil = parseInt(fs.readFileSync(QUOTA_LOCK_FILE, 'utf8'), 10);
    if (!isNaN(lockUntil) && Date.now() < lockUntil) {
      return true; // Still locked
    } else {
      fs.unlinkSync(QUOTA_LOCK_FILE); // Unlock
    }
  }
  return false;
}

function handleQuotaExhausted() {
  console.error(`[Surf Radar] Quota exhausted (Exit Code 4). Sleeping until tomorrow...`);
  // Sleep until 00:00 UTC tomorrow
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  fs.writeFileSync(QUOTA_LOCK_FILE, tomorrow.getTime().toString(), 'utf8');
}

function readRadarSignals(): RadarSignals {
  let signals: RadarSignals = {
    last_updated: Date.now(),
    markets: {},
    target_whitelist: {}
  };
  try {
    if (fs.existsSync(RADAR_FILE)) {
      const existing = JSON.parse(fs.readFileSync(RADAR_FILE, 'utf8'));
      if (existing && existing.markets) {
        signals.markets = existing.markets;
      }
      if (existing && existing.target_whitelist) {
        // Migrate old array format to object format
        if (Array.isArray(existing.target_whitelist)) {
           for (const id of existing.target_whitelist) {
             signals.target_whitelist[id] = { updated_at: Date.now() };
           }
        } else {
           signals.target_whitelist = existing.target_whitelist;
        }
      }
    }
  } catch (e) {
    console.warn(`[Surf Radar] Could not parse existing radar signals, starting fresh.`);
  }
  return signals;
}

function writeAtomic(data: RadarSignals) {
  data.last_updated = Date.now();
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, RADAR_FILE);
}

// Action 1: Smart Money Scan
function runAction1() {
  if (checkQuotaLock()) return;
  console.log(`[Surf Radar] [Action 1] Starting Smart Money Scan...`);
  
  let topMarkets: string[] = [];
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
      topMarkets = inventory.top_markets || [];
    }
  } catch (e) {
    console.warn(`[Surf Radar] Could not read inventory state:`, e);
  }

  const signals = readRadarSignals();

  for (const conditionId of topMarkets.slice(0, 3)) {
    try {
      console.log(`[Surf Radar] Scanning Smart Money for condition: ${conditionId}`);
      const output = execSync(`npx surf polymarket-smart-money --condition-id ${conditionId} --view summary`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      
      let bias: 'YES' | 'NO' | 'NEUTRAL' = 'NEUTRAL';
      const outputLower = output.toLowerCase();
      
      if (outputLower.includes('smart_money_bias: yes') || outputLower.includes('"smart_money_bias":"yes"')) {
        bias = 'YES';
      } else if (outputLower.includes('smart_money_bias: no') || outputLower.includes('"smart_money_bias":"no"')) {
        bias = 'NO';
      }

      if (!signals.markets[conditionId]) {
        signals.markets[conditionId] = { updated_at: Date.now() };
      }
      signals.markets[conditionId].smart_money_bias = bias;
      signals.markets[conditionId].updated_at = Date.now();
      signals.markets[conditionId].reason = `Smart money scanned at ${new Date().toISOString()}`;
      
    } catch (e: any) {
      if (e.status === 4) {
        handleQuotaExhausted();
        break;
      }
      console.warn(`[Surf Radar] Error scanning smart money for ${conditionId}`);
    }
  }
  writeAtomic(signals);
}

// Action 2: Arbitrage Discovery
function runAction2() {
  if (checkQuotaLock()) return;
  console.log(`[Surf Radar] [Action 2] Discovering arbitrage opportunities...`);
  
  const signals = readRadarSignals();
  try {
    const output = execSync(`npx surf matching-market-pairs --active-only true --sort-by price_diff_pct --order desc --limit 5`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    
    const regex = /0x[a-fA-F0-9]{64}/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      const id = match[0];
      signals.target_whitelist[id] = { updated_at: Date.now() };
    }
  } catch (e: any) {
    if (e.status === 4) {
      handleQuotaExhausted();
    } else {
      console.warn(`[Surf Radar] Error scanning arbitrage pairs`);
    }
  }
  writeAtomic(signals);
}

// Action 3: SOS Wakeup (Sudden spread / price jump)
function runAction3(conditionId: string, title: string) {
  if (checkQuotaLock()) {
    console.log(`[Surf Radar] [Action 3] Quota locked. Cannot process SOS for ${conditionId}`);
    return;
  }
  console.log(`[Surf Radar] [Action 3] SOS Triggered for market: ${conditionId} (${title})`);
  
  const signals = readRadarSignals();
  try {
    // Search for breaking news that might explain the spread/jump
    const cleanTitle = title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 50);
    const output = execSync(`npx surf search-news --q "${cleanTitle}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    
    const outputLower = output.toLowerCase();
    // A simple heuristic: if news mentions "breaking", "confirmed", "suspended", "sold", "scandal", "arrested" etc.
    const dangerousKeywords = ['breaking', 'confirmed', 'suspended', 'scandal', 'arrested', 'guilty', 'dead', 'resigns', 'hacked'];
    let isDangerous = false;
    for (const kw of dangerousKeywords) {
       if (outputLower.includes(kw)) {
           isDangerous = true;
           break;
       }
    }

    if (!signals.markets[conditionId]) {
      signals.markets[conditionId] = { updated_at: Date.now() };
    }

    if (isDangerous) {
       console.log(`[Surf Radar] [!] DANGER DETECTED for ${conditionId}. Halting market.`);
       signals.markets[conditionId].status = 'HALTED';
       signals.markets[conditionId].reason = `Breaking news detected via SOS at ${new Date().toISOString()}`;
    } else {
       console.log(`[Surf Radar] [i] No danger detected for ${conditionId}. Normal fluctuation.`);
       signals.markets[conditionId].status = 'ACTIVE';
       signals.markets[conditionId].reason = `SOS triggered but no breaking news found at ${new Date().toISOString()}`;
    }
    signals.markets[conditionId].updated_at = Date.now();

  } catch (e: any) {
    if (e.status === 4) {
      handleQuotaExhausted();
    } else {
      console.warn(`[Surf Radar] Error processing SOS for ${conditionId}`);
    }
  }
  writeAtomic(signals);
}

// Daemon Mode
console.log(`[Surf Radar] Daemon started.`);

// Create empty SOS file if not exists
if (!fs.existsSync(SOS_FILE)) {
  fs.writeFileSync(SOS_FILE, JSON.stringify({ requests: [] }), 'utf8');
}

// Watch SOS File
let sosTimeout: NodeJS.Timeout | null = null;
fs.watch(SOS_FILE, (eventType) => {
  if (eventType === 'change') {
    if (sosTimeout) clearTimeout(sosTimeout);
    sosTimeout = setTimeout(() => {
       try {
         const data = JSON.parse(fs.readFileSync(SOS_FILE, 'utf8'));
         if (data.requests && data.requests.length > 0) {
           for (const req of data.requests) {
             // Process requests that are less than 5 minutes old
             if (Date.now() - req.timestamp < 5 * 60 * 1000) {
               runAction3(req.condition_id, req.title);
             }
           }
           // Clear processed requests
           fs.writeFileSync(SOS_FILE, JSON.stringify({ requests: [] }), 'utf8');
         }
       } catch(e) {
         // ignore parsing errors from partial writes
       }
    }, 1000); // Debounce 1s
  }
});

// Schedule Action 1 (Every 6 hours)
setInterval(runAction1, 6 * 60 * 60 * 1000);

// Schedule Action 2 (Every 12 hours)
setInterval(runAction2, 12 * 60 * 60 * 1000);

// Run initial scans
runAction1();
runAction2();