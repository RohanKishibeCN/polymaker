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
    const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&limit=50');
    const events = (await response.json()) as any[];
    
    let opportunitiesFound = 0;

    for (const event of events) {
      if (!event.markets || event.markets.length < 2) continue;
      
      let sumOfYesAsks = 0;
      const yesTokens: any[] = [];
      let valid = true;

      for (const market of event.markets) {
        if (market.closed) { valid = false; break; }
        
        const clobTokenId = market.clobTokenIds?.[0]; // YES token ID
        if (!clobTokenId) { valid = false; break; }
        
        const orderbook = await clobClient.getOrderBook(clobTokenId);
        
        if (orderbook.asks && orderbook.asks.length > 0) {
          const bestAskPrice = parseFloat(orderbook.asks[0].price);
          sumOfYesAsks += bestAskPrice;
          yesTokens.push({
            tokenId: clobTokenId,
            price: bestAskPrice,
            size: parseFloat(orderbook.asks[0].size)
          });
        } else {
          valid = false;
          break;
        }
      }

      if (!valid) continue;

      const targetSum = 1.0 - config.bot.profitThreshold;
      
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
