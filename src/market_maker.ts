import { ClobClient, Side, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

// 通过环境变量开关来决定是否使用 V2 语法和新参数，以便 4 月 28 日平滑过渡
// 4月28日前，我们使用旧版本；4月28日后，通过配置 USE_V2_SDK=true 来切换新特性
const USE_V2_SDK = process.env.USE_V2_SDK === 'true';

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

// Initialize Wallet & Client using ethers
const privateKey = config.polymarket.privateKey.startsWith('0x')
  ? config.polymarket.privateKey
  : `0x${config.polymarket.privateKey}`;

const wallet = new Wallet(privateKey);

// 定制化的 axios httpsAgent，供 clob-client 内部使用
const axiosHttpsAgent = proxyAgent ? proxyAgent : new https.Agent();

let clobClient: any;

if (USE_V2_SDK) {
  // @ts-ignore - 兼容未来安装的 @polymarket/clob-client-v2
  clobClient = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: 137,
    wallet: wallet,
    creds: {
      key: config.polymarket.apiKey,
      secret: config.polymarket.secret,
      passphrase: config.polymarket.passphrase,
    },
    signatureType: SignatureType.POLY_GNOSIS_SAFE,
    funderAddress: config.polymarket.funderAddress,
    geoBlockToken: config.polymarket.geoBlockToken // (可选)
  });
} else {
  clobClient = new ClobClient(
    'https://clob.polymarket.com',
    137,
    // @ts-ignore
    wallet,
    {
      key: config.polymarket.apiKey,
      secret: config.polymarket.secret,
      passphrase: config.polymarket.passphrase,
    },
    SignatureType.POLY_GNOSIS_SAFE,
    config.polymarket.funderAddress,
    config.polymarket.geoBlockToken
  );
}

// 覆盖 clobClient 内部的 axios 实例配置，让其走代理
// @ts-ignore
if (clobClient.axiosInstance) {
  // @ts-ignore
  clobClient.axiosInstance.defaults.httpsAgent = axiosHttpsAgent;
}

// 简单内存状态，记录我们在每个市场的持仓情况
// 注意：VPS 重启后会清零。如果要严格风控，应该存在本地 SQLite 中
const inventory: Record<string, { yes: number, no: number, avgCost?: number, pnlPct?: number }> = {};

// 快照级熔断所需：记录上一次扫描的中间价
const lastMidPrices: Record<string, number> = {};

// 持仓时间状态 (用于时间衰减死仓清理)
const STATE_FILE = path.join(__dirname, 'state.json');
let positionState: Record<string, { firstAcquiredAt: number }> = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    positionState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn("Failed to load state.json");
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(positionState, null, 2));
  } catch (e) {
    console.warn("Failed to save state.json");
  }
}

// 全局记录哪些市场必须使用 1000 费率，避免重复报错
const feeRateOverrideByTokenId: Record<string, number> = {};

async function createAndPostOrderWithFeeFallback(orderPayload: any, yesTokenId: string, noTokenId: string) {
  if (!USE_V2_SDK) {
    orderPayload.feeRateBps = feeRateOverrideByTokenId[orderPayload.tokenID] ?? 0;
  }

  let res;
  try {
    res = await clobClient.createAndPostOrder(orderPayload);
  } catch (e: any) {
    res = { error: e.message };
  }

  const msg = `${res?.error || ''} ${res?.errorMessage || ''} ${res?.message || ''}`;
  if (res && res.success === false) {
     // success is false, but no error message, let's just say failed
  }

  if (!USE_V2_SDK && orderPayload.feeRateBps !== 1000 && msg.includes('must be 1000')) {
    feeRateOverrideByTokenId[yesTokenId] = 1000;
    feeRateOverrideByTokenId[noTokenId] = 1000;
    orderPayload.feeRateBps = 1000;
    try {
      res = await clobClient.createAndPostOrder(orderPayload);
    } catch (retryErr: any) {
      res = { error: retryErr.message };
    }
  }

  return res;
}
// Notion 总结需要的数据
let dailyStats = {
  fillsBuy: 0,
  fillsSell: 0,
  ordersPosted: 0,
  ordersCanceled: 0,
  circuitBreakTriggers: 0,
  maxPositionPctEquity: 0,
  avgSpreadHalfUsed: 0,
  spreadHalfUsedCount: 0,
};

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

// 获取 USDC 余额辅助函数
async function getCashBalance(): Promise<number> {
  try {
    const collateralAddress = USE_V2_SDK 
      ? '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // V2: USDC.e
      : '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // V1: USDC.e
    const userAddress = wallet.address;
    const data = `0x70a08231000000000000000000000000${userAddress.replace('0x', '')}`;
    
    const rpcUrl = process.env.RPC_URL || 'https://polygon-rpc.com';
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
      return parseInt(rpcData.result, 16) / 1e6;
    }
  } catch (e) {
    console.warn("Failed to get cash balance");
  }
  return 0;
}

