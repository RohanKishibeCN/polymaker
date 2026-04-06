import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { Headers, Request, Response } from 'node-fetch';
import https from 'https';
import nodeHttp from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

async function main() {
  console.log("==========================================");
  console.log(" Polymarket API Key Generator (L1 Auth)");
  console.log("==========================================");

  const privateKeyStr = process.env.PRIVATE_KEY?.trim();
  if (!privateKeyStr) {
    console.error("[!] Error: PRIVATE_KEY not found in .env");
    return;
  }

  // 1. 设置代理 (接管原生 https 请求以通过 IPRoyal 的鉴权)
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (proxyUrl) {
    console.log(`[+] Using proxy to bypass Geoblock...`);
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    process.env.NO_PROXY = '*';

    // @ts-ignore
    global.fetch = function(url: any, options: any = {}) {
      options.agent = proxyAgent;
      return fetch(url, options);
    };
    // @ts-ignore
    global.Headers = Headers;
    // @ts-ignore
    global.Request = Request;
    // @ts-ignore
    global.Response = Response;

    const originalHttpsRequest = https.request;
    // @ts-ignore
    https.request = function(...args: any[]) {
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        if (typeof args[1] === 'object' && args[1] !== null) {
          args[1].agent = proxyAgent;
        } else {
          args.splice(1, 0, { agent: proxyAgent });
        }
      } else if (args[0] && typeof args[0] === 'object') {
        args[0].agent = proxyAgent;
      }
      // @ts-ignore
      return originalHttpsRequest.apply(this, args);
    };

    const originalHttpRequest = nodeHttp.request;
    // @ts-ignore
    nodeHttp.request = function(...args: any[]) {
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        if (typeof args[1] === 'object' && args[1] !== null) {
          args[1].agent = proxyAgent;
        } else {
          args.splice(1, 0, { agent: proxyAgent });
        }
      } else if (args[0] && typeof args[0] === 'object') {
        args[0].agent = proxyAgent;
      }
      // @ts-ignore
      return originalHttpRequest.apply(this, args);
    };
  }

  try {
    // 2. 初始化只有私钥的无头 ClobClient
    const privateKey = privateKeyStr.startsWith('0x')
      ? privateKeyStr as `0x${string}`
      : `0x${privateKeyStr}` as `0x${string}`;

    const account = privateKeyToAccount(privateKey);
    console.log(`[+] Authenticating with EOA Address: ${account.address}`);

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http('https://polygon-rpc.com'),
    });

    const clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      // @ts-ignore (viem WalletClient is supported but types might clash)
      walletClient,
      undefined,
      2, // SignatureType.POLY_GNOSIS_SAFE
      process.env.POLYMARKET_FUNDER_ADDRESS?.trim()
    );

    // 3. 通过私钥对签名消息 (EIP-712) 派生出一组绝对匹配的 API Credentials
    console.log(`[+] Sending signature to Polymarket to derive API credentials...`);
    const credentials = await clobClient.createOrDeriveApiKey();

    console.log(`\n[SUCCESS] Credentials successfully derived from your private key!\n`);
    console.log(`API_KEY: ${credentials.key}`);
    console.log(`SECRET: ${credentials.secret}`);
    console.log(`PASSPHRASE: ${credentials.passphrase}\n`);

    // 4. 自动写入 .env
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');

      envContent = envContent.replace(/^POLYMARKET_API_KEY=.*$/m, `POLYMARKET_API_KEY="${credentials.key}"`);
      envContent = envContent.replace(/^POLYMARKET_API_SECRET=.*$/m, `POLYMARKET_API_SECRET="${credentials.secret}"`);
      envContent = envContent.replace(/^POLYMARKET_API_PASSPHRASE=.*$/m, `POLYMARKET_API_PASSPHRASE="${credentials.passphrase}"`);

      fs.writeFileSync(envPath, envContent);
      console.log(`[+] Automatically updated .env file with the new credentials.`);
    } else {
      console.log(`[!] .env file not found, please copy the credentials manually.`);
    }
    
    console.log(`[+] You can now run: pm2 restart polymarket-bot --update-env`);

  } catch (error: any) {
    console.error(`\n[!] Failed to generate API Key: ${error.message}`);
    if (error.response) {
      console.error(error.response.data);
    }
  }
}

main();