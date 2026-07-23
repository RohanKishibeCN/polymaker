import { Chain, ClobClient, Side, SignatureTypeV2, AssetType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

import { config } from './config';
import { logTrade, logDailySummary } from './notion';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { Headers, Request, Response } from 'node-fetch';
import https from 'https';
import fs from 'fs';
import path from 'path';

// 初始化专门用于 Polymarket 请求的代理 Agent
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
let proxyAgent: HttpsProxyAgent<string> | undefined;

if (proxyUrl) {
  console.log(`[Market Maker] Initializing targeted proxy agent for Polymarket requests...`);
  proxyAgent = new HttpsProxyAgent(proxyUrl);
  
  // 核心杀招：删除环境变量，防止 undici/axios 自动读取并在底层报错。
  // 同时解放了后续 Notion 和 RPC 请求，让它们默认走直连，大幅节省代理流量！
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  process.env.NO_PROXY = '*';

  // [Geoblock Fix - Dual Package Hazard]
  // 由于项目是 CommonJS，而 @polymarket/clob-client 是 ESM，导致内存中存在两个隔离的 axios 实例。
  // 直接修改 `import axios from 'axios'` 无法影响到 clob-client 内部的 axios 实例。
  // 因此，我们采用最底层、最精准的拦截：只对发往 polymarket.com 的原生 https 请求注入代理。
  const originalHttpsRequest = https.request;
  
  // @ts-ignore
  https.request = function(options: any, ...args: any[]) {
    // 精准匹配，只有 polymarket 的 API 走代理，Notion 和 RPC 保持直连
    if (options && options.host && typeof options.host === 'string' && options.host.includes('polymarket.com')) {
      options.agent = proxyAgent;
    } else if (options && options.hostname && typeof options.hostname === 'string' && options.hostname.includes('polymarket.com')) {
      options.agent = proxyAgent;
    }
    // @ts-ignore
    return originalHttpsRequest(options, ...args);
  };
}

// Initialize Wallet & Client using viem (matching @polymarket/clob-client-v2 official Quickstart)
const privateKey = config.polymarket.privateKey.startsWith('0x')
  ? config.polymarket.privateKey as `0x${string}`
  : `0x${config.polymarket.privateKey}` as `0x${string}`;

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http('https://polygon-rpc.com'),
});

// 定制化的 axios httpsAgent，供 clob-client 内部使用
const axiosHttpsAgent = proxyAgent ? proxyAgent : new https.Agent();

async function _initClobClient(): Promise<any> {
  let creds = {
    key: config.polymarket.apiKey,
    secret: config.polymarket.secret,
    passphrase: config.polymarket.passphrase,
  };

  if (!creds.key) {
    console.log('[Market Maker] No existing API credentials. Deriving new ones...');
    const tempClient = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: Chain.POLYGON,
      signer: walletClient,
    });
    const newCreds = await tempClient.createOrDeriveApiKey();
    creds = { key: newCreds.key, secret: newCreds.secret, passphrase: newCreds.passphrase };
    // Save to .env for subsequent restarts
    try {
      const fs = await import('fs');
      const path = await import('path');
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/^POLYMARKET_API_KEY=.*$/m, `POLYMARKET_API_KEY="${newCreds.key}"`);
        envContent = envContent.replace(/^POLYMARKET_API_SECRET=.*$/m, `POLYMARKET_API_SECRET="${newCreds.secret}"`);
        envContent = envContent.replace(/^POLYMARKET_API_PASSPHRASE=.*$/m, `POLYMARKET_API_PASSPHRASE="${newCreds.passphrase}"`);
        fs.writeFileSync(envPath, envContent);
        console.log('[Market Maker] Saved new credentials to .env');
      }
    } catch (e: any) {
      console.warn('[Market Maker] Could not save credentials:', e.message);
    }
  }

  const client = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: Chain.POLYGON,
    signer: walletClient,
    throwOnError: true,
    retryOnError: true,
    creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS_PROXY || config.polymarket.funderAddress),
  });

  // @ts-ignore
  if (client.axiosInstance) {
    // @ts-ignore
    client.axiosInstance.defaults.httpsAgent = axiosHttpsAgent;
  }

  // Step 5 from docs: Sync CLOB balances to link API key with deposit wallet
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log('[Market Maker] Balance allowance synced for deposit wallet.');
  } catch (e: any) {
    console.warn('[Market Maker] updateBalanceAllowance error:', e.message);
  }

  return client;
}

