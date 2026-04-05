import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './src/config';

function getValidTokenId(rawTokenId: any): string | null {
  if (!rawTokenId) return null;

  if (typeof rawTokenId === 'string') {
    if (rawTokenId.match(/^\d{60,}$/)) {
      return rawTokenId;
    }

    if (rawTokenId.startsWith('[')) {
      try {
        if (rawTokenId === '[') return null;
        
        // 兼容单引号 `['123']` 以及正常转义的 JSON `["123"]`
        let validJsonStr = rawTokenId;
        if (rawTokenId.includes("'")) {
          validJsonStr = rawTokenId.replace(/'/g, '"');
        }
        
        const parsedArray = JSON.parse(validJsonStr);
        return Array.isArray(parsedArray) && parsedArray.length > 0 ? String(parsedArray[0]) : null; 
      } catch (error) {
        return null;
      }
    }
    
    return rawTokenId;
  }

  if (Array.isArray(rawTokenId) && rawTokenId.length > 0) {
    return String(rawTokenId[0]);
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

  const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100');
  const gammaData = (await response.json()) as any;
  const gammaEvents = Array.isArray(gammaData) ? gammaData : gammaData.data || [];
  
  let events: any[] = [];
  for (const ge of gammaEvents) {
    if (ge.markets) {
      for (const gm of ge.markets) {
        if (gm.closed === false && gm.active === true) {
          
          // Gamma API 中的 clobTokenIds 有时候全是脏数据 "["，我们优先使用 gm.conditionId
          // 或者解析 tokens 数组 (如果有)
          // 让我们重新看一下刚才打印出来的完整的 market 对象
          // 刚才的日志里有这个字段：
          // "clobTokenIds": "[\"111128191581505463501777127559667396812474366956707382672202929745167742497287\", \"99807503632459517030616292055983105381849115736225256331133222076990620978808\"]"
          // 注意！clobTokenIds 是一个转义过的完整 JSON 字符串！不是数组，也不是残缺的 "["！
          // 我们之前的 `getValidTokenId` 里 `Array.isArray(parsedArray)` 解析出来了，但是我们之前打印的残缺 "[" 是哪来的？
          // 因为有些市场的 `clobTokenIds` 的确是坏数据 `[`，所以我们的 parse 失败了返回 null！
          // 而那些格式完好的 JSON 字符串 `[\"1111...\", ...]` 呢？
          // 我们现在的 parse 逻辑能处理它吗？
          if (gm.clobTokenIds) {
            events.push({
              question: gm.question || ge.title,
              token_id: gm.clobTokenIds,
              active: true
            });
          }
        }
      }
    }
  }
  
  console.log(`Fetched ${events.length} active events.`);
  
  let rejectedByActive = 0;
  let rejectedByTokens = 0;
  let rejectedByOrderbookFetch = 0;
  let rejectedByEmptyBook = 0;
  let rejectedBecauseTooTight = 0;
  let rejectedByExtremeProb = 0;
  let validFound = 0;
  
  const spreadRejections: any[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const market of events) {
    if (market.active !== true && market.active !== "true") {
      rejectedByActive++;
      continue;
    }
    
    const tokenId = getValidTokenId(market.token_id);
    if (!tokenId) {
      if (rejectedByTokens < 5) {
         console.log(`[Debug Token Reject] raw input: ${market.token_id}`);
      }
      rejectedByTokens++;
      continue;
    }
    
    try {
      await delay(50);
      const obResponse = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        }
      });
      const orderbook = (await obResponse.json()) as any;
      
      if (orderbook.error || orderbook.message) {
        rejectedByOrderbookFetch++;
        continue;
      }
      
      const bestAsk = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].price) : 0;
      const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0;
      const spread = bestAsk - bestBid;
      const minRequiredSpread = config.bot.spreadHalf * 2; 

      if (bestAsk <= 0 || bestBid <= 0 || bestAsk <= bestBid) {
        rejectedByEmptyBook++;
        continue;
      }

      // 放宽概率过滤：Polymarket 很多好机会可能在 0.01 到 0.99 之间，我们先试着放宽到 0.01 和 0.99
      if (bestAsk > 0.99 || bestBid < 0.01) {
        rejectedByExtremeProb++;
        continue;
      }

      if (spread < minRequiredSpread) {
        rejectedBecauseTooTight++;
        continue;
      }
      
      validFound++;
    } catch (e: any) {
      rejectedByOrderbookFetch++;
    }
  }

  console.log('\n--- Diagnosis Summary ---');
  console.log(`Total Events: ${events.length}`);
  console.log(`Rejected (Not Active): ${rejectedByActive}`);
  console.log(`Rejected (Missing Tokens): ${rejectedByTokens}`);
  console.log(`Rejected (Orderbook Fetch Error): ${rejectedByOrderbookFetch}`);
  console.log(`Rejected (Empty Book or Invalid Spread): ${rejectedByEmptyBook}`);
  console.log(`Rejected (Extreme Probability <0.05 or >0.95): ${rejectedByExtremeProb}`);
  console.log(`Rejected (Spread < ${config.bot.spreadHalf * 2}): ${rejectedBecauseTooTight}`);
  console.log(`Valid Markets Found: ${validFound}`);
  
  if (spreadRejections.length > 0) {
    console.log('\nSample Spread Rejections (Markets where spread is too small for our bot):');
    console.log(spreadRejections);
  }
}

diagnose();