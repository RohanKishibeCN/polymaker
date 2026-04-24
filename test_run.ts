import { config } from './src/config';
import { runMarketMakingCycle } from './src/market_maker';

async function test() {
    await runMarketMakingCycle();
}
test();