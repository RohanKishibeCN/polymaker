import { ClobClient, Side, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
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

const clobClient = new ClobClient(
  'https://clob.polymarket.com',
  137,
  // @ts-ignore
  wallet,
  {
    key: config.polymarket.apiKey,
    secret: config.polymarket.secret,
    passphrase: config.polymarket.passphrase,
  },
  SignatureType.POLY_GNOSIS_SAFE, // Polymarket 网页端生成的 API Key 必须使用这个 Gnosis Safe 签名类型，否则报 Unauthorized
  config.polymarket.funderAddress,
  config.polymarket.geoBlockToken // 添加 geoBlockToken (可选) 绕过地区限制
);

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
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const funderAddrPadded = config.polymarket.funderAddress.replace('0x', '').padStart(64, '0');
    const data = `0x70a08231${funderAddrPadded}`;
    
    const rpcs = [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon'
    ];
    
    for (const rpc of rpcs) {
      try {
        const rpcRes = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: usdcAddress, data: data }, "latest"]
          })
        });
        const rpcData = await rpcRes.json();
        if (rpcData && rpcData.result) {
          return parseInt(rpcData.result, 16) / 1e6;
        }
      } catch (e) {
        // try next RPC
      }
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

export async function runMarketMakingCycle() {
  console.log(`\n[${new Date().toISOString()}] =====================================`);
  console.log(`[Market Maker] Starting liquidity rewards & grid cycle...`);

  try {
    // 0. 从链上/API 同步真实的持仓数据
    const portfolioValue = await syncInventoryFromChain();
    const cashBalance = await getCashBalance();
    const totalEquity = Math.max(cashBalance + portfolioValue, config.bot.initialCapital); // 保底，避免获取失败导致 size=0
    console.log(`[Market Maker] Current Equity: ~${totalEquity.toFixed(2)} USDC`);

    // 1. 根据开源社区的最佳实践，做市机器人通常使用 Gamma API (/events) 获取带元数据的市场
    // 因为 /sampling-markets 或 CLOB /markets 经常包含大量早已死亡或不规范的子市场
    console.log("[Market Maker] Fetching active events from Gamma API...");
    const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100', {
      agent: proxyAgent
    });
    const gammaData = (await response.json()) as any;
    const gammaEvents = Array.isArray(gammaData) ? gammaData : gammaData.data || [];
    
    // 我们需要把 Gamma events 展平为可做市的 markets 数组
    let events: any[] = [];
    for (const ge of gammaEvents) {
      if (ge.markets) {
        for (const gm of ge.markets) {
          const isActive = gm.active === true || gm.active === "true";
          const isClosed = gm.closed === true || gm.closed === "true";
          if (!isClosed && isActive && gm.clobTokenIds) {
            // Extract tags
            let tags = [];
            if (ge.tags && Array.isArray(ge.tags)) {
              tags = ge.tags.map((t: any) => (t.label || t.id || String(t)).toLowerCase());
            }

            events.push({
              question: gm.question || ge.title,
              token_id: gm.clobTokenIds, // 传递整个字符串或数组给 getValidTokenId 处理，切勿加 [0]
              active: true,
              rewards: gm.clobRewards || [],
              rewardsMinSize: gm.rewardsMinSize || 0,
              rewardsMaxSpread: gm.rewardsMaxSpread || 0,
              tags: tags
            });
          }
        }
      }
    }

    // 2. 筛选适合我们做市的冷门长尾市场
    const targetMarkets = [];
    const tagCounter: Record<string, number> = {};
    let newMarketsCount = 0;
    
    for (const market of events) {
      if (market.active !== true && market.active !== "true") continue;
      
      const yesTokenIds = getValidTokenIds(market.token_id);
      if (!yesTokenIds) continue;
      const [yesTokenId, noTokenId] = yesTokenIds;

      // 检查是否已有库存（持有仓位的市场享有特权，防止被过滤成死仓）
      const invYes = inventory[yesTokenId] || { yes: 0, no: 0 };
      const invNo = inventory[noTokenId] || { yes: 0, no: 0 };
      const hasInventory = invYes.yes > 0 || invNo.no > 0;

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
        
        // 过滤极端概率市场（避免被单边打穿，适当放宽到 0.01 到 0.99，因为长尾市场很多都在这个区间）(有库存的放行)
        if (!hasInventory && (bestAsk > 0.99 || bestBid < 0.01)) continue;

        // 必须有一个合理的价差才能做市 (避免价差太小我们变成 Taker 吃单) (有库存的放行)
        if (hasInventory || (bestAsk - bestBid) >= (config.bot.spreadHalfBase * 2)) {
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
    }

    console.log(`[Market Maker] Selected ${targetMarkets.length} target markets for liquidity provision.`);

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
      const currentNetYes = invYes.yes - invNo.no;
      
      let isHardStopTriggered = false;
      const mainLegInv = currentNetYes > 0 ? invYes : invNo;
      const currentPnlPct = mainLegInv.pnlPct || 0;
      
      if (currentNetYes !== 0 && currentPnlPct <= config.bot.hardStopLossPct) {
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
        if (!isHardStopTriggered && currentNetYes === 0) {
          console.log(`\n  -> Event: ${tm.eventTitle}`);
          console.log(`     [!] Circuit Breaker: Price ${midPrice.toFixed(3)} in extreme bounds. Skipping.`);
          dailyStats.circuitBreakTriggers++;
          lastMidPrices[tm.yesTokenId] = midPrice;
          continue;
        } else if (isHardStopTriggered) {
          console.log(`\n  -> Event: ${tm.eventTitle}`);
          console.log(`     [!] Extreme Bounds: Price ${midPrice.toFixed(3)}, but HARD STOP triggered. Proceeding to liquidate.`);
        }
      }
      
      lastMidPrices[tm.yesTokenId] = midPrice;

      // === 2. 资金比例与库存上限计算 ===
      const currentExposureUSDC = Math.abs(currentNetYes) * (currentNetYes > 0 ? midPrice : (1 - midPrice));
      
      // 更新单日最大仓位占比统计
      const currentPctEquity = totalEquity > 0 ? currentExposureUSDC / totalEquity : 0;
      if (currentPctEquity > dailyStats.maxPositionPctEquity) {
        dailyStats.maxPositionPctEquity = currentPctEquity;
      }
      
      // 检查当前市场的资金占用是否超限 (总权益 15%)
      const maxMarketUSDC = totalEquity * config.bot.maxMarketPct;
      let isExposureMaxedOut = false;
      if (currentExposureUSDC >= maxMarketUSDC) {
        console.log(`\n  -> Event: ${tm.eventTitle}`);
        console.log(`     [!] Exposure Maxed Out: ${currentExposureUSDC.toFixed(2)} USDC >= Limit ${maxMarketUSDC.toFixed(2)} USDC. Will only place reducing orders.`);
        isExposureMaxedOut = true;
      }

      // 计算单笔挂单大小 (总权益 5%~10%，且不能超过剩余可用敞口，除非是减仓单)
      const targetSizeUSDC = totalEquity * config.bot.sizePct;
      const availableExposureUSDC = Math.max(maxMarketUSDC - currentExposureUSDC, 0);
      
      // 转换为基础目标股数
      let baseTargetSize = Math.floor(targetSizeUSDC / Math.max(midPrice, 0.01));
      let minRequiredSize = Math.max(baseTargetSize, 5); // 满足 5 股限制
      const minSizeFor1USD = Math.ceil(1.00 / Math.max(midPrice, 0.01));
      minRequiredSize = Math.max(minRequiredSize, minSizeFor1USD); // 满足 $1 限制

      // 计算买入 YES 的实际资金消耗
      const buyYesCostUSDC = minRequiredSize * midPrice;
      // 计算买入 NO 的实际资金消耗
      const buyNoCostUSDC = minRequiredSize * (1 - midPrice);

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
      
      if (isHardStopTriggered) {
        console.log(`     [!] HARD STOP LOSS TRIGGERED (PnL: ${(currentPnlPct*100).toFixed(2)}%). Placing aggressive exit orders.`);
      }

      // 如果为了满足最小 Size 导致挂单金额超过了可用敞口（且不是为了减仓），并且不是在减仓模式下，则跳过挂单
      const canIncreaseExposure = !isHardStopTriggered && !isExposureMaxedOut && 
                                  (buyYesCostUSDC <= availableExposureUSDC + 0.5) && 
                                  (buyNoCostUSDC <= availableExposureUSDC + 0.5);

      if (isTimeDecayed && !isHardStopTriggered) {
        console.log(`     [!] Time-Decay Triggered: Increasing skew factor to ${currentSkewFactor}`);
      }

      // === 4. 执行挂单 (基于真实库存流转 + 双层网格支持) ===
      
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const currentLayerSize = layer.size;
        if (currentLayerSize <= 0) continue;

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
          const safeSellSize = Math.max(sellSize, 5);

          const sellNoPrice = Number((1 - myBidPrice).toFixed(2));
          if (sellNoPrice > 0 && sellNoPrice < 1) {
            try {
              const res = await clobClient.createAndPostOrder({
                tokenID: tm.noTokenId,
                price: sellNoPrice,
                side: Side.SELL,
                size: safeSellSize,
                feeRateBps: 0,
              });

              if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                console.log(`     [Layer ${i+1}] [!] Failed to place SELL NO order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
              } else {
                console.log(`     [Layer ${i+1}] [+] Placed SELL NO (Eq Bid) for ${safeSellSize} shares at $${sellNoPrice}`);
                dailyStats.ordersPosted++;
              }
            } catch (e: any) {
              console.log(`     [Layer ${i+1}] [!] Failed to place SELL NO order: ${e.message}`);
            }
          }
        } else {
          if (canIncreaseExposure) {
            try {
              const res = await clobClient.createAndPostOrder({
                tokenID: tm.yesTokenId,
                price: myBidPrice,
                side: Side.BUY,
                size: currentLayerSize,
                feeRateBps: 0,
              });

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
            console.log(`     [Layer ${i+1}] [i] Skipping BUY YES (Bid): Exposure limits reached and no NO inventory to sell.`);
          }
        }

        // 挂 Ask 腿 (高卖 YES，或低买 NO 等效)
        if (invYes.yes > 0) {
          const sellSize = Math.min(invYes.yes, currentLayerSize);
          const safeSellSize = Math.max(sellSize, 5);

          try {
            const res = await clobClient.createAndPostOrder({
              tokenID: tm.yesTokenId,
              price: myAskPrice,
              side: Side.SELL,
              size: safeSellSize,
              feeRateBps: 0,
            });

            if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
              console.log(`     [Layer ${i+1}] [!] Failed to place SELL YES order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
            } else {
              console.log(`     [Layer ${i+1}] [-] Placed SELL YES (Ask) for ${safeSellSize} shares at $${myAskPrice}`);
              dailyStats.ordersPosted++;
            }
          } catch (e: any) {
            console.log(`     [Layer ${i+1}] [!] Failed to place SELL YES order: ${e.message}`);
          }
        } else {
          if (canIncreaseExposure) {
            const buyNoPrice = Number((1 - myAskPrice).toFixed(2));
            if (buyNoPrice > 0 && buyNoPrice < 1) {
              try {
                const res = await clobClient.createAndPostOrder({
                  tokenID: tm.noTokenId,
                  price: buyNoPrice,
                  side: Side.BUY,
                  size: currentLayerSize,
                  feeRateBps: 0,
                });

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
            console.log(`     [Layer ${i+1}] [i] Skipping BUY NO (Ask): Exposure limits reached and no YES inventory to sell.`);
          }
        }
      }
    }

    console.log(`[Market Maker] Cycle complete. Waiting for next interval.`);
  } catch (error) {
    console.error('[Market Maker] Fatal error in cycle:', error);
  }
}
