import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './src/config';

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

  const response = await fetch('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200');
  const markets = (await response.json()) as any[];
  
  console.log(`Fetched ${markets.length} active markets.`);
  
  let rejectedByTitle = 0;
  let rejectedByTokens = 0;
  let rejectedByLiquidity = 0;
  let rejectedByOrderbookFetch = 0;
  let rejectedBySpreadLogic = 0;
  
  const spreadRejections: any[] = [];

  // 增加重试和延迟机制，有时候 Polymarket API 会限流或返回空订单簿
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const market of markets) {
    if (market.groupItemTitle === 'Invalid' || market.closed === true) {
      rejectedByTitle++;
      continue;
    }
    
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
      rejectedByTokens++;
      continue;
    }

    const apiLiquidity = parseFloat(market.liquidity) || 0;
    if (apiLiquidity < config.bot.minLiquidity || apiLiquidity > config.bot.maxLiquidity) {
      rejectedByLiquidity++;
      continue;
    }

    const yesTokenId = market.clobTokenIds[0];
    
    try {
      // 加一点延迟避免被 WAF 拦截
      await delay(100);
      const orderbook = await clobClient.getOrderBook(yesTokenId);
      
      const bestAsk = orderbook.asks && orderbook.asks.length > 0 ? parseFloat(orderbook.asks[0].price) : 0;
      const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0;
      const spread = bestAsk - bestBid;
      const minRequiredSpread = config.bot.spreadHalf * 2;

      if (!(bestAsk > 0 && bestBid > 0 && bestAsk > bestBid && spread >= minRequiredSpread)) {
        rejectedBySpreadLogic++;
        if (spreadRejections.length < 5) {
          spreadRejections.push({
            title: market.question,
            bestBid,
            bestAsk,
            spread: spread.toFixed(4),
            required: minRequiredSpread.toFixed(4)
          });
        }
        continue;
      }
      
      console.log(`\n✅ VALID MARKET FOUND:`);
      console.log(`Title: ${market.question}`);
      console.log(`Liquidity: ${apiLiquidity}`);
      console.log(`Bid: ${bestBid}, Ask: ${bestAsk}, Spread: ${spread.toFixed(4)}`);

    } catch (e: any) {
      rejectedByOrderbookFetch++;
    }
  }

  console.log('\n--- Diagnosis Summary ---');
  console.log(`Total Markets: ${markets.length}`);
  console.log(`Rejected (Invalid/Closed): ${rejectedByTitle}`);
  console.log(`Rejected (Missing Tokens): ${rejectedByTokens}`);
  console.log(`Rejected (Liquidity not in ${config.bot.minLiquidity}-${config.bot.maxLiquidity}): ${rejectedByLiquidity}`);
  console.log(`Rejected (Orderbook Fetch Error): ${rejectedByOrderbookFetch}`);
  console.log(`Rejected (Spread < ${config.bot.spreadHalf * 2} or missing orders): ${rejectedBySpreadLogic}`);
  
  if (spreadRejections.length > 0) {
    console.log('\nSample Spread Rejections:');
    console.log(spreadRejections);
  }
}

diagnose();