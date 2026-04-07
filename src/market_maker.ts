import { ClobClient, Side, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config';
import { logTrade, logDailySummary } from './notion';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { Headers, Request, Response } from 'node-fetch';
import https from 'https';
import nodeHttp from 'http';

// 终极修复：彻底清理环境变量并精确 Monkey Patch (猴子补丁) 劫持
// 之前失败的原因是：Node.js 底层的 undici 和 axios 自动读取了 HTTPS_PROXY 环境变量，
// 并使用了它们内置的有 Bug 的代理解析器（无法正确处理 IPRoyal 复杂的密码），从而原生地抛出了 407！
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
  console.log(`[Market Maker] Setting global proxy via native monkey-patch to bypass Geoblock and 407 errors...`);
  
  const proxyAgent = new HttpsProxyAgent(proxyUrl);
  
  // 1. 【核心杀招】删除环境变量！防止 undici 和 axios 自动读取并在底层原生抛出 407
  // 这也会让 viem (连接 Polygon RPC) 走直连，不仅不会被 Geoblock 拦截，还能帮您大幅节省代理流量！
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  process.env.NO_PROXY = '*';

  // 2. 暴力接管全局 fetch，强制使用兼容代理的 node-fetch (用于 Gamma API)
  // @ts-ignore
  global.fetch = function(url: any, options: any = {}) {
    options.agent = proxyAgent;
    return fetch(url, options);
  };
  // @ts-ignore
  global.Headers = Headers;
  // @ts-ignore
  global.Request = Request;
  // @ts-ignore
  global.Response = Response;

  // 3. 暴力接管 Node.js 原生 https.request (用于 clob-client 的 axios 发单)
  const originalHttpsRequest = https.request;
  // @ts-ignore
  https.request = function(...args: any[]) {
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      if (typeof args[1] === 'object' && args[1] !== null) {
        args[1].agent = proxyAgent;
      } else {
        args.splice(1, 0, { agent: proxyAgent });
      }
    } else if (args[0] && typeof args[0] === 'object') {
      args[0].agent = proxyAgent;
    }
    // @ts-ignore
    return originalHttpsRequest.apply(this, args);
  };

  const originalHttpRequest = nodeHttp.request;
  // @ts-ignore
  nodeHttp.request = function(...args: any[]) {
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      if (typeof args[1] === 'object' && args[1] !== null) {
        args[1].agent = proxyAgent;
      } else {
        args.splice(1, 0, { agent: proxyAgent });
      }
    } else if (args[0] && typeof args[0] === 'object') {
      args[0].agent = proxyAgent;
    }
    // @ts-ignore
    return originalHttpRequest.apply(this, args);
  };
}

// Initialize Wallet & Client using ethers
const privateKey = config.polymarket.privateKey.startsWith('0x')
  ? config.polymarket.privateKey
  : `0x${config.polymarket.privateKey}`;

const wallet = new Wallet(privateKey);

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
  config.polymarket.geoBlockToken // 添加 geoBlockToken 绕过地区限制
);

// 简单内存状态，记录我们在每个市场的持仓情况
// 注意：VPS 重启后会清零。如果要严格风控，应该存在本地 SQLite 中
const inventory: Record<string, { yes: number, no: number, avgCost?: number }> = {};

