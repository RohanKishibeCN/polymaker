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

  const marketsResponse = await clobClient.getSamplingMarkets();
  let events = (marketsResponse as any).data || marketsResponse || [];
  if (!Array.isArray(events)) {
    const response = await fetch('https://clob.polymarket.com/sampling-markets');
    const data = (await response.json()) as any;
    events = data.markets || data.data || data || [];
  }
  
  console.log(`Fetched ${events.length} active events.`);
  
  let rejectedByActive = 0;
  let rejectedByTokens = 0;
  let rejectedByOrderbookFetch = 0;
  let rejectedByEmptyBook = 0;
  let rejectedBecauseTooTight = 0;
  
  const spreadRejections: any[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let validFound = 0;

  for (const market of events) {
    if (market.active !== true && market.active !== "true") {
      rejectedByActive++;
      continue;
    }
    
    const tokenId = getValidTokenId(market.token_id || market.condition_id);
    if (!tokenId) {
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
  console.log(`Rejected (Spread < ${config.bot.spreadHalf * 2}): ${rejectedBecauseTooTight}`);
  console.log(`Valid Markets Found: ${validFound}`);
  
  if (spreadRejections.length > 0) {
    console.log('\nSample Spread Rejections (Markets where spread is too small for our bot):');
    console.log(spreadRejections);
  }
}

diagnose();