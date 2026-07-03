import { Chain, ClobClient, Side, SignatureTypeV2 } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const privateKey = (process.env.PRIVATE_KEY || '').trim();
  const funderAddress = (process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();
  const apiKey = (process.env.POLYMARKET_API_KEY || '').trim();
  const secret = (process.env.POLYMARKET_API_SECRET || '').trim();
  const passphrase = (process.env.POLYMARKET_API_PASSPHRASE || '').trim();

  console.log('=== Polymarket New Account Test ===');
  console.log(`EOA Signer: ${new Wallet(privateKey).address}`);
  console.log(`Funder (Deposit Wallet): ${funderAddress}`);

  const wallet = new Wallet(privateKey);

  const clobClient: any = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: Chain.POLYGON,
    signer: wallet,
    creds: { key: apiKey, secret, passphrase },
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress,
  });

  proxyAgent && clobClient.axiosInstance && (clobClient.axiosInstance.defaults.httpsAgent = proxyAgent);

  // Step 1: derive API key
  console.log('\n[1] Deriving API credentials...');
  try {
    const deriveClient: any = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: Chain.POLYGON,
      signer: wallet,
    });
    proxyAgent && deriveClient.axiosInstance && (deriveClient.axiosInstance.defaults.httpsAgent = proxyAgent);
    const creds = await deriveClient.createOrDeriveApiKey();
    console.log(`   API Key: ${creds.key}`);
    console.log(`   Secret: ${creds.secret}`);
    console.log(`   Passphrase: ${creds.passphrase}`);
  } catch (e: any) {
    console.log(`   Derive failed: ${e.message}`);
  }

  // Step 2: Test post a minimal SELL order
  console.log('\n[2] Testing order placement...');
  const testTokenId = '53831553061883006530739877284105938919721408776239639687877978808906551086026';
  try {
    const res = await clobClient.createAndPostOrder(
      { tokenID: testTokenId, price: 0.50, size: 5, side: Side.SELL },
      { tickSize: '0.01', negRisk: false },
      'GTC'
    );
    console.log(`   Order Result:`, JSON.stringify(res, null, 2));
    if (res && res.orderID) {
      console.log('   ✅ SIGNATURE SUCCESS! Order placed.');
      // cancel it immediately
      try {
        await clobClient.cancelOrder(res.orderID);
        console.log('   ✅ Order cancelled.');
      } catch (e: any) {
        console.log(`   ⚠️ Cancel failed (may be ok): ${e.message}`);
      }
    } else {
      console.log('   ❌ Order failed:', res?.error || res?.message || 'Unknown');
    }
  } catch (e: any) {
    console.log(`   ❌ Order error: ${e.message}`);
  }

  // Step 3: Test BUY order on neg-risk market
  console.log('\n[3] Testing order on neg-risk market...');
  const negRiskTokenId = '28517366085749905119520362582979931306860182143397970907500918159304286947744';
  try {
    const res = await clobClient.createAndPostOrder(
      { tokenID: negRiskTokenId, price: 0.50, size: 5, side: Side.SELL },
      { tickSize: '0.01', negRisk: true },
      'GTC'
    );
    console.log(`   Order Result:`, JSON.stringify(res, null, 2));
    if (res && res.orderID) {
      console.log('   ✅ NEG-RISK SUCCESS!');
      try {
        await clobClient.cancelOrder(res.orderID);
        console.log('   ✅ Order cancelled.');
      } catch (e: any) {
        console.log(`   ⚠️ Cancel failed: ${e.message}`);
      }
    } else {
      console.log('   ❌ Neg-risk order failed:', res?.error || res?.message || 'Unknown');
    }
  } catch (e: any) {
    console.log(`   ❌ Neg-risk error: ${e.message}`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
