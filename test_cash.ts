import { getCashBalance } from './src/chain_interaction';

async function test() {
    const cash = await getCashBalance();
    console.log(`Actual cash returned by getCashBalance: ${cash}`);
}
test();