let clobClient: any;

export async function initClobClient() {
  clobClient = await _initClobClient();
  return clobClient;
}

// CLOB V2 要求每 10 秒发送 heartbeat，否则服务器自动取消所有订单
// 注意：部分 API 密钥因服务端原因会持续报 Invalid Heartbeat ID，不影响订单
let heartbeatId = '';
export function startHeartbeat() {
  setInterval(async () => {
    try {
      const resp = await clobClient.postHeartbeat(heartbeatId);
      heartbeatId = resp.heartbeat_id || '';
    } catch (e: any) {
      if (e?.response?.data?.error_msg?.includes('Invalid Heartbeat ID')) {
        heartbeatId = '';
      } else if (e?.response?.data?.heartbeat_id) {
        heartbeatId = e.response.data.heartbeat_id;
      }
      // network error: keep current heartbeatId, retry next interval
    }
  }, 30000);
  console.log(`[Market Maker] Heartbeat started (30s interval).`);
}

// 简单内存状态，记录我们在每个市场的持仓情况
// 注意：VPS 重启后会清零。如果要严格风控，应该存在本地 SQLite 中
const inventory: Record<string, { yes: number, no: number, avgCost?: number, pnlPct?: number }> = {};

async function createAndPostOrderWithFeeFallback(orderPayload: any, tickSize: string, negRisk: boolean) {
  try {
    // postOnly 防止吃单：如果价格会 cross spread，拒绝而不是执行
    return await clobClient.createAndPostOrder(orderPayload, { tickSize, negRisk, postOnly: true }, "GTC");
  } catch (e: any) {
    return { error: e.message };
  }
}
// Notion 总结需要的数据
let dailyStats: any = {
  fillsBuy: 0,
  fillsSell: 0,
  ordersPosted: 0,
  ordersCanceled: 0,
  circuitBreakTriggers: 0,
  maxPositionPctEquity: 0,
  avgSpreadHalfUsed: 0,
  spreadHalfUsedCount: 0,
  cycleBuyCount: 0,
  cycleSellCount: 0,
};

let peakEquity = config.bot.initialCapital;
let priorInventorySnapshot: Map<string, number> = new Map();

const BALANCE_LOG_FILE = path.join(__dirname, '../balance_log.json');
let yesterdayBalance: number | null = null;
try {
  if (fs.existsSync(BALANCE_LOG_FILE)) {
    const log = JSON.parse(fs.readFileSync(BALANCE_LOG_FILE, 'utf8'));
    yesterdayBalance = log.balance;
  }
} catch (e) {}

// L2-1: 每轮 cycle 记录 balance 快照用于验证真实 PnL 和 rebate
const BALANCE_SNAPSHOT_FILE = path.join(__dirname, '../balance_snapshot.json');
let prevCycleCash = 0;
try {
  if (fs.existsSync(BALANCE_SNAPSHOT_FILE)) {
    const snap = JSON.parse(fs.readFileSync(BALANCE_SNAPSHOT_FILE, 'utf8'));
    prevCycleCash = snap.cash || 0;
  }
} catch (e) {}

function saveBalanceLog(balance: number) {
  try {
    fs.writeFileSync(BALANCE_LOG_FILE, JSON.stringify({ balance, date: new Date().toISOString().split('T')[0] }), 'utf8');
  } catch (e) {}
}

function saveBalanceSnapshot(cash: number) {
  try {
    fs.writeFileSync(BALANCE_SNAPSHOT_FILE, JSON.stringify({ cash, date: new Date().toISOString() }), 'utf8');
  } catch (e) {}
}

function roundToTickSize(price: number, tickSize: string): number {
  const ts = parseFloat(tickSize) || 0.01;
  return Number((Math.round(price / ts) * ts).toFixed(4));
}