function getValidTokenId(rawTokenId: any): string | null {
  if (!rawTokenId) return null;

  if (typeof rawTokenId === 'string' && rawTokenId.startsWith('[')) {
    try {
      // API 有时返回的真的是只有一个字符 '[' 的异常字符串
      if (rawTokenId === '[') return null;

      const validJsonStr = rawTokenId.replace(/'/g, '"');
      const parsedArray = JSON.parse(validJsonStr);
      return Array.isArray(parsedArray) && parsedArray.length > 0 ? parsedArray[0] : null; 
    } catch (error) {
      // 避免因为单个市场的脏数据刷屏日志
      // console.log(`Failed to parse clobTokenIds: ${rawTokenId}`);
      return null;
    }
  }

  if (typeof rawTokenId === 'string') {
    return rawTokenId;
  }

  if (Array.isArray(rawTokenId) && rawTokenId.length > 0) {
    return rawTokenId[0];
  }

  return null;
}

// 记录每天是否已经推送过总结
let lastSummaryDateStr = '';

export async function runDailySummary() {
  try {
    console.log(`[Daily Summary] Generating daily summary...`);

    // 1. 获取 USDC 余额
    // 注意: getAllowance 在 clob-client 里返回 allowance，但这里我们需要余额，可以使用 REST API 或者 RPC。
    // 为了不引入新依赖，简单使用 Polygon RPC 查询 Funder 的 USDC (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174) 余额
    let cashBalance = 0;
    try {
      const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      // balanceOf 签名 0x70a08231，拼接 32 字节 padded address
      const funderAddrPadded = config.polymarket.funderAddress.replace('0x', '').padStart(64, '0');
      const data = `0x70a08231${funderAddrPadded}`;
      
      const rpcRes = await fetch('https://polygon-bor-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: usdcAddress, data: data }, "latest"]
        })
      });
      const rpcJson = await rpcRes.json();
      if (rpcJson.result && rpcJson.result !== '0x') {
        cashBalance = parseInt(rpcJson.result, 16) / 1e6; // USDC 有 6 位小数
      }
    } catch (e: any) {
      console.log(`[Daily Summary] Failed to fetch USDC balance: ${e.message}`);
    }

    // 2. 获取真实的各事件持仓明细和未实现盈亏
    let portfolioValue = 0;
    let positionsDetail = '';
    
    try {
      const positionsRes = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`);
      const positions = await positionsRes.json();
      
      let index = 1;
      if (Array.isArray(positions)) {
        for (const pos of positions) {
          if (pos.size > 0) {
            positionsDetail += `\n${index}. ${pos.title}\n`;
            positionsDetail += `   - 仓位 (Position): ${pos.size} ${pos.outcome}\n`;
            positionsDetail += `   - 持仓成本 (Cost): $${pos.avgPrice} / 股\n`;
            positionsDetail += `   - 当前市价 (Market): $${pos.curPrice} / 股\n`;
            const pnlSign = pos.cashPnl >= 0 ? '+' : '';
            positionsDetail += `   - 未实现盈亏 (Unrealized PnL): ${pnlSign}$${pos.cashPnl.toFixed(2)}\n`;
            
            portfolioValue += pos.currentValue;
            index++;
          }
        }
      }
    } catch (e: any) {
      console.log(`[Daily Summary] Failed to fetch positions: ${e.message}`);
    }

    if (positionsDetail === '') {
      positionsDetail = '\n   - 无活跃持仓 (No active positions)\n';
    }

    const totalEquity = cashBalance + portfolioValue;
    const initialCapital = config.bot.initialCapital || 70;
    const totalPnL = totalEquity - initialCapital;
    const pnlPercent = (totalPnL / initialCapital) * 100;

    // 3. 构建 Content
    let content = `📊 【账户资产总览】\n`;
    content += `- 现金余额 (Cash Balance): ${cashBalance.toFixed(2)} USDC\n`;
    content += `- 预估持仓价值 (Portfolio Value): ~${portfolioValue.toFixed(2)} USDC\n`;
    content += `- 预估账户总资产 (Total Equity): ~${totalEquity.toFixed(2)} USDC\n`;
    content += `- 累计盈亏 (Total PnL): ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} USDC (${totalPnL >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n\n`;
    
    content += `📈 【事件持仓明细】${positionsDetail}`;

    const dateStr = new Date().toISOString().split('T')[0];
    await logDailySummary(`Daily Summary: ${dateStr}`, content);

  } catch (error) {
    console.error('[Daily Summary] Fatal error:', error);
  }
}

async function syncInventoryFromChain() {
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${config.polymarket.funderAddress}`);
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
        
        if (pos.outcome === 'Yes' || pos.outcome === 'YES') {
          inventory[pos.asset].yes = pos.size;
          inventory[pos.asset].avgCost = pos.avgPrice;
        } else if (pos.outcome === 'No' || pos.outcome === 'NO') {
          inventory[pos.asset].no = pos.size;
          inventory[pos.asset].avgCost = pos.avgPrice;
        }
      }
    }
  } catch (e: any) {
    console.log(`[Market Maker] Failed to sync inventory from data-api: ${e.message}`);
  }
}

