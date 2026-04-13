import { ClobClient, Side, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config';
import { logTrade, logDailySummary } from './notion';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { Headers, Request, Response } from 'node-fetch';
import https from 'https';

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
const inventory: Record<string, { yes: number, no: number, avgCost?: number }> = {};

// 快照级熔断所需：记录上一次扫描的中间价
const lastMidPrices: Record<string, number> = {};

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
        
        portfolioValue += size * currentPrice;

        if (pos.outcome === 'Yes' || pos.outcome === 'YES') {
          inventory[pos.asset].yes = size;
          inventory[pos.asset].avgCost = avgPrice;
        } else if (pos.outcome === 'No' || pos.outcome === 'NO') {
          inventory[pos.asset].no = size;
          inventory[pos.asset].avgCost = avgPrice;
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
            events.push({
              question: gm.question || ge.title,
              token_id: gm.clobTokenIds, // 传递整个字符串或数组给 getValidTokenId 处理，切勿加 [0]
              active: true,
              rewards: gm.clobRewards || [],
              rewardsMinSize: gm.rewardsMinSize || 0,
              rewardsMaxSpread: gm.rewardsMaxSpread || 0
            });
          }
        }
      }
    }

    // 2. 筛选适合我们做市的冷门长尾市场
    const targetMarkets = [];
    
    for (const market of events) {
      if (market.active !== true && market.active !== "true") continue;
      
      // [LP Rewards Bot] 核心逻辑：只在官方有流动性补贴的市场做市！
      if (market.rewards && market.rewards.length === 0) continue;

      const yesTokenIds = getValidTokenIds(market.token_id);
      if (!yesTokenIds) continue;
      const [yesTokenId, noTokenId] = yesTokenIds;

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
        
        // 过滤极端概率市场（避免被单边打穿，适当放宽到 0.01 到 0.99，因为长尾市场很多都在这个区间）
        if (bestAsk > 0.99 || bestBid < 0.01) continue;

        // 必须有一个合理的价差才能做市 (避免价差太小我们变成 Taker 吃单)
        // 并且价差必须足够大，至少容得下我们的 spreadHalf
        if ((bestAsk - bestBid) >= (config.bot.spreadHalfBase * 2)) {
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
        }
      } catch (e) {
        // console.warn(`Error fetching orderbook for ${yesTokenId}`);
      }

      if (targetMarkets.length >= config.bot.targetMarketsCount) {
        break; // 找够了我们设定数量的市场，跳出循环
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

      // === 1. 快照级事后熔断 (Circuit Breaker) ===
      const lastMid = lastMidPrices[tm.yesTokenId];
      if (lastMid !== undefined) {
        const jump = Math.abs(midPrice - lastMid);
        if (jump >= 0.10) {
          console.log(`\n  -> Event: ${tm.eventTitle}`);
          console.log(`     [!] Circuit Breaker: Price jumped by ${jump.toFixed(3)} (Last: ${lastMid.toFixed(3)}, Current: ${midPrice.toFixed(3)})`);
          console.log(`     [!] Skipping market for this cycle.`);
          dailyStats.circuitBreakTriggers++;
          lastMidPrices[tm.yesTokenId] = midPrice; // Update for next cycle
          continue;
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
      // 获取当前库存 (YES 腿和 NO 腿)
      const invYes = inventory[tm.yesTokenId] || { yes: 0, no: 0 };
      const invNo = inventory[tm.noTokenId] || { yes: 0, no: 0 };
      
      // 净方向风险敞口 (YES 等效股数)
      // 持有 YES 代表多头 (+)，持有 NO 代表空头 (等效卖出 YES, -)
      const currentNetYes = invYes.yes - invNo.no;
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
      const actualOrderUSDC = isExposureMaxedOut ? targetSizeUSDC : Math.min(targetSizeUSDC, availableExposureUSDC);
      
      // 转换为股数 (Size)
      // 注意: size 必须是整数，且至少为 1
      // Polymarket 上，买入 YES 成本约等于 midPrice * size，买入 NO 成本约等于 (1 - midPrice) * size
      // 为了简单，我们统一按 0.5 估算，或者直接按 midPrice 估算
      const size = Math.max(Math.floor(actualOrderUSDC / Math.max(midPrice, 0.01)), 1);

      // 计算库存倾斜系数 (Inventory Skew)
      // 倾斜比例 = 净敞口 USDC / 最大允许敞口 USDC (范围 -1 到 1)
      const skewRatio = Math.max(-1, Math.min(currentExposureUSDC / maxMarketUSDC, 1)) * (currentNetYes > 0 ? 1 : -1);
      const skewAdjustment = skewRatio * config.bot.inventorySkewFactor; // 最大降幅

      // === 3. 极低频宽价差防守 ===
      let dynamicSpreadHalf = config.bot.spreadHalfBase;
      // 惩罚机制：盘口原生价差大，或顶层深度极低，加宽价差
      if (tm.spread > 0.06) dynamicSpreadHalf += 0.01;
      if (tm.bidSizeTop < 50 || tm.askSizeTop < 50) dynamicSpreadHalf += 0.01;
      
      // 钳制价差范围
      dynamicSpreadHalf = Math.max(config.bot.spreadHalfBase, Math.min(dynamicSpreadHalf, config.bot.spreadHalfMax));

      // 记录统计
      dailyStats.avgSpreadHalfUsed = (dailyStats.avgSpreadHalfUsed * dailyStats.spreadHalfUsedCount + dynamicSpreadHalf) / (dailyStats.spreadHalfUsedCount + 1);
      dailyStats.spreadHalfUsedCount++;

      // 动态计算挂单价：基础网格 + 库存倾斜
      const myBidPrice = Number((midPrice - dynamicSpreadHalf - skewAdjustment).toFixed(2));
      const myAskPrice = Number((midPrice + dynamicSpreadHalf - skewAdjustment).toFixed(2));

      // 避免我们的挂单变成市价吃单 (Taker)
      if (myBidPrice >= tm.bestAsk || myAskPrice <= tm.bestBid) {
        console.log(`\n  -> Event: ${tm.eventTitle}`);
        console.log(`     Skipping: Quote prices would cross the book (Taker).`);
        continue;
      }

      console.log(`\n  -> Event: ${tm.eventTitle}`);
      console.log(`     Market Spread: Bid ${tm.bestBid} | Mid ${midPrice.toFixed(3)} | Ask ${tm.bestAsk}`);
      console.log(`     My Quotes    : Bid ${myBidPrice} | Ask ${myAskPrice} (Spread: ±${dynamicSpreadHalf.toFixed(3)}, Skew: -${skewAdjustment.toFixed(3)})`);
      console.log(`     Net Exposure : ${currentNetYes} YES eq (~${currentExposureUSDC.toFixed(2)} USDC)`);

      if (myBidPrice <= 0 || myAskPrice >= 1) {
        console.log(`     Skipping: Quote prices out of valid bounds.`);
        continue;
      }

      // === 4. 执行挂单 (双腿解封) ===
      // 挂 Bid 腿 (买入 YES)
      // 条件: 只要还没达到最大正向敞口，或者是净做空状态需要买回，就可以买入 YES
      const canBuyYes = !isExposureMaxedOut || currentNetYes < 0;
      if (canBuyYes && (currentNetYes >= 0 || Math.abs(currentNetYes) < (maxMarketUSDC / midPrice) || currentNetYes < 0)) {
        try {
          const res = await clobClient.createAndPostOrder({
            tokenID: tm.yesTokenId,
            price: myBidPrice,
            side: Side.BUY,
            size: size,
            feeRateBps: 0,
          });

          if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
            console.log(`     [!] Failed to place BUY YES order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
          } else {
            console.log(`     [+] Placed BUY YES (Bid) for ${size} shares at $${myBidPrice}`);
            dailyStats.ordersPosted++;
          }
        } catch (e: any) {
          console.log(`     [!] Failed to place BUY YES order: ${e.message}`);
        }
      }

      // 挂 Ask 腿 (卖出 YES，如果不足则 买入 NO)
      // 条件: 只要还没达到最大负向敞口，或者是净多头状态需要卖出，就可以提供 Ask
      const canSellYes = !isExposureMaxedOut || currentNetYes > 0;
      if (canSellYes && (currentNetYes <= 0 || Math.abs(currentNetYes) < (maxMarketUSDC / (1 - midPrice)) || currentNetYes > 0)) {
        if (invYes.yes >= size) {
          // 有足够的 YES 库存，直接挂 SELL YES
          try {
            const res = await clobClient.createAndPostOrder({
              tokenID: tm.yesTokenId,
              price: myAskPrice,
              side: Side.SELL,
              size: size,
              feeRateBps: 0,
            });

            if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
              console.log(`     [!] Failed to place SELL YES order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
            } else {
              console.log(`     [-] Placed SELL YES (Ask) for ${size} shares at $${myAskPrice}`);
              dailyStats.ordersPosted++;
            }
          } catch (e: any) {
            console.log(`     [!] Failed to place SELL YES order: ${e.message}`);
          }
        } else {
          // 没有足够的 YES 库存，启用最小双腿：通过 BUY NO 提供等效的 Ask
          // 等效价格: 买入 NO 的价格 = 1 - 卖出 YES 的价格
          const buyNoPrice = Number((1 - myAskPrice).toFixed(2));
          
          if (buyNoPrice > 0 && buyNoPrice < 1) {
            try {
              const res = await clobClient.createAndPostOrder({
                tokenID: tm.noTokenId,
                price: buyNoPrice,
                side: Side.BUY, // 买入 NO 相当于卖出 YES
                size: size,
                feeRateBps: 0,
              });

              if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
                console.log(`     [!] Failed to place BUY NO order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
              } else {
                console.log(`     [-] Placed BUY NO (Eq Ask) for ${size} shares at $${buyNoPrice} (Eq YES Ask $${myAskPrice})`);
                dailyStats.ordersPosted++;
              }
            } catch (e: any) {
              console.log(`     [!] Failed to place BUY NO order: ${e.message}`);
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
