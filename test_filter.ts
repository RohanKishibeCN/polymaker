import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './src/config';

async function testFetch() {
  console.log('Testing fetch and filtering...');
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

  const response = await fetch('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100');
  const data = await response.json();
  
  // Gamma API /markets returns an array directly, but sometimes it might be wrapped.
  // We need to verify what the actual API returns.
  console.log(`Type of data: ${typeof data}, isArray: ${Array.isArray(data)}`);
  if (Array.isArray(data) && data.length > 0) {
    console.log(`First item keys: ${Object.keys(data[0])}`);
    console.log(`First item question: ${data[0].question}`);
    console.log(`First item clobTokenIds: ${data[0].clobTokenIds}`);
  } else if (data.data && Array.isArray(data.data)) {
    console.log(`It is wrapped in .data`);
    console.log(`First item question: ${data.data[0].question}`);
  } else {
     console.log(data);
  }
}

testFetch();