import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './config';
import { logTrade } from './notion';

// Initialize Wallet & Client using viem
const privateKey = config.polymarket.privateKey.startsWith('0x') 
  ? config.polymarket.privateKey as `0x${string}`
  : `0x${config.polymarket.privateKey}` as `0x${string}`;

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http('https://polygon-rpc.com'),
});

const clobClient = new ClobClient(
  'https://clob.polymarket.com',
  137,
  walletClient,
  {
    key: config.polymarket.apiKey,
    secret: config.polymarket.secret,
    passphrase: config.polymarket.passphrase,
  },
  undefined,
  config.polymarket.funderAddress
);

// 简单内存状态，记录我们在每个市场的持仓情况
// 注意：VPS 重启后会清零。如果要严格风控，应该存在本地 SQLite 中
const inventory: Record<string, { yes: number, no: number }> = {};

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

export async function runMarketMakingCycle() {
  console.log(`\n[${new Date().toISOString()}] =====================================`);
  console.log('[Market Maker] Starting liquidity rewards & grid cycle...');

  try {
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
        inventory[tm.yesTokenId] = { yes: 0, no: 0 };
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
      if (currentInv.yes < config.bot.maxInventory) {
        try {
          await clobClient.createAndPostOrder({
            tokenID: tm.yesTokenId,
            price: myBidPrice,
            side: Side.BUY,
            size: size,
            feeRateBps: 0,
            // orderType 不存在于当前版本的 @polymarket/clob-client 中
          });
          console.log(`     [+] Placed BUY (Bid) order for ${size} YES at $${myBidPrice}`);
          
          // 注意：这里简单假设挂单必成。真实的量化系统需要 WebSocket 监听 Fill 事件
          // 为了防止爆仓，我们每次挂单都先给库存 +1
          currentInv.yes += size; 
        } catch (e: any) {
          console.log(`     [!] Failed to place BUY order: ${e.message}`);
        }
      } else {
        console.log(`     [!] Skipping BUY: Inventory maxed out (${currentInv.yes})`);
      }

      // 挂卖单 (提供上方流动性)
      if (currentInv.yes > -config.bot.maxInventory) {
        try {
          await clobClient.createAndPostOrder({
            tokenID: tm.yesTokenId,
            price: myAskPrice,
            side: Side.SELL, // 卖出 YES 份额
            size: size,
            feeRateBps: 0,
            // orderType 不存在于当前版本的 @polymarket/clob-client 中
          });
          console.log(`     [-] Placed SELL (Ask) order for ${size} YES at $${myAskPrice}`);
          
          currentInv.yes -= size;
        } catch (e: any) {
          console.log(`     [!] Failed to place SELL order: ${e.message}`);
        }
      } else {
        console.log(`     [!] Skipping SELL: Inventory heavily skewed negative.`);
      }

      // Notion 记录我们的做市行为 (可选，可以只记 daily summary 免得记录太多)
      const content = `Event: ${tm.eventTitle}\nMy Bid: ${myBidPrice}\nMy Ask: ${myAskPrice}\nSize: ${size} USDC\nExpected Spread Profit: ${(myAskPrice - myBidPrice).toFixed(3)} USDC per share`;
      await logTrade(`Grid MM: ${tm.eventTitle.substring(0, 20)}...`, content);
    }
    
    console.log(`[Market Maker] Cycle complete. Waiting for next interval.`);
  } catch (error) {
    console.error('[Market Maker] Fatal error in cycle:', error);
  }
}
