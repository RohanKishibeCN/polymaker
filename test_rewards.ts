import { config } from './src/config';
import fetch from 'node-fetch';

async function test() {
  const url = `https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&offset=0`;
  const response = await fetch(url);
  const pageMarkets = (await response.json()) as any[];
  
  let validRewards = 0;
  for (const gm of pageMarkets) {
    if (gm.clobRewards && gm.clobRewards.length > 0) validRewards++;
  }
  console.log(`Fetched ${pageMarkets.length} markets. Found ${validRewards} with clobRewards.`);
}
test();