function getValidTokenIds(rawTokenId: any): [string, string] | null {
  if (!rawTokenId) return null;

  if (typeof rawTokenId === 'string' && rawTokenId.startsWith('[')) {
    try {
      if (rawTokenId === '[') return null;

      const validJsonStr = rawTokenId.replace(/'/g, '"');
      const parsedArray = JSON.parse(validJsonStr);
      return Array.isArray(parsedArray) && parsedArray.length >= 2 ? [parsedArray[0], parsedArray[1]] : null; 
    } catch (error) {
      return null;
    }
  }

  if (Array.isArray(rawTokenId) && rawTokenId.length >= 2) {
    return [rawTokenId[0], rawTokenId[1]];
  }

  return null;
}

// 记录每天是否已经推送过总结
let lastSummaryDateStr = '';

const COLLATERAL_SYMBOL = (process.env.POLYMARKET_COLLATERAL_SYMBOL || 'USDC').trim() || 'USDC';
let cachedCollateralDecimals: number | undefined;

async function getCollateralDecimals(collateralAddress: string): Promise<number> {
  const envDecimalsRaw = (process.env.POLYMARKET_COLLATERAL_DECIMALS || '').trim();
  if (envDecimalsRaw) {
    const n = parseInt(envDecimalsRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 36) return n;
  }

  if (cachedCollateralDecimals !== undefined) return cachedCollateralDecimals;

  const rpcUrl = process.env.RPC_URL || 'https://polygon-rpc.com';
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: collateralAddress, data: "0x313ce567" }, "latest"]
    })
  });
  const rpcData = await response.json();
  if (rpcData && rpcData.result) {
    const decimals = parseInt(rpcData.result, 16);
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 36) {
      cachedCollateralDecimals = decimals;
      return decimals;
    }
  }

  cachedCollateralDecimals = 6;
  return 6;
}

// 获取稳定币余额辅助函数
let lastGoodCashBalance = 0;
const CASH_RPC_LIST = [
  process.env.RPC_URL,
  'https://polygon-bor.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://polygon-rpc.com',
].filter(Boolean) as string[];

async function getCashBalance(): Promise<number> {
  for (const rpcUrl of CASH_RPC_LIST) {
    try {
      const envCollateral = (process.env.POLYMARKET_COLLATERAL_ADDRESS || '').trim();
      const collateralAddress = envCollateral
        ? envCollateral
        : '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';  // pUSD
      const userAddress = config.polymarket.funderAddress;
      const cleanAddress = userAddress.replace(/^0x/i, '').padStart(64, '0');
      const data = `0x70a08231${cleanAddress}`;

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: collateralAddress, data: data }, "latest"]
        })
      });
      const rpcData = await response.json();
      if (rpcData && rpcData.result) {
        const decimals = await getCollateralDecimals(collateralAddress);
        const raw = BigInt(rpcData.result);
        const divisor = 10n ** BigInt(decimals);
        const whole = raw / divisor;
        const frac = raw % divisor;
        lastGoodCashBalance = Number(whole) + Number(frac) / Number(divisor);
        return lastGoodCashBalance;
      }
    } catch (e) {
      continue;
    }
  }
  console.warn(`[getCashBalance] All RPC endpoints failed. Using cached balance: ${lastGoodCashBalance}`);
  return lastGoodCashBalance;
}