export async function runDailySummary() {
  try {
    console.log(`[Daily Summary] Generating daily summary...`);

    // 1. 获取 USDC 余额
    let cashBalance = await getCashBalance();

    // 2. 获取真实的各事件持仓明细和未实现盈亏
    let portfolioValue = 0;
    let positionsDetail = '';
    
    try {
      const positionsRes = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`, {
        agent: proxyAgent
      });
      const positions = await positionsRes.json();
      
      let index = 1;
      if (Array.isArray(positions)) {
        // Sort positions by currentValue (absolute exposure) descending to get Top 5
        const activePositions = positions.filter(p => parseFloat(p.size) > 0);
        activePositions.sort((a, b) => (parseFloat(b.currentValue) || 0) - (parseFloat(a.currentValue) || 0));
        
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
            positionsDetail += `${index}. [${shortTitle}] - ${size} ${pos.outcome} (Eq ~${currentValue.toFixed(2)} USDC) - PnL: ${pnlSign}${cashPnl.toFixed(2)}\n`;
          }
          index++;
        }
        
        if (activePositions.length > 5) {
          positionsDetail += `... and ${activePositions.length - 5} other smaller positions\n`;
        }
      }
    } catch (e: any) {
      console.log(`[Daily Summary] Failed to fetch positions: ${e.message}`);
    }

    if (positionsDetail === '') {
      positionsDetail = 'No active positions\n';
    }

    const totalEquity = cashBalance + portfolioValue;
    const initialCapital = config.bot.initialCapital || 70;
    const totalPnL = totalEquity - initialCapital;
    const pnlPercent = (totalPnL / initialCapital) * 100;

    // 3. 构建 Content (Notion Scheme A)
    let content = `📊 [ACCOUNT]\n`;
    content += `Equity: ~${totalEquity.toFixed(2)} USDC | Cash: ${cashBalance.toFixed(2)} USDC\n`;
    content += `PnL: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} USDC (${totalPnL >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%) | MaxDD: N/A\n\n`;
    
    content += `🔄 [FLOW]\n`;
    content += `Orders Posted: ${dailyStats.ordersPosted} | Canceled: ${dailyStats.ordersCanceled}\n`;
    content += `Fills Buy/Sell: N/A\n\n`; // TODO: Implement fill tracking if possible
    
    content += `📦 [INVENTORY]\n`;
    content += `Max Pos %: ${(dailyStats.maxPositionPctEquity * 100).toFixed(2)}% | Circuit Breaks: ${dailyStats.circuitBreakTriggers}\n`;
    content += `Avg Spread: ±${dailyStats.avgSpreadHalfUsed.toFixed(3)}\n\n`;
    
    content += `⚠️ [RISK]\n`;
    content += `(No manual alerts)\n\n`;

    content += `📈 [POSITIONS_TOP5]\n${positionsDetail}`;

    const dateStr = new Date().toISOString().split('T')[0];
    await logDailySummary(`Daily Summary: ${dateStr}`, content);
    
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
    };

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
    
    // 重置内存库存，避免残留脏数据
    for (const key in inventory) {
      inventory[key].yes = 0;
      inventory[key].no = 0;
      inventory[key].avgCost = 0;
    }

    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (!inventory[pos.asset]) {
          inventory[pos.asset] = { yes: 0, no: 0, avgCost: 0 };
        }
        
        const size = parseFloat(pos.size) || 0;
        const avgPrice = parseFloat(pos.avgPrice) || 0;
        const currentPrice = parseFloat(pos.currentPrice) || avgPrice;
        const cashPnl = parseFloat(pos.cashPnl) || 0;
        
        portfolioValue += size * currentPrice;

        if (size > 0) {
          if (!positionState[pos.asset]) {
            positionState[pos.asset] = { firstAcquiredAt: Date.now() };
            saveState();
          }
        } else {
          if (positionState[pos.asset]) {
            delete positionState[pos.asset];
            saveState();
          }
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

// 用于 Gamma 分页增量轮转拉取
let lastMarketOffset: number = 0;
// 持久化保存所有有库存的市场元数据，防止分页轮转期间被跳过导致断单被套
let cachedInventoryMarkets: any[] = [];

export async function runMarketMakingCycle() {
  console.log(`\n[${new Date().toISOString()}] =====================================`);
  console.log(`[Market Maker] Starting liquidity rewards & grid cycle...`);

  try {
    // 0. 从链上/API 同步真实的持仓数据
    const portfolioValue = await syncInventoryFromChain();
    const cashBalance = await getCashBalance();
    const totalEquity = Math.max(cashBalance + portfolioValue, config.bot.initialCapital); // 保底，避免获取失败导致 size=0
    console.log(`[Market Maker] Current Equity: ~${totalEquity.toFixed(2)} USDC`);

    // 1. 获取 Gamma 市场数据
    // Polymarket 最近在 /events 端点中移除了 clobRewards 数据，因此我们改用 /markets 端点
    console.log("[Market Maker] Fetching active markets from Gamma API (Offset Pagination)...");
    
    // 我们每个做市周期拉取 3 页 (约 300 个市场)，以滚动覆盖所有市场
    const PAGES_TO_FETCH = 3;
    let gammaMarkets: any[] = [];
    
    for (let i = 0; i < PAGES_TO_FETCH; i++) {
      const url = `https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&offset=${lastMarketOffset}`;
      
      try {
        const response = await fetch(url, { agent: proxyAgent });
        const pageMarkets = (await response.json()) as any[];
        
        if (!Array.isArray(pageMarkets)) {
          console.warn(`[Market Maker] Unexpected API response format`);
          break;
        }
        
        gammaMarkets = gammaMarkets.concat(pageMarkets);
        
        if (pageMarkets.length < 100) {
          lastMarketOffset = 0;
          console.log("[Market Maker] Reached the end of active markets. Will restart from beginning next cycle.");
          break; 
        } else {
          lastMarketOffset += 100;
        }
      } catch (e: any) {
         console.warn(`[Market Maker] Failed to fetch markets page ${i+1}: ${e.message}`);
         break;
      }
    }
    console.log(`[Market Maker] Fetched ${gammaMarkets.length} markets in this cycle. Next offset: ${lastMarketOffset}`);
    
    // 我们需要把 Gamma markets 展平为可做市的 events 数组 (为了兼容旧代码命名)
    let events: any[] = [];
    let nextCachedInventoryMarkets: any[] = [];
    
    for (const gm of gammaMarkets) {
      const isActive = gm.active === true || gm.active === "true";
      const isClosed = gm.closed === true || gm.closed === "true";
      
      if (!isClosed && isActive && gm.clobTokenIds) {
        // Extract tags (使用 groupItemTitle 或 events[0].slug 作为同质化分类标签)
        let tags = [];
        if (gm.groupItemTitle) {
          tags.push(gm.groupItemTitle.toLowerCase());
        } else if (gm.events && gm.events.length > 0) {
          tags.push((gm.events[0].slug || gm.events[0].title || "unknown").toLowerCase());
        }

        const formattedMarket = {
          question: gm.question,
          token_id: gm.clobTokenIds,
          active: true,
          rewards: gm.clobRewards || [],
          rewardsMinSize: gm.rewardsMinSize || 0,
          rewardsMaxSpread: gm.rewardsMaxSpread || 0,
          tags: tags
        };
        events.push(formattedMarket);
      }
    }

    // 2. 筛选适合我们做市的冷门长尾市场
    const targetMarkets = [];
    const tagCounter: Record<string, number> = {};
    let newMarketsCount = 0;

    // 将上一轮缓存的有库存市场合并到本轮处理列表中，防止分页漏扫
    for (const cachedMarket of cachedInventoryMarkets) {
      if (!events.some(e => e.token_id === cachedMarket.token_id)) {
        events.push(cachedMarket);
      }
    }

    for (const market of events) {
      if (market.active !== true && market.active !== "true") continue;
      
      const yesTokenIds = getValidTokenIds(market.token_id);
      if (!yesTokenIds) continue;
      const [yesTokenId, noTokenId] = yesTokenIds;

      // 检查是否已有库存（持有仓位的市场享有特权，防止被过滤成死仓）
      const invYes = inventory[yesTokenId] || { yes: 0, no: 0 };
      const invNo = inventory[noTokenId] || { yes: 0, no: 0 };
      const hasInventory = invYes.yes > 0 || invNo.no > 0;
      if (!hasInventory && (feeRateOverrideByTokenId[yesTokenId] === 1000 || feeRateOverrideByTokenId[noTokenId] === 1000)) continue;
      
      // ==========================================
      // [核心修复] 如果该市场有库存，将其加入下一次缓存中
      // 确保下一轮分页轮转即使没扫到它，也能继续保护订单
      // ==========================================
      if (hasInventory) {
          nextCachedInventoryMarkets.push(market);
      }

      // 如果没有库存，且新开市场数量已经达到上限，跳过该市场
      if (!hasInventory && newMarketsCount >= config.bot.targetMarketsCount) {
        continue;
      }

      // [LP Rewards Bot] 核心逻辑：只在官方有流动性补贴的市场做市！(有库存的市场强制放行，方便平仓)
      if (!hasInventory && market.rewards && market.rewards.length === 0) continue;

      // 【第二轮迭代】Tag 多样性过滤（解决同质化事件扎堆）
      let skipForTagQuota = false;
      if (!hasInventory && market.tags && market.tags.length > 0) {
        for (const tag of market.tags) {
          if ((tagCounter[tag] || 0) >= config.bot.tagQuota) {
            skipForTagQuota = true;
            break;
          }
        }
      }
      if (skipForTagQuota) continue;
      // 验证订单簿
      try {
        // 加点延迟避免请求并发太高
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // 绕过 SDK 网络层问题，直接使用原生 fetch 加上 headers 获取
        const obResponse = await fetch(`https://clob.polymarket.com/book?token_id=${yesTokenId}`, {
          agent: proxyAgent,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          }
        });
        const orderbook = (await obResponse.json()) as any;
        
        if (orderbook.error || orderbook.message) {
          continue;
        }

        // 找到了一个符合条件的冷门/中等市场
        // 获取当前的最佳买价和卖价
        const bestAsk = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].price) : 0;
        const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0;
        const askSizeTop = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].size) : 0;
        const bidSizeTop = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].size) : 0;

        // 如果连任何一方挂单都没有，或者倒挂，不适合刚开始做市
        if (bestAsk <= 0 || bestBid <= 0 || bestAsk <= bestBid) continue;
        
        const invYes = inventory[yesTokenId] || { yes: 0, no: 0 };
        const invNo = inventory[noTokenId] || { yes: 0, no: 0 };
        const hasInventory = invYes.yes > 0 || invYes.no > 0 || invNo.yes > 0 || invNo.no > 0;

        // 过滤极端概率市场（避免被单边打穿，适当放宽到 0.01 到 0.99，因为长尾市场很多都在这个区间）(有库存的放行)
        if (!hasInventory && (bestAsk > 0.99 || bestBid < 0.01)) continue;

        // 必须有一个合理的价差才能做市 (避免价差太小我们变成 Taker 吃单) (有库存的放行)
        // 并且价差必须足够大，至少容得下我们的 spreadHalf
        if (hasInventory || (bestAsk - bestBid) >= (config.bot.spreadHalfBase * 2)) {
           if (!hasInventory && (bidSizeTop < 15 || askSizeTop < 15)) continue;

           targetMarkets.push({
             eventTitle: market.question || market.market || "Unknown Market", 
             yesTokenId,
             noTokenId,
             bestBid,
             bestAsk,
             bidSizeTop,
             askSizeTop,
             spread: bestAsk - bestBid,
             rewardsMinSize: market.rewardsMinSize || 20
           });

           // 更新该市场所有 tag 的计数（无论新老，只要入选就占用配额，防止新市场扎堆）
           if (market.tags && market.tags.length > 0) {
             for (const tag of market.tags) {
               tagCounter[tag] = (tagCounter[tag] || 0) + 1;
             }
           }

           if (!hasInventory) {
             newMarketsCount++;
           }
        }
      } catch (e) {
        // console.warn(`Error fetching orderbook for ${yesTokenId}`);
      }
      if (targetMarkets.length >= config.bot.targetMarketsCount) {
        break; // 找够了我们设定数量的市场，跳出循环
      }
    }

    console.log(`[Market Maker] Selected ${targetMarkets.length} target markets for liquidity provision.`);
    
    // 更新持久化缓存
    cachedInventoryMarkets = nextCachedInventoryMarkets;

    // 3. 开始撤单与重挂 (Re-quoting)
    console.log(`[Market Maker] Canceling old orders to avoid stale quotes...`);
    try {
      const canceled = await clobClient.cancelAll();
      if (canceled && canceled.length) {
        dailyStats.ordersCanceled += canceled.length;
      } else {
        dailyStats.ordersCanceled++; // Just an approximation if length is not available
      }
    } catch (e) {
      console.log(`[Market Maker] No old orders to cancel or error canceling.`);
    }

    // 为每个选定的市场挂单
    for (const tm of targetMarkets) {
      const midPrice = (tm.bestBid + tm.bestAsk) / 2;

      // === 0. 获取当前库存与提前判定止损 ===
      const invYes = inventory[tm.yesTokenId] || { yes: 0, no: 0, pnlPct: 0 };
      const invNo = inventory[tm.noTokenId] || { yes: 0, no: 0, pnlPct: 0 };

      // 净方向风险敞口 (YES 等效股数)
      const currentNetYes = invYes.yes - invNo.yes + invNo.no - invYes.no;

      // [核心风控] 硬止损 (Hard Stop Loss)
      // 如果某条腿的浮亏超过了设定的阈值 (如 -15%)，进入无脑清仓模式
      let isHardStopTriggered = false;
      if (invYes.pnlPct! <= config.bot.hardStopLossPct || invNo.pnlPct! <= config.bot.hardStopLossPct) {
        console.log(`\n  -> Event: ${tm.eventTitle}`);
        console.log(`     [!] HARD STOP LOSS TRIGGERED! PnL: YES=${(invYes.pnlPct!*100).toFixed(2)}%, NO=${(invNo.pnlPct!*100).toFixed(2)}%`);
        console.log(`     [!] Will place aggressive reduce-only orders.`);
        isHardStopTriggered = true;
      }
      // === 1. 快照级事后熔断 (Circuit Breaker) ===
      const lastMid = lastMidPrices[tm.yesTokenId];
      if (lastMid !== undefined) {
        const jump = Math.abs(midPrice - lastMid);
        if (jump >= 0.10) {
          console.log(`\n  -> Event: ${tm.eventTitle}`);
          if (isHardStopTriggered) {
             console.log(`     [!] Circuit Breaker: Price jumped by ${jump.toFixed(3)}, but HARD STOP triggered. Proceeding to liquidate.`);
          } else {
             console.log(`     [!] Circuit Breaker: Price jumped by ${jump.toFixed(3)} (Last: ${lastMid.toFixed(3)}, Current: ${midPrice.toFixed(3)})`);
             console.log(`     [!] Skipping market for this cycle.`);
             dailyStats.circuitBreakTriggers++;
             lastMidPrices[tm.yesTokenId] = midPrice; // Update for next cycle
             continue;
          }
        }
      }
      
      // 极端区间过滤
      if (midPrice <= 0.10 || midPrice >= 0.90) {
        console.log(`\n  -> Event: ${tm.eventTitle}`);
        console.log(`     [!] Circuit Breaker: Price ${midPrice.toFixed(3)} in extreme bounds. Skipping.`);
        dailyStats.circuitBreakTriggers++;
        lastMidPrices[tm.yesTokenId] = midPrice;
        continue;
      }
      
      lastMidPrices[tm.yesTokenId] = midPrice;

      // === 2. 资金比例与库存上限计算 ===
      const currentExposureUSDC = Math.abs(currentNetYes) * (currentNetYes > 0 ? midPrice : (1 - midPrice));
      
      // 更新单日最大仓位占比统计
      const currentPctEquity = totalEquity > 0 ? currentExposureUSDC / totalEquity : 0;
      if (currentPctEquity > dailyStats.maxPositionPctEquity) {
        dailyStats.maxPositionPctEquity = currentPctEquity;
      }
      
      // 计算当前市场的资金占用是否超限 (总权益 15%)
      const maxMarketUSDC = totalEquity * config.bot.maxMarketPct;
      let isExposureMaxedOut = false;
      if (currentExposureUSDC >= maxMarketUSDC && maxMarketUSDC > 0) {
        console.log(`\n  -> Event: ${tm.eventTitle}`);
        console.log(`     [!] Exposure Maxed Out: ${currentExposureUSDC.toFixed(2)} USDC >= Limit ${maxMarketUSDC.toFixed(2)} USDC. Will only place reducing orders.`);
        isExposureMaxedOut = true;
      }

      // 如果 currentExposureUSDC > maxMarketUSDC，Math.max 保证 availableExposureUSDC 为 0
      const availableExposureUSDC = Math.max(maxMarketUSDC - currentExposureUSDC, 0);
      
      // 我们用 cashBalance 和 maxMarketUSDC（而不是 availableExposureUSDC）来计算想要做市的【目标大小】
      // 否则，如果 availableExposureUSDC 很小，我们的 minRequiredSize 会被严重压缩
      const targetSizeUSDC = Math.min(cashBalance * config.bot.sizePct, maxMarketUSDC);
      
      // 转换为基础目标股数
      let baseTargetSize = Math.floor(targetSizeUSDC / Math.max(midPrice, 0.01));
      let minRequiredSize = Math.max(baseTargetSize, 5); // 满足 5 股限制
      const minSizeFor1USD = Math.ceil(1.00 / Math.max(midPrice, 0.01));
      minRequiredSize = Math.max(minRequiredSize, minSizeFor1USD); // 满足 $1 限制

      // === 双层网格拆分逻辑 (2-Layer Grid) ===
      let layers = [];
      if (config.bot.enableDualLayerGrid && minRequiredSize >= 20) {
        // 近端单 (30% size, 窄价差)
        const layer1Size = Math.max(Math.floor(minRequiredSize * 0.3), 5);
        // 远端单 (剩余 size, 宽价差)
        const layer2Size = minRequiredSize - layer1Size;
        
        layers.push({ size: layer1Size, spreadMult: 0.5 }); // 价差减半
        layers.push({ size: layer2Size, spreadMult: 1.5 }); // 价差放大 1.5 倍
      } else {
        // 单层网格 (默认)
        layers.push({ size: minRequiredSize, spreadMult: 1.0 });
      }

      // 计算整个市场做市所需的总股数 (所有 layer size 之和)
      const totalRequiredSize = layers.reduce((acc, layer) => acc + layer.size, 0);

      // 计算买入 YES 的实际资金消耗 (按 totalRequiredSize)
      const totalBuyYesCostUSDC = totalRequiredSize * midPrice;
      // 计算买入 NO 的实际资金消耗 (按 totalRequiredSize)
      const totalBuyNoCostUSDC = totalRequiredSize * (1 - midPrice);

      // === 3. 风控机制与价差防守 ===
      
      // A. 时间衰减 (Time-Decay) 判定
      let isTimeDecayed = false;
      const mainAsset = currentNetYes > 0 ? tm.yesTokenId : tm.noTokenId;
      const firstAcquiredAt = positionState[mainAsset]?.firstAcquiredAt;
      if (firstAcquiredAt && currentNetYes !== 0) {
        const daysHeld = (Date.now() - firstAcquiredAt) / (1000 * 60 * 60 * 24);
        if (daysHeld >= config.bot.timeDecayDays) {
          isTimeDecayed = true;
        }
      }

      // 计算库存倾斜系数 (Inventory Skew)
      const skewRatio = Math.max(-1, Math.min(currentExposureUSDC / maxMarketUSDC, 1)) * (currentNetYes > 0 ? 1 : -1);
      const currentSkewFactor = isTimeDecayed ? config.bot.timeDecaySkewFactor : config.bot.inventorySkewFactor;
      const skewAdjustment = skewRatio * currentSkewFactor;

      // B. 极低频宽价差防守
      let dynamicSpreadHalf = config.bot.spreadHalfBase;
      if (tm.spread > 0.06) dynamicSpreadHalf += 0.01;
      if (tm.bidSizeTop < 50 || tm.askSizeTop < 50) dynamicSpreadHalf += 0.01;
      dynamicSpreadHalf = Math.max(config.bot.spreadHalfBase, Math.min(dynamicSpreadHalf, config.bot.spreadHalfMax));

      dailyStats.avgSpreadHalfUsed = (dailyStats.avgSpreadHalfUsed * dailyStats.spreadHalfUsedCount + dynamicSpreadHalf) / (dailyStats.spreadHalfUsedCount + 1);
      dailyStats.spreadHalfUsedCount++;

      // C. 硬止损 (Hard Stop-Loss) 抢一档平仓
      // `isHardStopTriggered` 已经在循环开头判定过了

      // 提前判定整个市场级别的 Exposure 是否允许开仓，避免每层网格重复报这个日志
      // 这个总判定用于决定一些全局的预警日志
      const epsilon = 0.0001;
      const canIncreaseExposureOverall = !isHardStopTriggered && !isExposureMaxedOut && 
                                  (totalBuyYesCostUSDC <= availableExposureUSDC + epsilon) && 
                                  (totalBuyNoCostUSDC <= availableExposureUSDC + epsilon) &&
                                  (Math.max(totalBuyYesCostUSDC, totalBuyNoCostUSDC) <= cashBalance + epsilon);

      if (isTimeDecayed && !isHardStopTriggered) {
        console.log(`     [!] Time-Decay Triggered: Increasing skew factor to ${currentSkewFactor}`);
      }

      // === 4. 执行挂单 (基于真实库存流转 + 双层网格支持) ===
      
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const currentLayerSize = layer.size;
        if (currentLayerSize <= 0) continue;

        // 重新计算该层是否能正常开仓
        const layerBuyYesCostUSDC = currentLayerSize * midPrice;
        const layerBuyNoCostUSDC = currentLayerSize * (1 - midPrice);
        const epsilon = 0.05; // 增加一定的缓冲，应对微小超出（比如计算需要 75.02 USDC，实际可用 75 USDC）
        
        // 只要不是已经爆仓 (isExposureMaxedOut) 或者硬止损，且余额和敞口都够这“一层”的单子，就可以挂单。
        const canIncreaseExposure = !isHardStopTriggered && !isExposureMaxedOut && 
                                    (layerBuyYesCostUSDC <= availableExposureUSDC + epsilon) && 
                                    (layerBuyNoCostUSDC <= availableExposureUSDC + epsilon);
                                    
        if (!canIncreaseExposure) {
          console.log(`     [Layer ${i+1}] [DEBUG] canIncreaseExposure=false: isHardStop=${isHardStopTriggered}, isMaxed=${isExposureMaxedOut}, YEScost=${layerBuyYesCostUSDC.toFixed(2)}, NOcost=${layerBuyNoCostUSDC.toFixed(2)}, maxCost=${Math.max(layerBuyYesCostUSDC, layerBuyNoCostUSDC).toFixed(2)}, availExp=${availableExposureUSDC.toFixed(2)}, cash=${cashBalance.toFixed(2)}`);
        }

        let layerDynamicSpreadHalf = dynamicSpreadHalf * layer.spreadMult;
        
        // 动态计算挂单价
        let myBidPrice = Number((midPrice - layerDynamicSpreadHalf - skewAdjustment).toFixed(2));
        let myAskPrice = Number((midPrice + layerDynamicSpreadHalf - skewAdjustment).toFixed(2));

        // C. 硬止损 (Hard Stop-Loss) 抢一档平仓
        if (isHardStopTriggered) {
          if (currentNetYes > 0) {
             myAskPrice = Math.max(tm.bestBid + 0.01, 0.01);
          } else {
             myBidPrice = Math.min(tm.bestAsk - 0.01, 0.99);
          }
        }
        
        if (isTimeDecayed && !isHardStopTriggered) {
          if (currentNetYes > 0) {
            myAskPrice = Math.max(tm.bestBid + 0.01, 0.01);
          } else if (currentNetYes < 0) {
            myBidPrice = Math.min(tm.bestAsk - 0.01, 0.99);
          }
        }

        // 避免我们的挂单变成市价吃单 (Taker)，将价格钳制在盘口内 (Maker)
        if (myBidPrice >= tm.bestAsk) {
          myBidPrice = Math.max(tm.bestAsk - 0.01, 0.01);
        }
        if (myAskPrice <= tm.bestBid) {
          myAskPrice = Math.min(tm.bestBid + 0.01, 0.99);
        }
        
        myBidPrice = Number(myBidPrice.toFixed(2));
        myAskPrice = Number(myAskPrice.toFixed(2));

        if (i === 0) {
          console.log(`\n  -> Event: ${tm.eventTitle}`);
          console.log(`     Market Spread: Bid ${tm.bestBid} | Mid ${midPrice.toFixed(3)} | Ask ${tm.bestAsk}`);
          console.log(`     Net Exposure : ${currentNetYes} YES eq (~${currentExposureUSDC.toFixed(2)} USDC)`);
        }
        console.log(`     [Layer ${i+1}] Quotes: Bid ${myBidPrice} | Ask ${myAskPrice} (SpreadMult: ${layer.spreadMult}, Size: ${currentLayerSize})`);

        if (myBidPrice <= 0 || myAskPrice >= 1) {
          console.log(`     [Layer ${i+1}] Skipping: Quote prices out of valid bounds.`);
          continue;
        }
        // 挂 Bid 腿 (低买 YES，或高卖 NO 等效)
        if (invNo.no > 0) {
          const sellSize = Math.min(invNo.no, currentLayerSize);
          let safeSellSize = Math.max(sellSize, 5);
          let sellNoPrice = Number((1 - myBidPrice).toFixed(2));

          if (safeSellSize > invNo.no) {
            safeSellSize = invNo.no;
            if (safeSellSize * sellNoPrice >= 1) {
              sellNoPrice = Number((1 - tm.bestAsk).toFixed(2));
              if (sellNoPrice <= 0) sellNoPrice = 0.01;
              console.log(`     [Layer ${i+1}] [i] Dust inventory (${safeSellSize.toFixed(4)} NO). Forcing Taker order at $${sellNoPrice}`);
            } else {
              console.log(`     [Layer ${i+1}] [i] Dust inventory (${safeSellSize.toFixed(4)} NO). Value < $1, skipping SELL.`);
              safeSellSize = 0;
            }
          }

          if (safeSellSize > 0 && sellNoPrice > 0 && sellNoPrice < 1) {
            try {
              const orderPayload: any = {
                tokenID: tm.noTokenId,
                price: sellNoPrice,
                side: Side.SELL,
                size: safeSellSize,
              };
              const res = await createAndPostOrderWithFeeFallback(orderPayload, tm.yesTokenId, tm.noTokenId);

              if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                console.log(`     [Layer ${i+1}] [!] Failed to place SELL NO order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
              } else {
                console.log(`     [Layer ${i+1}] [+] Placed SELL NO (Eq Bid) for ${safeSellSize} shares at $${sellNoPrice}`);
                dailyStats.ordersPosted++;
                invNo.no -= safeSellSize; // 更新本地库存，防止下一层网格重复卖出
              }
            } catch (e: any) {
              console.log(`     [Layer ${i+1}] [!] Failed to place SELL NO order: ${e.message}`);
            }
          }
        } else {
          if (canIncreaseExposure) {
            try {
              const orderPayload: any = {
                tokenID: tm.yesTokenId,
                price: myBidPrice,
                side: Side.BUY,
                size: currentLayerSize,
              };
              const res = await createAndPostOrderWithFeeFallback(orderPayload, tm.yesTokenId, tm.noTokenId);

              if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                console.log(`     [Layer ${i+1}] [!] Failed to place BUY YES order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
              } else {
                console.log(`     [Layer ${i+1}] [+] Placed BUY YES (Bid) for ${currentLayerSize} shares at $${myBidPrice}`);
                dailyStats.ordersPosted++;
              }
            } catch (e: any) {
              console.log(`     [Layer ${i+1}] [!] Failed to place BUY YES order: ${e.message}`);
            }
          } else {
            if (!canIncreaseExposure) {
              console.log(`     [Layer ${i+1}] [i] Skipping BUY YES (Bid): Exposure limits reached and no NO inventory to sell.`);
            }
          }
        }

        // 挂 Ask 腿 (高卖 YES，或低买 NO 等效)
        if (invYes.yes > 0) {
          const sellSize = Math.min(invYes.yes, currentLayerSize);
          let safeSellSize = Math.max(sellSize, 5);
          let sellYesPrice = myAskPrice;

          if (safeSellSize > invYes.yes) {
            safeSellSize = invYes.yes;
            if (safeSellSize * sellYesPrice >= 1) {
              sellYesPrice = tm.bestBid;
              if (sellYesPrice <= 0) sellYesPrice = 0.01;
              console.log(`     [Layer ${i+1}] [i] Dust inventory (${safeSellSize.toFixed(4)} YES). Forcing Taker order at $${sellYesPrice}`);
            } else {
              console.log(`     [Layer ${i+1}] [i] Dust inventory (${safeSellSize.toFixed(4)} YES). Value < $1, skipping SELL.`);
              safeSellSize = 0;
            }
          }

          if (safeSellSize > 0 && sellYesPrice > 0 && sellYesPrice < 1) {
            try {
              const orderPayload: any = {
                tokenID: tm.yesTokenId,
                price: sellYesPrice,
                side: Side.SELL,
                size: safeSellSize,
              };
              const res = await createAndPostOrderWithFeeFallback(orderPayload, tm.yesTokenId, tm.noTokenId);

              if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                console.log(`     [Layer ${i+1}] [!] Failed to place SELL YES order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
              } else {
                console.log(`     [Layer ${i+1}] [-] Placed SELL YES (Ask) for ${safeSellSize} shares at $${sellYesPrice}`);
                dailyStats.ordersPosted++;
                invYes.yes -= safeSellSize; // 更新本地库存，防止下一层网格重复卖出
              }
            } catch (e: any) {
              console.log(`     [Layer ${i+1}] [!] Failed to place SELL YES order: ${e.message}`);
            }
          }
        } else {
          if (canIncreaseExposure) {
            const buyNoPrice = Number((1 - myAskPrice).toFixed(2));
            if (buyNoPrice > 0 && buyNoPrice < 1) {
              try {
                const orderPayload: any = {
                  tokenID: tm.noTokenId,
                  price: buyNoPrice,
                  side: Side.BUY,
                  size: currentLayerSize,
                };
                const res = await createAndPostOrderWithFeeFallback(orderPayload, tm.yesTokenId, tm.noTokenId);

                if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                  console.log(`     [Layer ${i+1}] [!] Failed to place BUY NO order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
                } else {
                  console.log(`     [Layer ${i+1}] [-] Placed BUY NO (Eq Ask) for ${currentLayerSize} shares at $${buyNoPrice}`);
                  dailyStats.ordersPosted++;
                }
              } catch (e: any) {
                console.log(`     [Layer ${i+1}] [!] Failed to place BUY NO order: ${e.message}`);
              }
            }
          } else {
            if (!canIncreaseExposure) {
              console.log(`     [Layer ${i+1}] [i] Skipping BUY NO (Ask): Exposure limits reached and no YES inventory to sell.`);
            }
          }
        }
      }
    }

    console.log(`[Market Maker] Cycle complete. Waiting for next interval.`);
  } catch (error) {
    console.error('[Market Maker] Fatal error in cycle:', error);
  }
}
