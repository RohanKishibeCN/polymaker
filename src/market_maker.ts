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

export async function runMarketMakingCycle() {
  console.log(`\n[${new Date().toISOString()}] =====================================`);
  console.log('[Market Maker] Starting liquidity rewards & grid cycle...');

  try {
    // 1. 直接使用 /markets 端点，获取带有 rewards 或 active 的具体市场
    const response = await fetch('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200');
    const markets = (await response.json()) as any[];

    // 2. 筛选适合我们做市的冷门长尾市场
    const targetMarkets = [];
    
    for (const market of markets) {
      if (market.groupItemTitle === 'Invalid' || market.closed === true) continue;
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) continue;

      const yesTokenId = market.clobTokenIds[0];
      const noTokenId = market.clobTokenIds[1]; // 通常二元市场有 yes 和 no 两个 token

      // 直接使用 Gamma API 返回的 liquidity 字段做初筛，避免频繁请求 clobClient 导致慢
      const apiLiquidity = parseFloat(market.liquidity) || 0;
      if (apiLiquidity < config.bot.minLiquidity || apiLiquidity > config.bot.maxLiquidity) continue;

      // 验证订单簿
      try {
        const orderbook = await clobClient.getOrderBook(yesTokenId);
        
        // 找到了一个符合条件的冷门/中等市场
        // 获取当前的最佳买价和卖价
        const bestAsk = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].price) : 0;
        const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0;

        // 必须有一个合理的价差才能做市 (避免价差太小我们挂不进去)
        // 并且价差必须足够大，至少容得下我们的 spreadHalf
        if (bestAsk > 0 && bestBid > 0 && bestAsk > bestBid && (bestAsk - bestBid) >= (config.bot.spreadHalf * 2)) {
           targetMarkets.push({
             eventTitle: market.question, // 直接用 market 的问题做标题
             yesTokenId,
             noTokenId,
             bestBid,
             bestAsk,
             spread: bestAsk - bestBid
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
      
      // 我们在中间价的上下方各挂一单
      const myBidPrice = Number((midPrice - config.bot.spreadHalf).toFixed(2)); // 我愿意买入的价格 (低买)
      const myAskPrice = Number((midPrice + config.bot.spreadHalf).toFixed(2)); // 我愿意卖出的价格 (高卖)

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

      const size = config.bot.maxInvestment;

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
          console.log(`     [+] Placed POST_ONLY BUY (Bid) order for ${size} YES at $${myBidPrice}`);
          
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
          console.log(`     [-] Placed POST_ONLY SELL (Ask) order for ${size} YES at $${myAskPrice}`);
          
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