export async function runDailySummary() {
  try {
    console.log(`[Daily Summary] Generating daily summary...`);

    // 1. 获取稳定币余额
    let cashBalance = await getCashBalance();

    // 2. 获取真实的各事件持仓明细和未实现盈亏
    let portfolioValue = 0;
    let positionsDetail = '';
    
    let activePositions: any[] = [];
    try {
      const positionsRes = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`, {
        agent: proxyAgent
      });
      const positions = await positionsRes.json();
      
      let index = 1;
      if (Array.isArray(positions)) {
        // Sort positions by currentValue (absolute exposure) descending to get Top 5
        activePositions = positions.filter(p => parseFloat(p.size) > 0);
        activePositions.sort((a, b) => (parseFloat(b.currentValue) || 0) - (parseFloat(a.currentValue) || 0));
        const losersPositions = [...activePositions].sort((a, b) => (parseFloat(a.cashPnl) || 0) - (parseFloat(b.cashPnl) || 0));
        
        for (const pos of activePositions) {
          const size = parseFloat(pos.size) || 0;
          const curPrice = parseFloat(pos.currentPrice) || 0;
          const cashPnl = parseFloat(pos.cashPnl) || 0;
          const currentValue = parseFloat(pos.currentValue) || 0;
          
          portfolioValue += currentValue;
          
          if (index <= 5) {
            // Truncate title to save Notion chars
            const shortTitle = pos.title ? pos.title.substring(0, 40) + (pos.title.length > 40 ? '...' : '') : 'Unknown';
            const pnlSign = cashPnl >= 0 ? '+' : '';
            positionsDetail += `${index}. [${shortTitle}] - ${size} ${pos.outcome} (Eq ~${currentValue.toFixed(2)} ${COLLATERAL_SYMBOL}) - PnL: ${pnlSign}${cashPnl.toFixed(2)}\n`;
          }
          index++;
        }
        
        if (activePositions.length > 5) {
          positionsDetail += `... and ${activePositions.length - 5} other smaller positions\n`;
        }

        if (losersPositions.length > 0) {
          positionsDetail += `\n📉 [LOSERS_TOP5]\n`;
          let loserIndex = 1;
          for (const pos of losersPositions.slice(0, 5)) {
            const size = parseFloat(pos.size) || 0;
            const cashPnl = parseFloat(pos.cashPnl) || 0;
            const currentValue = parseFloat(pos.currentValue) || 0;
            const shortTitle = pos.title ? pos.title.substring(0, 40) + (pos.title.length > 40 ? '...' : '') : 'Unknown';
            const pnlSign = cashPnl >= 0 ? '+' : '';
            positionsDetail += `${loserIndex}. [${shortTitle}] - ${size} ${pos.outcome} (Eq ~${currentValue.toFixed(2)} ${COLLATERAL_SYMBOL}) - PnL: ${pnlSign}${cashPnl.toFixed(2)}\n`;
            loserIndex++;
          }
        }
      }
    } catch (e: any) {
      console.log(`[Daily Summary] Failed to fetch positions: ${e.message}`);
    }

    if (positionsDetail === '') {
      positionsDetail = 'No active positions\n';
    }

    const totalEquity = cashBalance + portfolioValue;
    const initialCapital = config.bot.initialCapital;
    let totalPnL = totalEquity - initialCapital;
    let pnlPercent = (totalPnL / initialCapital) * 100;
    // RPC 失败时用初始资本避免虚假报告
    if (!Number.isFinite(totalEquity) || totalEquity <= 0) {
      totalPnL = 0;
      pnlPercent = 0;
    }

    // 3. 构建 Content (Notion Scheme A)
    let content = `📊 [ACCOUNT]\n`;
    content += `Equity: ~${totalEquity.toFixed(2)} ${COLLATERAL_SYMBOL} | Cash: ${cashBalance.toFixed(2)} ${COLLATERAL_SYMBOL}\n`;
    content += `PnL: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} ${COLLATERAL_SYMBOL} (${totalPnL >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%) | MaxDD: ${peakEquity > 0 ? ((peakEquity - totalEquity) / peakEquity * 100).toFixed(2) : '0.00'}%\n\n`;
    
    content += `🔄 [FLOW]\n`;
    content += `Orders Posted: ${dailyStats.ordersPosted} | Canceled: ${dailyStats.ordersCanceled}\n`;
    content += `Fills Buy/Sell: ${dailyStats.fillsBuy}/${dailyStats.fillsSell}\n`;
    if (yesterdayBalance !== null && yesterdayBalance > 0) {
      const estRewards = cashBalance - yesterdayBalance;
      if (estRewards > 0) content += `Est Rewards: +${estRewards.toFixed(2)} ${COLLATERAL_SYMBOL}\n`;
    }
    content += `\n`;
    
    content += `📦 [INVENTORY]\n`;
    content += `Max Pos %: ${(dailyStats.maxPositionPctEquity * 100).toFixed(2)}% | Circuit Breaks: ${dailyStats.circuitBreakTriggers}\n`;
    content += `Avg Spread: ±${dailyStats.avgSpreadHalfUsed.toFixed(3)}\n\n`;
    
    content += `⚠️ [RISK]\n`;
    const currentMaxDD = peakEquity > 0 ? ((peakEquity - totalEquity) / peakEquity * 100) : 0;
    if (currentMaxDD > 15) content += `⚠️ MaxDD ${currentMaxDD.toFixed(1)}% `;
    if (cashBalance < config.bot.reserveCashUsdc) content += `⚠️ Cash below reserve `;
    const largeLosers = activePositions.filter(p => parseFloat(p.cashPnl) < -20);
    if (largeLosers.length > 0) content += `⚠️ ${largeLosers.length} pos >20PUSD loss `;
    const deadPositions = activePositions.filter(p => parseFloat(p.currentValue) < 1 && parseFloat(p.size) > 0);
    if (deadPositions.length > 5) content += `⚠️ ${deadPositions.length} dead pos `;
    content += `\n\n`;

    content += `📈 [POSITIONS_TOP5]\n${positionsDetail}`;

    const dateStr = new Date().toISOString().split('T')[0];
    await logDailySummary(`Daily Summary: ${dateStr}`, content);
    saveBalanceLog(cashBalance);
    
    // Reset daily stats after summary
    dailyStats = {
      fillsBuy: 0,
      fillsSell: 0,
      ordersPosted: 0,
      ordersCanceled: 0,
      circuitBreakTriggers: 0,
      maxPositionPctEquity: 0,
      avgSpreadHalfUsed: 0,
      spreadHalfUsedCount: 0,
      cycleBuyCount: 0,
      cycleSellCount: 0,
    };

    peakEquity = totalEquity;
    saveBalanceLog(cashBalance);

  } catch (error) {
    console.error('[Daily Summary] Fatal error:', error);
  }
}

async function syncInventoryFromChain(): Promise<number> {
  let portfolioValue = 0;
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`, {
      agent: proxyAgent
    });
    const positions = await res.json();

    if (Array.isArray(positions)) {
      // 重置内存库存，避免残留脏数据（只在 API 成功返回有效数据后才清空）
      for (const key in inventory) {
        inventory[key].yes = 0;
        inventory[key].no = 0;
        inventory[key].avgCost = 0;
      }
      for (const pos of positions) {
        if (!inventory[pos.asset]) {
          inventory[pos.asset] = { yes: 0, no: 0, avgCost: 0 };
        }
        
        const size = parseFloat(pos.size) || 0;
        const avgPrice = parseFloat(pos.avgPrice) || 0;
        const cashPnl = parseFloat(pos.cashPnl) || 0;

        const currentValueRaw = parseFloat(pos.currentValue);
        if (Number.isFinite(currentValueRaw)) {
          portfolioValue += currentValueRaw;
        } else {
          const currentPriceRaw = parseFloat(pos.currentPrice);
          const currentPrice = Number.isFinite(currentPriceRaw) ? currentPriceRaw : 0;
          portfolioValue += size * currentPrice;
        }
        
        const pnlPct = (size * avgPrice) > 0 ? cashPnl / (size * avgPrice) : 0;

        if (pos.outcome === 'Yes' || pos.outcome === 'YES') {
          inventory[pos.asset].yes = size;
          inventory[pos.asset].avgCost = avgPrice;
          inventory[pos.asset].pnlPct = pnlPct;
        } else if (pos.outcome === 'No' || pos.outcome === 'NO') {
          inventory[pos.asset].no = size;
          inventory[pos.asset].avgCost = avgPrice;
          inventory[pos.asset].pnlPct = pnlPct;
        }
      }
    }
  } catch (e: any) {
    console.log(`[Market Maker] Failed to sync inventory from data-api: ${e.message}`);
  }
  return portfolioValue;
}

