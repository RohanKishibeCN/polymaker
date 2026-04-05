import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './src/config';

function getValidTokenId(rawTokenId: any): string | null {
  if (!rawTokenId) return null;

  if (typeof rawTokenId === 'string' && rawTokenId.startsWith('[')) {
    try {
      const validJsonStr = rawTokenId.replace(/'/g, '"');
      const parsedArray = JSON.parse(validJsonStr);
      return parsedArray[0]; 
    } catch (error) {
      console.log(`Failed to parse clobTokenIds: ${rawTokenId}`);
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

async function diagnose() {
  console.log('--- Starting Diagnosis ---');
  
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

  // /markets returns OLD markets. We need to fetch NEXT cursor until we get to recent ones, or sort!
  const response = await fetch('https://clob.polymarket.com/markets');
  const marketsResponse = await response.json();
  let events = marketsResponse.data || marketsResponse || [];
  
  // Actually, clob API has `next_cursor`. Let's just use Gamma API again but get the token_id properly.
  const gammaRes = await fetch('https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100');
  const gammaData = await gammaRes.json();
  const gammaEvents = Array.isArray(gammaData) ? gammaData : gammaData.data || [];
  
  // We need a helper to map Gamma events to CLOB markets
  events = [];
  for (const ge of gammaEvents) {
    if (ge.markets) {
      for (const gm of ge.markets) {
        if (gm.clobTokenIds && gm.clobTokenIds.length > 0) {
          const tId = getValidTokenId(gm.clobTokenIds);
          if (tId) {
            events.push({
              question: gm.question || ge.title,
              token_id: tId,
              active: true
            });
          }
        }
      }
    }
  }
  
  console.log(`Fetched ${events.length} active events from ClobClient.`);
  
  let rejectedByTitle = 0;
  let rejectedByTokens = 0;
  let rejectedByLiquidity = 0;
  let rejectedByOrderbookFetch = 0;
  let rejectedBySpreadLogic = 0;
  let rejectedBecauseTooTight = 0;
  
  const spreadRejections: any[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let validFound = 0;

  for (const market of events) {
    if (market.active !== true) {
      rejectedByTitle++;
      continue;
    }
    
    const tokenId = getValidTokenId(market.token_id || market.condition_id);
    if (!tokenId) {
      rejectedByTokens++;
      continue;
    }
    
    try {
      await delay(100);
      // 终于找到原因了！！！
      // Polymarket 官方文档的正确 Endpoint 参数不是 ?market=，而是 ?token_id= !!!
      // 所以我们之前用 fetch(`https://clob.polymarket.com/book?market=${tokenId}`) 也是错的！
      // 真正的 URL 是 https://clob.polymarket.com/book?token_id=${tokenId}
      const obResponse = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
      const orderbook = await obResponse.json();
      
      const bestAsk = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].price) : 0;
      const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0;
      const spread = bestAsk - bestBid;
      const minRequiredSpread = config.bot.spreadHalf * 2; // 默认 0.03

      // 这里可能是最重要的：如果市场价格在 0.01 或 0.99，Spread 可能根本不符合条件，
      // 因为我们要求两边都有足够的空间挂单。如果 bid=0.01，ask=0.04，是可以的。
      if (bestAsk <= 0 || bestBid <= 0) {
        rejectedBySpreadLogic++;
        if (rejectedBySpreadLogic < 3) {
          console.log(`[Empty Orderbook] Event: ${market.question} | Token: ${tokenId} - Asks: ${orderbook.asks?.length || 0}, Bids: ${orderbook.bids?.length || 0}`);
        }
        continue;
      }
      
      if (bestAsk <= bestBid) {
        rejectedBySpreadLogic++;
        continue;
      }

      if (spread < minRequiredSpread) {
        rejectedBecauseTooTight++;
        if (spreadRejections.length < 5) {
          spreadRejections.push({
            title: market.question,
            token: tokenId,
            bestBid,
            bestAsk,
            spread: spread.toFixed(4),
            required: minRequiredSpread.toFixed(4)
          });
        }
        continue;
      }
      
      console.log(`\n✅ VALID MARKET FOUND:`);
      console.log(`Event: ${market.question}`);
      console.log(`Token: ${tokenId}`);
      console.log(`Bid: ${bestBid}, Ask: ${bestAsk}, Spread: ${spread.toFixed(4)}`);
      validFound++;
      if (validFound >= 3) break;

    } catch (e: any) {
      rejectedByOrderbookFetch++;
    }
  }

  console.log('\n--- Diagnosis Summary ---');
  console.log(`Total Events: ${events.length}`);
  console.log(`Rejected (Invalid/Closed): ${rejectedByTitle}`);
  console.log(`Rejected (Missing Tokens): ${rejectedByTokens}`);
  console.log(`Rejected (Liquidity not in ${config.bot.minLiquidity}-${config.bot.maxLiquidity}): ${rejectedByLiquidity}`);
  console.log(`Rejected (Orderbook Fetch Error): ${rejectedByOrderbookFetch}`);
  console.log(`Rejected (Empty/Invalid Orderbook): ${rejectedBySpreadLogic}`);
  console.log(`Rejected (Spread too tight < ${config.bot.spreadHalf * 2}): ${rejectedBecauseTooTight}`);
  
  if (spreadRejections.length > 0) {
    console.log('\nSample Spread Rejections (Markets where spread is too small for our bot):');
    console.log(spreadRejections);
  }
}

diagnose();