export async function runMarketMakingCycle() {
  console.log(`\n[${new Date().toISOString()}] =====================================`);
  console.log(`[Market Maker] Starting liquidity rewards & grid cycle...`);

  // 每天早上 8 点 (UTC 0 点) 触发 Daily Summary
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const hoursUTC = now.getUTCHours();
    
    // 如果当前是 UTC 0点 (北京时间 8点)，且今天还没推送过
    if (hoursUTC === 0 && lastSummaryDateStr !== dateStr) {
      await runDailySummary();
      lastSummaryDateStr = dateStr;
    }
  } catch (e: any) {
    console.error(`[Market Maker] Failed to check/run Daily Summary: ${e.message}`);
  }

  try {
    // 0. 从链上/API 同步真实的持仓数据
    await syncInventoryFromChain();

    // 1. 根据开源社区的最佳实践，做市机器人通常使用 Gamma API (/events) 获取带元数据的市场
    // 因为 /sampling-markets 或 CLOB /markets 经常包含大量早已死亡或不规范的子市场
    console.log("[Market Maker] Fetching active events from Gamma API...");
    const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100');
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

      const yesTokenId = getValidTokenId(market.token_id);
      if (!yesTokenId) continue;

      // 验证订单簿
      try {
        // 加点延迟避免请求并发太高
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // 绕过 SDK 网络层问题，直接使用原生 fetch 加上 headers 获取
        const obResponse = await fetch(`https://clob.polymarket.com/book?token_id=${yesTokenId}`, {
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

        // 如果连任何一方挂单都没有，或者倒挂，不适合刚开始做市
        if (bestAsk <= 0 || bestBid <= 0 || bestAsk <= bestBid) continue;
        
        // 过滤极端概率市场（避免被单边打穿，适当放宽到 0.01 到 0.99，因为长尾市场很多都在这个区间）
        if (bestAsk > 0.99 || bestBid < 0.01) continue;

        // 必须有一个合理的价差才能做市 (避免价差太小我们变成 Taker 吃单)
        // 并且价差必须足够大，至少容得下我们的 spreadHalf
        if ((bestAsk - bestBid) >= (config.bot.spreadHalf * 2)) {
           targetMarkets.push({
             eventTitle: market.question || market.market || "Unknown Market", 
             yesTokenId,
             noTokenId: "unknown", // 原生 clob markets 没有直接返回数组，暂且占位
             bestBid,
             bestAsk,
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
    // 撤销之前所有市场遗留的挂单 (以免被单边打穿)
    console.log(`[Market Maker] Canceling old orders to avoid stale quotes...`);
    try {
      await clobClient.cancelAll(); 
    } catch (e) {
      console.log(`[Market Maker] No old orders to cancel or error canceling.`);
    }

    // 为每个选定的市场挂单
    for (const tm of targetMarkets) {
      const midPrice = (tm.bestBid + tm.bestAsk) / 2;
      
      // 动态计算挂单价：如果买卖价差非常大（比如 bid 0.20, ask 0.80），我们需要收敛盘口
      // 我们在中间价的上下方各挂一单
      const myBidPrice = Number((midPrice - config.bot.spreadHalf).toFixed(2)); // 我愿意买入的价格 (低买)
      const myAskPrice = Number((midPrice + config.bot.spreadHalf).toFixed(2)); // 我愿意卖出的价格 (高卖)

      // 避免我们的挂单变成市价吃单 (Taker)
      if (myBidPrice >= tm.bestAsk || myAskPrice <= tm.bestBid) {
        console.log(`     Skipping: Quote prices would cross the book (Taker).`);
        continue;
      }

      // 基本的库存风控：如果买得太多了，就不再挂买单；卖得太多了，不再挂卖单
      if (!inventory[tm.yesTokenId]) {
        inventory[tm.yesTokenId] = { yes: 0, no: 0, avgCost: 0 };
      }
      
      const currentInv = inventory[tm.yesTokenId];

      console.log(`\n  -> Event: ${tm.eventTitle}`);
      console.log(`     Market Spread: Bid ${tm.bestBid} | Mid ${midPrice.toFixed(3)} | Ask ${tm.bestAsk}`);
      console.log(`     My Quotes    : Bid ${myBidPrice} | Ask ${myAskPrice}`);

      // 如果当前盘口的买卖价差太小，或者我的挂单价格荒谬，则跳过
      if (myBidPrice <= 0 || myAskPrice >= 1) {
        console.log(`     Skipping: Quote prices out of valid bounds.`);
        continue;
      }

      // Polymarket 最新 2026年4月流动性激励要求订单大小必须满足 rewardsMinSize (通常为20~50)
      // 如果用户配置的 maxInvestment 过小，我们仍然执行挂单，但打印警告信息
      const size = Math.max(config.bot.maxInvestment, 1);
      if (size < tm.rewardsMinSize) {
        console.log(`     [!] Warning: Order size (${size}) is less than required rewardsMinSize (${tm.rewardsMinSize}). You won't earn LP rewards.`);
      }

      // 挂买单 (提供底层流动性)
      if (currentInv.yes < config.bot.maxInventory * size) {
        try {
          const res = await clobClient.createAndPostOrder({
            tokenID: tm.yesTokenId,
            price: myBidPrice,
            side: Side.BUY,
            size: size,
            feeRateBps: 0,
          });

          if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
            console.log(`     [!] Failed to place BUY order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
          } else {
            console.log(`     [+] Placed BUY (Bid) order for ${size} YES at $${myBidPrice}`);
            // 真实环境应通过 WS 监听成交。这里仅为了测试，不累加预估库存，避免假性锁死
          }
        } catch (e: any) {
          console.log(`     [!] Failed to place BUY order: ${e.message}`);
        }
      } else {
        console.log(`     [!] Skipping BUY: Inventory maxed out (${currentInv.yes})`);
      }

      // 挂卖单 (提供上方流动性)
      // 修改：Polymarket 必须有持仓才能挂 SELL，或者通过挂 NO 代币的 BUY 来实现等效的 SELL
      // 由于我们目前简化处理，仅在确实拥有多头仓位时才挂 SELL
      // 注意：真实生产环境中，MM 机器人应该同时获取每个 token 的余额再决定是否挂单
      if (currentInv.yes > 0) {
        try {
          const res = await clobClient.createAndPostOrder({
            tokenID: tm.yesTokenId,
            price: myAskPrice,
            side: Side.SELL, // 卖出 YES 份额
            size: Math.min(size, currentInv.yes), // 只能卖出自己拥有的库存
            feeRateBps: 0,
          });

          if (res && (res.error || res.errorMessage || res.message || res.success === false)) {
            console.log(`     [!] Failed to place SELL order: ${res.error || res.errorMessage || res.message || 'Unknown error'}`);
          } else {
            console.log(`     [-] Placed SELL (Ask) order for ${Math.min(size, currentInv.yes)} YES at $${myAskPrice}`);
            currentInv.yes -= Math.min(size, currentInv.yes);
          }
        } catch (e: any) {
          console.log(`     [!] Failed to place SELL order: ${e.message}`);
        }
      } else {
        console.log(`     [i] Skipping SELL: No inventory to sell. Waiting for BUY orders to fill first.`);
      }
    }

    console.log(`[Market Maker] Cycle complete. Waiting for next interval.`);
  } catch (error) {
    console.error('[Market Maker] Fatal error in cycle:', error);
  }
}