async function getPositionPriorityTokenIds(): Promise<Set<string>> {
  const tokenIds = new Set<string>();
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`, {
      agent: proxyAgent
    });
    const positions = await res.json();
    if (!Array.isArray(positions)) return tokenIds;

    const activePositions = positions.filter(p => parseFloat(p.size) > 0);
    const losers = [...activePositions].sort((a, b) => (parseFloat(a.cashPnl) || 0) - (parseFloat(b.cashPnl) || 0)).slice(0, 5);
    const exposure = [...activePositions].sort((a, b) => (parseFloat(b.currentValue) || 0) - (parseFloat(a.currentValue) || 0)).slice(0, 5);

    for (const p of [...losers, ...exposure]) {
      const asset = (p.asset || '').toString();
      if (asset) tokenIds.add(asset);
    }
  } catch (e) {
  }
  return tokenIds;
}

export async function runMarketMakingCycle() {
  try {
    console.log(`\n[${new Date().toISOString()}] =====================================`);
    console.log(`[Market Maker] Starting liquidity rewards cycle...`);

    // 1. 获取稳定币余额和权益
    let cashBalance = await getCashBalance();
    const reserveCashUsdc = config.bot.reserveCashUsdc;

    // 同步链上仓位（只读，用于日报统计）
    let portfolioValue = 0;
    try {
      await syncInventoryFromChain();
      for (const inv of Object.values(inventory)) {
        portfolioValue += (inv.yes || 0) * (inv.avgCost || 0.5) + (inv.no || 0) * (1 - (inv.avgCost || 0.5));
      }
    } catch (e: any) {
      console.warn(`[Market Maker] Sync inventory failed: ${e.message}`);
    }

    let totalEquity = cashBalance + portfolioValue;
    if (!Number.isFinite(totalEquity) || totalEquity <= 0) {
      totalEquity = config.bot.initialCapital;
    }
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    console.log(`[Market Maker] Current Equity: ~${totalEquity.toFixed(2)} ${COLLATERAL_SYMBOL}`);

    // 2. 获取有 Liquidity Rewards 的市场列表（优先用 SDK 的认证端点）
    console.log("[Market Maker] Fetching reward markets from CLOB API...");
    let rewardMarkets: any[] = [];
    try {
      rewardMarkets = await clobClient.getCurrentRewards();
      console.log(`[Market Maker] Found ${rewardMarkets.length} reward markets via CLOB API.`);
    } catch (e: any) {
      console.warn(`[Market Maker] CLOB getCurrentRewards failed: ${e?.message}. Falling back to Gamma.`);
    }

    // 如果 CLOB 成功，从 MarketReward 直接取 token IDs（不需要 Gamma）
    let candidates: any[] = [];
    if (rewardMarkets.length > 0) {
      console.log("[Market Maker] Building candidates from CLOB reward data...");
      for (const rm of rewardMarkets) {
        if (candidates.length >= 200) break;
        if (!rm.tokens || rm.tokens.length < 2) continue;
        const yesToken = rm.tokens.find((t: any) => t.outcome === 'Yes');
        const noToken = rm.tokens.find((t: any) => t.outcome === 'No');
        if (!yesToken || !noToken) continue;
        candidates.push({
          condition_id: rm.condition_id,
          eventTitle: rm.question || 'Unknown',
          yesTokenId: yesToken.token_id,
          noTokenId: noToken.token_id,
          midpoint: parseFloat(yesToken.price || '0.50'),
          rewardsMinSize: rm.rewards_min_size || 0,
          rewardsMaxSpread: rm.rewards_max_spread || 0,
        });
      }
      console.log(`[Market Maker] Built ${candidates.length} candidates from CLOB rewards.`);
    } else {
      // 降级：从 Gamma 所有市场扫描
      console.log("[Market Maker] Fetching active markets from Gamma API (fallback)...");
      const PAGES = 10;
      for (let page = 0; page < PAGES; page++) {
        try {
          const offset = page * 100;
          const url = `https://gamma-api.polymarket.com/markets?limit=100&offset=${offset}&active=true&closed=false&order=volume&ascending=false`;
          const resp = await fetch(url, {
            agent: proxyAgent,
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
          });
          const batch = await resp.json();
          if (Array.isArray(batch)) {
            for (const gm of batch) {
              if (candidates.length >= 200) break;
              if (!gm.active || gm.closed || !gm.clobTokenIds) continue;
              if (gm.neg_risk === true || gm.negRisk === true) continue;
              try {
                const outcomes: string[] = JSON.parse(gm.outcomes || '[]');
                if (outcomes.length !== 2 || outcomes[0] !== 'Yes' || outcomes[1] !== 'No') continue;
              } catch { continue; }
              // 放弃 reward 过滤（Gamma 不返回 reward 数据）
              // 这里直接把 market 加入候选，后面通过 price + volume 过滤
              candidates.push(gm);
            }
          }
          if (!Array.isArray(batch) || batch.length < 100) break;
          await new Promise(r => setTimeout(r, 100));
        } catch (e: any) {
          console.warn(`[Market Maker] Gamma page ${page} failed: ${e?.message || e}`);
          break;
        }
      }
      console.log(`[Market Maker] Fetched ${candidates.length} markets (fallback).`);
    }

    // 4. 查询数据，筛选符合条件
    console.log(`[Market Maker] Scanning ${candidates.length} candidates...`);
    let eligibleMarkets: any[] = [];
    let debugCount = { total: 0, noBook: 0, negRisk: 0, noBids: 0, badPrice: 0, wideSpread: 0, lowDepth: 0, pass: 0 };

    for (const gm of candidates) {
      // 支持两种候选类型：CLOB reward（已有 yesTokenId）和 Gamma fallback（需从 clobTokenIds 解析）
      const yesTokenId = gm.yesTokenId || (() => {
        const ids = getValidTokenIds(gm.clobTokenIds);
        return ids ? ids[0] : null;
      })();
      if (!yesTokenId) continue;
      const isClobReward = rewardMarkets.length > 0;

      try {
        await new Promise(resolve => setTimeout(resolve, 50)); // 限流
        // 从 Data API 获取最后成交价（无 geo-block，公开 API）
        let price = 0.50;
        try {
          const tradeUrl = `https://data-api.polymarket.com/trades?token_id=${yesTokenId}&limit=1`;
          const tradeResp = await fetch(tradeUrl, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
          });
          const trades = await tradeResp.json();
          if (Array.isArray(trades) && trades.length > 0) {
            const lastTrade = parseFloat(trades[0].price || trades[0].taker_price || '0');
            if (lastTrade > 0 && lastTrade < 1) {
              price = lastTrade;
            }
          }
        } catch {}
        debugCount.total++;

        // 跳过 midpoint 四舍五入后为 0.500 的市场（无最近成交或成交价失真）
        const roundedMid = Math.round(price * 1000) / 1000;
        if (roundedMid === 0.500) { debugCount.badPrice++; continue; }
        if (price <= 0 || price >= 1) { debugCount.badPrice++; continue; }
        // 用 Gamma 的 volume 代替深度（仅 Gamma fallback 模式需要过滤）
        if (!isClobReward) {
          const gmVolume = parseFloat(gm.volume || gm.volume24hr || '0');
          const gmLiq = parseFloat(gm.liquidityClob || gm.liquidity || '0');
          const depthProxy = Math.max(gmVolume, gmLiq);
          if (depthProxy < config.bot.minBidAskDepth) { debugCount.lowDepth++; continue; }
        } else {
          // CLOB reward 模式：无需 volume 过滤，所有候选都有 rewards
        }

        // 用 price ±2% 作为 bid/ask
        const midpoint = price;
        const spread = 0.02;
        const halfSpread = spread / 2;
        const bestBid = Math.max(0.001, midpoint - halfSpread);
        const bestAsk = Math.min(0.999, midpoint + halfSpread);

        // 提取 rewards 参数（可能为空，但没关系）
        const rewardsMinSize = gm.min_incentive_size || 0;
        const rewardsMaxSpread = gm.max_incentive_spread || 0;

        // 只在 CLOB reward 模式下过滤 rewards（fallback 模式不用，因为 Gamma 不返回该数据）
        if (rewardMarkets.length > 0) {
          const hasRewards = (gm.rewardsMinSize || 0) > 0 && (gm.rewardsMaxSpread || 0) > 0;
          if (!hasRewards) { debugCount.lowDepth++; continue; }
        }

        // 获取 noTokenId（两种模式）
        const noTokenId = gm.noTokenId || (() => {
          const ids = getValidTokenIds(gm.clobTokenIds);
          return ids ? ids[1] : null;
        })();
        const volProxy = isClobReward ? 100000 : Math.max(parseFloat(gm.volume || gm.volume24hr || '0'), parseFloat(gm.liquidityClob || gm.liquidity || '0'));

        debugCount.pass++;
        eligibleMarkets.push({
          condition_id: gm.conditionId || gm.id || gm.condition_id,
          eventTitle: gm.eventTitle || gm.question || gm.title || 'Unknown',
          yesTokenId,
          noTokenId,
          bestBid,
          bestAsk,
          bidSize: volProxy,
          askSize: volProxy,
          spread: bestAsk - bestBid,
          midpoint: (bestBid + bestAsk) / 2,
          tickSize: gm.minimum_tick_size || '0.01',
          negRisk: false,
          rewardsMinSize: gm.rewardsMinSize || 0,
          rewardsMaxSpread: gm.rewardsMaxSpread || 0,
          liquidityScore: volProxy,
        });

      } catch (e: any) {
          debugCount.noBook++;
          if (debugCount.noBook <= 3) console.warn(`[Filter] Gamma price parse error for ${gm.question?.substring(0, 30) || yesTokenId.substring(0,10)}`);
        continue;
      }
    }

    console.log(`[Market Maker] Filter debug: total=${debugCount.total} noBook=${debugCount.noBook} negRisk=${debugCount.negRisk} noBids=${debugCount.noBids} badPrice=${debugCount.badPrice} wideSpread=${debugCount.wideSpread} lowDepth=${debugCount.lowDepth} pass=${debugCount.pass}`);

    // 5. 排序：奖励配置优先，然后按流动性排序
    eligibleMarkets.sort((a, b) => {
      const aHasRewards = a.rewardsMinSize > 0 && a.rewardsMaxSpread > 0 ? 1 : 0;
      const bHasRewards = b.rewardsMinSize > 0 && b.rewardsMaxSpread > 0 ? 1 : 0;
      if (bHasRewards !== aHasRewards) return bHasRewards - aHasRewards;
      return b.liquidityScore - a.liquidityScore;
    });

    const selectedMarkets = eligibleMarkets.slice(0, config.bot.maxMarkets);
    console.log(`[Market Maker] Selected ${selectedMarkets.length} reward markets (from ${eligibleMarkets.length} eligible).`);

    if (selectedMarkets.length === 0) {
      console.log(`[Market Maker] No eligible markets found. Waiting for next interval.`);
      return;
    }

    // 6. 取消所有旧订单
    console.log(`[Market Maker] Canceling old orders...`);
    try {
      const openOrders = await clobClient.getOpenOrders();
      if (openOrders && openOrders.length > 0) {
        for (const o of openOrders) {
          try { await clobClient.cancelOrder(o.id); dailyStats.ordersCanceled++; } catch {}
        }
      }
    } catch (e: any) {
      console.warn(`[Market Maker] Cancel orders error: ${e.message}`);
    }

    // 7. 为每个市场挂单（Liquidity Rewards 优化）
    const spreadFromMid = config.bot.spreadFromMidpoint;

    for (const m of selectedMarkets) {
      try {
        // 使用选市场时已缓存的 midpoint（不需要重新请求 CLOB）
        const midpoint = m.midpoint;
        const bestBid = m.bestBid;
        const bestAsk = m.bestAsk;
        const tickSize = m.tickSize || '0.01';

        // 计算报价：离 midpoint 很紧
        let bidPrice = midpoint - spreadFromMid;
        let askPrice = midpoint + spreadFromMid;
        // 钳制在订单簿范围内
        bidPrice = Math.max(bestBid + parseFloat(tickSize), Math.min(bidPrice, bestAsk - parseFloat(tickSize)));
        askPrice = Math.min(bestAsk - parseFloat(tickSize), Math.max(askPrice, bestBid + parseFloat(tickSize)));
        bidPrice = roundToTickSize(bidPrice, tickSize);
        askPrice = roundToTickSize(askPrice, tickSize);

        // 奖励要求的 min size
        const quoteSize = Math.max(10, m.rewardsMinSize || 10);
        // 预算保护：确保有足够现金买入
        const cashAvailable = Math.max(0, cashBalance - reserveCashUsdc);
        const buyCost = quoteSize * bidPrice;
        const effectiveBuySize = buyCost > cashAvailable ? Math.floor(cashAvailable / bidPrice) : quoteSize;
        if (effectiveBuySize < 1) {
          console.log(`     [${m.eventTitle.substring(0, 30)}] Skipped: insufficient cash.`);
          continue;
        }

        console.log(`\n  -> ${m.eventTitle}`);
        console.log(`     Midpoint: ${midpoint.toFixed(3)} | Bid: ${bidPrice} | Size: ${effectiveBuySize}`);

        // 挂 Bid（买入 YES）
        const buyPayload: any = {
          tokenID: m.yesTokenId,
          price: bidPrice,
          side: Side.BUY,
          size: effectiveBuySize,
        };
        const buyRes = await createAndPostOrderWithFeeFallback(buyPayload, tickSize, false);
        if (buyRes && !(buyRes.error || buyRes.errorMessage)) {
          console.log(`     [+] Placed BUY YES @${bidPrice} x${effectiveBuySize}`);
          dailyStats.ordersPosted++;
          cashBalance -= buyCost; // 本地预算扣减
        } else {
          console.log(`     [!] BUY failed: ${buyRes?.error || buyRes?.errorMessage || 'unknown'}`);
        }

        await new Promise(r => setTimeout(r, 100)); // 限流
      } catch (e: any) {
        console.warn(`     [!] Error on ${m.eventTitle?.substring(0, 30) || 'unknown'}: ${e.message}`);
      }
    }

    // 8. 收尾
    console.log(`[Market Maker] Cycle complete. Orders posted: ${dailyStats.ordersPosted}. Waiting for next interval.`);

  } catch (error) {
    console.error('[Market Maker] Fatal error in cycle:', error);
  }
}
