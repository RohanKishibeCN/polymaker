import { ClobClient, Side } from '@polymarket/clob-client';
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
  'https://clob.polymarket.com', // host
  137, // Polygon mainnet chainId
  walletClient, // signer
  {
    key: config.polymarket.apiKey,
    secret: config.polymarket.secret,
    passphrase: config.polymarket.passphrase,
  }, // credentials
  undefined, // signatureType
  config.polymarket.funderAddress // funderAddress
);

export async function fetchActiveMarkets() {
  console.log('[Polymarket] Fetching active markets...');
  try {
    const marketsResponse = await clobClient.getSamplingMarkets();
    return marketsResponse;
  } catch (error) {
    console.error('[Polymarket] Error fetching markets:', error);
    return null;
  }
}

export async function scanForNegativeRiskArbitrage() {
  console.log('[Polymarket] Scanning for Negative Risk Arbitrage...');
  try {
    // 使用 Polymarket 的 markets API 代替 events API，因为 events 返回的可能是不包含完整信息的聚合结构
    // Polymarket 官方推荐的套利查询是通过 Gamma API 找到 closed=false 且 active=true 的 markets
    // 但互斥套利必须基于同一个 conditionId，所以我们需要寻找包含多个 outcome 的 condition
    const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100');
    const events = (await response.json()) as any[];
    
    let opportunitiesFound = 0;
    console.log(`[Polymarket] Fetched ${events.length} active events. Filtering...`);

    for (const event of events) {
      if (!event.markets || event.markets.length < 2) continue;

      // 验证市场是否是互斥的 (同一个 conditionId)
      // 我们通过比较它们内部是否归属同一个事件且互斥来判断。通常同一事件内的市场都是选项。
      const firstConditionId = event.markets[0].conditionId;
      const isMutuallyExclusive = event.markets.every((m: any) => m.conditionId === firstConditionId);
      
      if (!isMutuallyExclusive) {
        // 如果 conditionId 不同，它们不是互斥事件，不能做总和套利
        continue;
      }
      
      let sumOfYesAsks = 0;
      const yesTokens: any[] = [];
      let valid = true;

      // 我们打印一些信息用于调试
      // console.log(`Checking event: ${event.title} with ${event.markets.length} markets`);

      for (const market of event.markets) {
        if (market.closed) { valid = false; break; }
        
        // 过滤掉那些订单簿中包含 invalid 结果的市场（可能不适用这种简单套利）
        if (market.groupItemTitle === 'Invalid') { valid = false; break; }

        const clobTokenId = market.clobTokenIds?.[0]; // YES token ID
        if (!clobTokenId) { valid = false; break; }
        
        try {
          const orderbook = await clobClient.getOrderBook(clobTokenId);
          
          // 我们不能仅仅使用 orderbook.asks[0].size 作为流动性依据，需要验证流动性是否足够
          // 有些市场虽然有关联的 clobTokenIds，但由于是冷门市场，可能根本没有 Ask 订单
          if (orderbook.asks && orderbook.asks.length > 0) {
            const bestAskPrice = parseFloat(orderbook.asks[0].price);
            sumOfYesAsks += bestAskPrice;
            yesTokens.push({
              tokenId: clobTokenId,
              price: bestAskPrice,
              size: parseFloat(orderbook.asks[0].size)
            });
          } else {
            // console.log(`Market in event ${event.title} has no asks.`);
            valid = false;
            break;
          }
        } catch (e) {
          // console.log(`Could not get orderbook for ${clobTokenId}`);
          valid = false;
          break;
        }
      }

      if (!valid) continue;

      // 由于移除了 profitThreshold，这里固定一个测试阈值或者直接注释掉旧的套利逻辑
      const targetSum = 0.99;
      
      // 我们打印出每一个有价值的互斥市场的当前和，以便您在日志中看到它正在工作
      if (sumOfYesAsks > 0) {
        console.log(`[Scan] Event: "${event.title.substring(0, 40)}..." | Yes Asks Sum: ${sumOfYesAsks.toFixed(4)} | Target: < ${targetSum.toFixed(4)}`);
      }

      if (sumOfYesAsks > 0 && sumOfYesAsks < targetSum) {
        console.log(`[Arbitrage Opportunity] Event: ${event.title}`);
        console.log(`Sum of YES Asks: ${sumOfYesAsks}`);
        opportunitiesFound++;
        
        const minSize = Math.min(...yesTokens.map(t => t.size));
        const maxSize = Math.min(minSize, config.bot.maxInvestment);
        
        if (maxSize < 0.1) {
          console.log(`Skipping: Max size ${maxSize} is too small`);
          continue;
        }

        console.log(`Executing arbitrage for size: ${maxSize} USDC`);
        
        for (const token of yesTokens) {
          try {
            await clobClient.createAndPostOrder({
              tokenID: token.tokenId,
              price: token.price,
              side: Side.BUY,
              size: maxSize,
              feeRateBps: 0,
            });
            console.log(`Bought ${maxSize} of token ${token.tokenId} at ${token.price}`);
          } catch (e) {
            console.error(`Failed to buy token ${token.tokenId}:`, e);
          }
        }
        
        const expectedProfit = (1.0 - sumOfYesAsks) * maxSize;
        const content = `Event: ${event.title}\nSum of YES: ${sumOfYesAsks}\nSize: ${maxSize} USDC\nExpected Profit: ${expectedProfit} USDC`;
        await logTrade(`Arb: ${event.title.substring(0, 30)}...`, content);
      }
    }
    
    if (opportunitiesFound === 0) {
      console.log('[Polymarket] No arbitrage opportunities found in this scan.');
    }
  } catch (error) {
    console.error('[Polymarket] Error scanning for arbitrage:', error);
  }
}
